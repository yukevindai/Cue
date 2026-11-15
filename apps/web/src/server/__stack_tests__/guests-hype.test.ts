/**
 * Guest accounts and the spoken wingman line, over HTTP against the running
 * web server (CUE_BASE_URL, default http://localhost:3000) and the real local
 * Supabase stack. Skipped unless both are reachable.
 *
 * Not covered here: CUE_GUESTS_ENABLED=off (the dev server's env cannot be
 * changed from a test; the gate is unit-tested in guest-config.test.ts) and
 * the 300-per-day cap (would need 300 accounts).
 */
import { GUEST_RATE_LIMIT } from "../guest-config";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  DEFAULT_SHARING,
  DeviceClaimResult,
  DeviceContext,
  EncounterStatus,
  GUEST_EMAIL_DOMAIN,
  GuestDeviceResult,
  GuestHandoff,
  GuestResult,
  HypeLine,
  InterestAck,
  MatchList,
  OwnProfile,
  PairingCode,
  routes,
} from "@cue/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  api,
  BASE_URL,
  cleanupUsers,
  cookieFor,
  createUser,
  freshClient,
  interestBody,
  matchesBetween,
  must,
  openVenue,
  reportSkips,
  signal,
  stackUp,
  trackVenue,
  webUp,
  type Reply,
  type TestUser,
} from "./helpers";

reportSkips("guests-hype.test.ts", true);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function ok<S extends { parse(x: unknown): unknown }>(res: Reply, schema: S, status = 200) {
  expect(res.status, res.text).toBe(status);
  return schema.parse(res.json) as ReturnType<S["parse"]>;
}

function err(res: Reply, status: number, code?: string) {
  expect(res.status, res.text).toBe(status);
  const parsed = ApiError.parse(res.json);
  if (code) expect(parsed.error.code).toBe(code);
  return parsed;
}

// ---------------------------------------------------------------- guest bookkeeping

const startedAt = Date.now() - 5_000;
const guestNames = new Set<string>();
const guestIds = new Set<string>();

/** A unique, letters-only name the intro parser keeps as is. */
function uniqueName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let tail = "";
  for (let i = 0; i < 8; i++) tail += letters[Math.floor(Math.random() * letters.length)];
  const name = `Tess ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
  guestNames.add(name);
  return name;
}

/**
 * Deletes every guest this file created: the ids it learned, plus any guest
 * account made since the file started whose profile carries one of its names
 * (covers a test that failed before it learned the id).
 */
async function cleanupGuests(): Promise<void> {
  if (!stackUp) return;
  const ids = new Set(guestIds);
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    const recent = data.users.filter(
      (u) => u.email?.endsWith(`@${GUEST_EMAIL_DOMAIN}`) && Date.parse(u.created_at) >= startedAt,
    );
    if (recent.length) {
      const rows = must(
        await admin.from("profiles").select("user_id, display_name").in("user_id", recent.map((u) => u.id)),
      ) as { user_id: string; display_name: string }[];
      for (const r of rows) if (guestNames.has(r.display_name)) ids.add(r.user_id);
    }
    if (data.users.length < 1000) break;
  }
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && error.status !== 404) console.warn(`[stack-tests] could not delete guest ${id}: ${error.message}`);
    guestIds.delete(id);
  }
}

// ---------------------------------------------------------------- raw HTTP with cookies

/** Cookie header built from a response's Set-Cookie headers (deleted cookies dropped). */
function cookiesFrom(res: Response): string {
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (value && !expired) jar.set(name, value);
  }
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

async function raw(method: string, route: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

interface WebGuest {
  id: string;
  cookie: string;
  name: string;
}

async function webGuest(): Promise<WebGuest> {
  const name = uniqueName();
  const res = await raw("POST", routes.guest, { body: { intro: `Hi, my name is ${name}` }, headers: freshClient().headers });
  const text = await res.text();
  expect(res.status, text).toBe(201);
  expect(GuestResult.parse(JSON.parse(text))).toEqual({ displayName: name });
  const cookie = cookiesFrom(res);
  expect(cookie).not.toBe("");
  const profile = ok(await api("GET", routes.profile, { cookie }), OwnProfile);
  guestIds.add(profile.userId);
  return { id: profile.userId, cookie, name };
}

async function deviceGuest(): Promise<{ id: string; token: string; name: string }> {
  const name = uniqueName();
  const result = ok(
    await api("POST", routes.guestDevice, freshClient(), { intro: `um hey, I'm ${name}`, deviceLabel: "Test glasses" }),
    GuestDeviceResult,
    201,
  );
  expect(result.displayName).toBe(name);
  const row = must(
    await admin.from("device_associations").select("user_id").eq("id", result.deviceId).single(),
  ) as { user_id: string };
  guestIds.add(row.user_id);
  return { id: row.user_id, token: result.deviceToken, name };
}

