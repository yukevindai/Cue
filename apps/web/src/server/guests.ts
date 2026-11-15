import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import {
  GUEST_EMAIL_DOMAIN,
  guestHandoffPath,
  isGuestEmail,
  parseIntroName,
  ProfileInput,
  type GuestDeviceInput,
  type GuestDeviceResult,
  type GuestHandoff,
  type GuestResult,
} from "@cue/contracts";
import { getServerSupabase } from "@/lib/supabase/server";
import { linkDeviceForUser, type DeviceAuth } from "@/server/devices";
import { GUEST_DAILY_CAP, GUEST_RATE_LIMIT, guestsEnabled, HANDOFF_TTL_SECONDS } from "@/server/guest-config";
import { HttpError } from "@/server/http";
import { saveOwnProfile } from "@/server/profiles";
import { rateLimit } from "@/server/rate-limit";
import { getAdminSupabase } from "@/server/supabase-admin";

/**
 * Demo-only guest accounts (see `@cue/contracts` guest.ts). A guest is an
 * ordinary Supabase account with a synthetic address and a random password
 * that is never returned, stored or logged. Names, emails, tokens and
 * passwords are never logged.
 */

/** 404 for every guest route when the switch is off, so the feature looks absent. */
export function requireGuestsEnabled(): void {
  if (!guestsEnabled()) throw new HttpError("not_found", "Not found");
}

/** First x-forwarded-for entry, as `devices/claim` keys its limit. */
export function clientAddress(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function guestRateLimit(route: "guest" | "guest-device" | "guest-handoff", address: string): void {
  rateLimit(`${route}:${address}`, GUEST_RATE_LIMIT.limit, GUEST_RATE_LIMIT.windowMs);
}

function nameFrom(intro: string, requireLeadIn: boolean): string {
  const name = parseIntroName(intro, { requireLeadIn });
  if (name === null) {
    throw new HttpError(
      "invalid_request",
      requireLeadIn
        ? "Say your name to start, for example “Hi, my name is Sam”."
        : "Tell us your name to start, for example “I'm Sam” or just “Sam”.",
    );
  }
  return name;
}

/**
 * Guests created in the last 24 hours, from the Auth admin user list (fine at
 * demo scale; no table of our own). Pages until a page is short.
 */
async function guestsCreatedSince(since: number): Promise<number> {
  const perPage = 1000;
  let count = 0;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await getAdminSupabase().auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`auth list users failed: ${error.status ?? ""}`);
    for (const user of data.users) {
      if (isGuestEmail(user.email) && Date.parse(user.created_at) >= since) count += 1;
    }
    if (data.users.length < perPage) break;
  }
  return count;
}

async function enforceDailyCap(): Promise<void> {
  if ((await guestsCreatedSince(Date.now() - 24 * 60 * 60_000)) >= GUEST_DAILY_CAP) {
    throw new HttpError("rate_limited", "Guest sign-ups are full for today. Try again later.");
  }
}

interface NewGuest {
  userId: string;
  email: string;
  password: string;
  displayName: string;
}

/** Deletes a half-made guest. Failure is logged by id only. */
async function discard(userId: string): Promise<void> {
  const { error } = await getAdminSupabase().auth.admin.deleteUser(userId);
  if (error) console.error(`guest cleanup failed for ${userId}: ${error.status ?? ""}`);
}

/**
 * Creates the auth user and a profile with only the name (every other field
 * and every sharing toggle at the defaults a new profile gets), then runs
 * `finish`. Anything failing after the user exists deletes the user again.
 */
async function createGuest<T>(displayName: string, finish: (guest: NewGuest) => Promise<T>): Promise<T> {
  await enforceDailyCap();
  const email = `guest-${randomUUID()}@${GUEST_EMAIL_DOMAIN}`;
  const password = randomBytes(32).toString("base64url");
  const { data, error } = await getAdminSupabase().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`guest create failed: ${error?.status ?? "no user"}`);
  const userId = data.user.id;
  try {
    const input = ProfileInput.parse({ displayName, photoUrl: null, bio: "", interests: [], sharing: {} });
    await saveOwnProfile(userId, input, email);
    return await finish({ userId, email, password, displayName });
  } catch (err) {
    await discard(userId);
    throw err;
  }
}

/** POST /api/guest: create a guest and sign this browser in (session cookies on the response). */
export async function createWebGuest(intro: string): Promise<GuestResult> {
  const displayName = nameFrom(intro, false);
  return createGuest(displayName, async (guest) => {
    const supabase = await getServerSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email: guest.email, password: guest.password });
    if (error) throw new Error(`guest sign-in failed: ${error.status ?? ""}`);
    return { displayName: guest.displayName };
  });
}

/** POST /api/guest/device: create a guest from the glasses and link them. No cookies. */
export async function createDeviceGuest(input: GuestDeviceInput): Promise<GuestDeviceResult> {
  const displayName = nameFrom(input.intro, true);
  return createGuest(displayName, async (guest) => {
    const link = await linkDeviceForUser(guest.userId, {
      deviceLabel: input.deviceLabel,
      mentraUserId: input.mentraUserId ?? null,
    });
    return { displayName: guest.displayName, deviceId: link.deviceId, deviceToken: link.deviceToken };
  });
}

/**
 * POST /api/guest/handoff: a one-time sign-in link for the guest the glasses
 * belong to. Supabase's magic-link token: single use, and a newer link
 * replaces an older unused one.
 */
export async function createHandoff(device: DeviceAuth): Promise<GuestHandoff> {
  const admin = getAdminSupabase();
  const { data: found, error: findError } = await admin.auth.admin.getUserById(device.userId);
  if (findError || !found.user) throw new Error(`guest lookup failed: ${findError?.status ?? "no user"}`);
  const email = found.user.email;
  if (!email || !isGuestEmail(email)) throw new HttpError("forbidden", "Only guest accounts can hand off to a phone");

  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) throw new Error(`handoff link failed: ${error?.status ?? "no token"}`);
  return {
    path: guestHandoffPath(tokenHash),
    expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000).toISOString(),
  };
}

/** GET /g/[token]: signs the browser in with a handoff token. False on any failure. */
export async function redeemHandoff(tokenHash: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash)) return false;
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error || !data.user || !isGuestEmail(data.user.email)) {
    if (!error && data.user) await supabase.auth.signOut({ scope: "local" });
    return false;
  }
  return true;
}