/** A normal (non-guest) user with a linked device, through the real pairing routes. */
async function pairedUser(): Promise<{ user: TestUser; cookie: string; token: string }> {
  const user = await createUser();
  const cookie = await cookieFor(user);
  const code = ok(await api("POST", routes.devicePair, { cookie }), PairingCode);
  const claim = ok(await api("POST", routes.deviceClaim, freshClient(), { code: code.code }), DeviceClaimResult);
  return { user, cookie, token: claim.deviceToken };
}

/** Matches two users at a fresh venue through the SQL functions. Returns the match id. */
async function matchUsers(a: TestUser | string, b: TestUser | string): Promise<string> {
  const asUser = (u: TestUser | string): TestUser => (typeof u === "string" ? { id: u, email: "", password: "" } : u);
  await openVenue(asUser(a), asUser(b));
  await signal(asUser(a));
  const ack = await signal(asUser(b));
  expect(ack.matched).toBe(true);
  return ack.match_id!;
}

// ---------------------------------------------------------------- tests

describe.skipIf(!stackUp || !webUp)("guest accounts (real web server + real stack)", () => {
  afterAll(async () => {
    await cleanupGuests();
    await cleanupUsers();
  });

  it("creates a signed-in, name-only guest with default sharing, who can do everything a member can", async () => {
    const guest = await webGuest();
    const profile = ok(await api("GET", routes.profile, { cookie: guest.cookie }), OwnProfile);
    expect(profile).toMatchObject({
      displayName: guest.name,
      isGuest: true,
      bio: "",
      interests: [],
      photoUrl: null,
      age: null,
      cards: [],
      archetype: null,
      sharing: DEFAULT_SHARING,
    });
    const profileText = JSON.stringify(profile);
    expect(profileText).not.toContain(GUEST_EMAIL_DOMAIN);
    expect(profileText).not.toContain("@");

    // Same abilities: host a venue, encounter mode, signal, match.
    const member = await createUser();
    const memberCookie = await cookieFor(member);
    const venue = ok(await api("POST", routes.venues, { cookie: guest.cookie }, { name: "Guest test venue" }), EncounterStatus);
    trackVenue(venue.checkIn!.venueId);
    ok(await api("POST", routes.venueCheckIn, { cookie: memberCookie }, { code: venue.checkIn!.code }), EncounterStatus);
    for (const cookie of [guest.cookie, memberCookie]) {
      expect(ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus)).toMatchObject({
        encounterMode: true,
        ready: true,
      });
    }
    expect(ok(await api("POST", routes.interest, { cookie: guest.cookie }, interestBody()), InterestAck).status).toBe("accepted");
    expect(ok(await api("POST", routes.interest, { cookie: memberCookie }, interestBody()), InterestAck).matched).toBe(true);
    const list = ok(await api("GET", routes.matches, { cookie: guest.cookie }), MatchList).matches;
    expect(list).toHaveLength(1);
    expect(list[0].other.userId).toBe(member.id);
    expect(await matchesBetween({ id: guest.id, email: "", password: "" }, member)).toHaveLength(1);

    // A member's own profile says isGuest false.
    const memberProfile = ok(await api("GET", routes.profile, { cookie: memberCookie }), OwnProfile);
    expect(memberProfile.isGuest).toBe(false);
  });

  it("rejects an intro without a name (400) and never creates an account for it", async () => {
    for (const intro of ["hello", "um hi", "my name is", "1234"]) {
      err(await api("POST", routes.guest, freshClient(), { intro }), 400, "invalid_request");
    }
    err(await api("POST", routes.guest, freshClient(), { intro: "" }), 400, "invalid_request");
    err(await api("POST", routes.guest, freshClient(), { intro: "Sam", extra: 1 }), 400, "invalid_request");
  });

  it("limits each guest route per address (429)", async () => {
    for (const route of [routes.guest, routes.guestDevice]) {
      const client = freshClient();
      for (let i = 0; i < GUEST_RATE_LIMIT.limit; i++) {
        err(await api("POST", route, client, { intro: "hello" }), 400, "invalid_request");
      }
      err(await api("POST", route, client, { intro: "hello" }), 429, "rate_limited");
      // A different address is not affected.
      err(await api("POST", route, freshClient(), { intro: "hello" }), 400, "invalid_request");
    }
  });

  it("guest device route: needs a real introduction and returns a working device token", async () => {
    err(await api("POST", routes.guestDevice, freshClient(), { intro: "Sam" }), 400, "invalid_request");
    err(await api("POST", routes.guestDevice, freshClient(), { intro: "hey there" }), 400, "invalid_request");

    const guest = await deviceGuest();
    const ctx = ok(await api("GET", routes.deviceMe, { bearer: guest.token }), DeviceContext);
    expect(ctx).toMatchObject({ encounterMode: false, ready: false, latestMatchId: null });
    // No cookies: the device route never signs a browser in, and a device token is no session.
    err(await api("GET", routes.profile, { bearer: guest.token }), 401, "unauthenticated");
    const prof = must(await admin.from("profiles").select("display_name, bio, interests").eq("user_id", guest.id).single());
    expect(prof).toEqual({ display_name: guest.name, bio: "", interests: [] });
  });

  it("handoff: 401 without a token, 403 for a member's device, one-time sign-in for a guest", async () => {
    err(await api("POST", routes.guestHandoff, freshClient()), 401, "unauthenticated");
    const member = await pairedUser();
    err(await api("POST", routes.guestHandoff, { ...freshClient(), bearer: member.token }), 403, "forbidden");

    const guest = await deviceGuest();
    const handoff = ok(await api("POST", routes.guestHandoff, { ...freshClient(), bearer: guest.token }), GuestHandoff);
    expect(handoff.path).toMatch(/^\/g\/[A-Za-z0-9_-]+$/);
    const ttl = Date.parse(handoff.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(3500_000);
    expect(ttl).toBeLessThanOrEqual(3600_000);

    // A fresh cookie jar opens the link and is signed in as the guest.
    const first = await raw("GET", handoff.path);
    expect(first.status).toBe(307);
    expect(new URL(first.headers.get("location")!, BASE_URL).pathname).toBe("/encounter");
    const cookie = cookiesFrom(first);
    expect(cookie).not.toBe("");
    const profile = ok(await api("GET", routes.profile, { cookie }), OwnProfile);
    expect(profile).toMatchObject({ userId: guest.id, displayName: guest.name, isGuest: true });

    // Single use.
    const second = await raw("GET", handoff.path);
    expect(second.status).toBe(307);
    expect(new URL(second.headers.get("location")!, BASE_URL).pathname).toBe("/sign-in");
    expect(cookiesFrom(second)).toBe("");

    // Garbage goes to sign-in too, with no detail.
    const bad = await raw("GET", "/g/not-a-real-token-at-all");
    expect(new URL(bad.headers.get("location")!, BASE_URL).pathname).toBe("/sign-in");
  });

  it("latestMatchId: the newest active match under 5 minutes old, else null", async () => {
    const guest = await deviceGuest();
    const other = await createUser();
    const matchId = await matchUsers(guest.id, other);
    expect(ok(await api("GET", routes.deviceMe, { bearer: guest.token }), DeviceContext).latestMatchId).toBe(matchId);

    must(
      await admin
        .from("matches")
        .update({ created_at: new Date(Date.now() - 6 * 60_000).toISOString() })
        .eq("id", matchId),
    );
    expect(ok(await api("GET", routes.deviceMe, { bearer: guest.token }), DeviceContext).latestMatchId).toBeNull();

    // A fresh match that has ended is not announced either.
    const third = await createUser();
    const ended = await matchUsers(guest.id, third);
    expect(ok(await api("GET", routes.deviceMe, { bearer: guest.token }), DeviceContext).latestMatchId).toBe(ended);
    must(await admin.rpc("end_match", { p_match_id: ended, p_user_id: guest.id, p_reason: "unmatch" }));
    expect(ok(await api("GET", routes.deviceMe, { bearer: guest.token }), DeviceContext).latestMatchId).toBeNull();
  });
});

describe.skipIf(!stackUp || !webUp)("hype routes (real web server + real stack)", () => {
  afterAll(async () => {
    await cleanupGuests();
    await cleanupUsers();
  });

  it("auth: 401 without credentials, 404 for non-participants and unknown matches", async () => {
    const id = randomUUID();
    err(await api("POST", routes.hype(id)), 401, "unauthenticated");
    err(await api("POST", routes.deviceHype, {}, { matchId: id }), 401, "unauthenticated");
    // A session cookie is not a device token, and a device token is not a session.
    const wearer = await pairedUser();
    err(await api("POST", routes.deviceHype, { cookie: wearer.cookie }, { matchId: id }), 401, "unauthenticated");
    err(await api("POST", routes.hype(id), { bearer: wearer.token }), 401, "unauthenticated");

    err(await api("POST", routes.hype(id), { cookie: wearer.cookie }), 404, "not_found");
    err(await api("POST", routes.hype("not-a-uuid"), { cookie: wearer.cookie }), 404, "not_found");
    err(await api("POST", routes.deviceHype, { bearer: wearer.token }, { matchId: id }), 404, "not_found");
    err(await api("POST", routes.deviceHype, { bearer: wearer.token }, { matchId: "nope" }), 400, "invalid_request");

    // A real match between two other people.
    const [a, b] = [await createUser(), await createUser()];
    const matchId = await matchUsers(a, b);
    err(await api("POST", routes.hype(matchId), { cookie: wearer.cookie }), 404, "not_found");
    err(await api("POST", routes.deviceHype, { bearer: wearer.token }, { matchId }), 404, "not_found");
  });

  it("participants get a HypeLine on both routes; an ended match is 404", async () => {
    const wearer = await pairedUser();
    const other = await createUser({ displayName: "Quinn Hype" });
    const matchId = await matchUsers(wearer.user, other);

    const web = ok(await api("POST", routes.hype(matchId), { cookie: wearer.cookie }), HypeLine);
    expect(web.matchId).toBe(matchId);
    // No ANTHROPIC_API_KEY on the local dev server: the fixed line is used.
    if (web.source === "fallback") expect(web.text).toContain("Quinn Hype");
    expect(web.text).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
    const device = ok(await api("POST", routes.deviceHype, { bearer: wearer.token }, { matchId }), HypeLine);
    expect(device).toEqual(web); // cached per (match, viewer)

    // The other person gets their own line, about the wearer.
    const otherCookie = await cookieFor(other);
    const theirs = ok(await api("POST", routes.hype(matchId), { cookie: otherCookie }), HypeLine);
    expect(theirs.matchId).toBe(matchId);

    ok(await api("POST", routes.unmatch(matchId), { cookie: otherCookie }), { parse: (x: unknown) => x }, 204);
    err(await api("POST", routes.hype(matchId), { cookie: wearer.cookie }), 404, "not_found");
    err(await api("POST", routes.deviceHype, { bearer: wearer.token }, { matchId }), 404, "not_found");
  });
});
