/**
 * Shared helpers for the stack-backed acceptance tests. These talk to the REAL
 * local Supabase stack (and, for HTTP tests, the real Next.js dev server).
 * Nothing here imports app server modules (they import `server-only`).
 *
 * Skipping: `stackUp` / `webUp` are probed once at module load (top-level
 * await). Test files use `describe.skipIf(!stackUp)` / `describe.skipIf(!webUp)`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Environment: explicit process.env wins over apps/web/.env.local.
// ---------------------------------------------------------------------------

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function loadEnvLocal(): Record<string, string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "apps/web/.env.local"),
    path.resolve(here, "../../../.env.local"),
  ];
  for (const file of candidates) if (existsSync(file)) return parseEnvFile(file);
  return {};
}

const fileEnv = loadEnvLocal();
const pick = (name: string): string => process.env[name] || fileEnv[name] || "";

export const SUPABASE_URL = pick("NEXT_PUBLIC_SUPABASE_URL");
export const ANON_KEY = pick("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const SERVICE_KEY = pick("SUPABASE_SERVICE_ROLE_KEY");
export const BASE_URL = (process.env.CUE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function probe(url: string, init: RequestInit = {}, ms = 2500): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

async function probeStack(): Promise<{ up: boolean; why: string }> {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return { up: false, why: "Supabase env (URL / anon key / service-role key) not found" };
  }
  const health = await probe(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: ANON_KEY } });
  if (!health || !health.ok) return { up: false, why: `Supabase API not reachable at ${SUPABASE_URL}` };
  const rest = await probe(`${SUPABASE_URL}/rest/v1/matches?select=id&limit=1`, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!rest || !rest.ok) return { up: false, why: "Supabase is up but the SocialEyes schema is not applied" };
  return { up: true, why: "" };
}

const stack = await probeStack();
export const stackUp = stack.up;

let webWhy = "";
async function probeWeb(): Promise<boolean> {
  if (!stackUp) {
    webWhy = "Supabase stack is down";
    return false;
  }
  const res = await probe(`${BASE_URL}/api/profile`, {}, 8000);
  if (!res) {
    webWhy = `web server not reachable at ${BASE_URL}`;
    return false;
  }
  if (res.status !== 401) {
    webWhy = `web server at ${BASE_URL} answered ${res.status} (expected 401) for unauthenticated GET /api/profile`;
    return false;
  }
  return true;
}
export const webUp = await probeWeb();

/** Prints one line about what this file skips and why (nothing when everything runs). */
export function reportSkips(file: string, needsWeb: boolean): void {
  if (!stackUp) {
    console.log(`[stack-tests] ${file}: SKIPPED - ${stack.why}`);
  } else if (needsWeb && !webUp) {
    console.log(`[stack-tests] ${file}: SKIPPED - ${webWhy}`);
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Service-role client. Test setup, assertions on DB state, and SQL function calls. */
export const admin: SupabaseClient = createClient(
  SUPABASE_URL || "http://127.0.0.1:1",
  SERVICE_KEY || "missing",
  noPersist,
);

/** Anon-key client, optionally signed in as `user`. This is what a browser holds. */
export async function anonClient(user?: TestUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL || "http://127.0.0.1:1", ANON_KEY || "missing", noPersist);
  if (user) {
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
  }
  return client;
}

/** Throws on a PostgREST error and returns the rows. */
export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`${res.error.code ?? ""} ${res.error.message}`);
  return res.data as T;
}

// ---------------------------------------------------------------------------
// Throwaway users
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

const createdUsers: string[] = [];
const uploadedObjects: string[] = [];
const createdVenues: string[] = [];

export interface CreateUserOptions {
  /** Insert a `profiles` row (default true). */
  profile?: boolean;
  displayName?: string;
}

export async function createUser(opts: CreateUserOptions = {}): Promise<TestUser> {
  const email = `t-${randomBytes(8).toString("hex")}@example.com`;
  const password = `pw-${randomBytes(12).toString("hex")}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  createdUsers.push(data.user.id);
  if (opts.profile !== false) {
    must(
      await admin
        .from("profiles")
        .insert({ user_id: data.user.id, display_name: opts.displayName ?? `Tester ${email.slice(2, 8)}` }),
    );
  }
  return { id: data.user.id, email, password };
}

export async function createUsers(n: number, opts: CreateUserOptions = {}): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: n }, () => createUser(opts)));
}

/** Track a venue created through the API for removal in cleanup (after its users are gone). */
export function trackVenue(venueId: string): void {
  createdVenues.push(venueId);
}

/** Track a storage object (bucket `avatars`) for removal in cleanup. */
export function trackAvatar(objectPath: string): void {
  uploadedObjects.push(objectPath);
}

/** Deleting an auth user cascades every SocialEyes row that references it. */
export async function cleanupUsers(): Promise<void> {
  if (!stackUp) return;
  if (uploadedObjects.length) {
    await admin.storage.from("avatars").remove(uploadedObjects.splice(0));
  }
  const ids = createdUsers.splice(0);
  // Sequential with retries: parallel deletes of users who share matches can deadlock on the cascades.
  for (const id of ids) {
    let lastError = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error) {
        lastError = "";
        break;
      }
      lastError = error.message;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    if (lastError) console.warn(`[stack-tests] could not delete throwaway user ${id}: ${lastError}`);
  }
  const venues = createdVenues.splice(0);
  if (venues.length) await admin.from("venues").delete().in("id", venues);
}

// ---------------------------------------------------------------------------
// SQL function wrappers (service role)
// ---------------------------------------------------------------------------

export type Source = "web_demo" | "mentra_touch" | "headset_remote";
export const GESTURE: Record<Source, "web_confirm" | "backward_swipe" | "media_next_track"> = {
  web_demo: "web_confirm",
  mentra_touch: "backward_swipe",
  headset_remote: "media_next_track",
};

export interface Ack {
  status: "accepted" | "duplicate" | "rejected";
  received_at: string;
  expires_at: string | null;
  matched: boolean;
  match_id: string | null;
  reason: string | null;
}

export interface SignalOptions {
  eventId?: string;
  source?: Source;
  /** Override the default gesture for the source (used to test invalid or alternate pairs). */
  gesture?: string;
}

/** SQL `submit_signal`: the place comes from the user's presence, never from the call. */
export async function signal(user: TestUser | string, opts: SignalOptions = {}): Promise<Ack> {
  const source = opts.source ?? "web_demo";
  const res = await admin.rpc("submit_signal", {
    p_user_id: typeof user === "string" ? user : user.id,
    p_event_id: opts.eventId ?? randomUUID(),
    p_source: source,
    p_gesture: opts.gesture ?? GESTURE[source],
    p_occurred_at: new Date().toISOString(),
  });
  return must(res) as Ack;
}

// ---------------------------------------------------------------------------
// Presence: encounter mode, venues, phone locations (service role)
// ---------------------------------------------------------------------------

export interface Venue {
  id: string;
  name: string;
  code: string;
}

function venueCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += alphabet[randomBytes(1)[0] % alphabet.length];
  return c;
}

/** A fresh venue created by (and checking in) `owner`. */
export async function createVenue(owner: TestUser, name?: string): Promise<Venue> {
  const venueName = name ?? `Test Venue ${randomBytes(4).toString("hex")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = venueCode();
    const res = await admin.rpc("create_venue", { p_user_id: owner.id, p_name: venueName, p_code: code });
    if (res.error?.code === "23505") continue;
    const id = must(res) as string;
    createdVenues.push(id);
    return { id, name: venueName, code };
  }
  throw new Error("could not allocate a test venue code");
}

export async function checkIn(user: TestUser, venue: Venue): Promise<void> {
  const res = must(await admin.rpc("check_in_venue", { p_user_id: user.id, p_code: venue.code }));
  if (res !== "checked_in") throw new Error(`check-in failed: ${JSON.stringify(res)}`);
}

export async function setMode(user: TestUser, enabled: boolean): Promise<void> {
  must(await admin.rpc("set_presence_mode", { p_user_id: user.id, p_enabled: enabled }));
}

export interface Spot {
  lat: number;
  lng: number;
}

/**
 * A synthetic spot: a random small offset around latitude 0, longitude 0
 * (open sea; never a real place). Random so concurrent test files and leftover
 * rows never share a neighbourhood.
 */
export function freshSpot(): Spot {
  const r = () => (Math.random() - 0.5) * 0.9;
  return { lat: r(), lng: r() };
}

/** Metres per degree of latitude for the radius SQL `distance_m` uses. */
export const M_PER_DEG_LAT = (2 * Math.PI * 6371008.8) / 360;

/** `spot` moved `northM` metres north (exact along a meridian). */
export function north(spot: Spot, northM: number): Spot {
  return { lat: spot.lat + northM / M_PER_DEG_LAT, lng: spot.lng };
}

/** SQL `report_location`: false (and nothing stored) when encounter mode is off. */
export async function locate(user: TestUser, spot: Spot, accuracyM = 5): Promise<boolean> {
  return must(
    await admin.rpc("report_location", { p_user_id: user.id, p_lat: spot.lat, p_lng: spot.lng, p_accuracy_m: accuracyM }),
  ) as boolean;
}

export interface PresenceRow {
  user_id: string;
  encounter_mode: boolean;
  venue_id: string | null;
  checked_in_at: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  located_at: string | null;
}

export async function presenceOf(user: TestUser): Promise<PresenceRow | null> {
  return must(await admin.from("user_presence").select("*").eq("user_id", user.id).maybeSingle()) as PresenceRow | null;
}

/** Shift a user's stored location / check-in into the past. */
export async function backdatePresence(user: TestUser, fields: { locatedAgoS?: number; checkedInAgoS?: number }): Promise<void> {
  const patch: Record<string, string> = {};
  if (fields.locatedAgoS !== undefined) patch.located_at = new Date(Date.now() - fields.locatedAgoS * 1000).toISOString();
  if (fields.checkedInAgoS !== undefined) patch.checked_in_at = new Date(Date.now() - fields.checkedInAgoS * 1000).toISOString();
  must(await admin.from("user_presence").update(patch).eq("user_id", user.id));
}

export interface Pair {
  venue: Venue;
  a: TestUser;
  b: TestUser;
}

/**
 * `a` and `b` checked into one fresh venue (leaving any other), encounter mode
 * on for both unless `mode` is false. Neither has a phone location.
 */
export async function openVenue(a: TestUser, b: TestUser, mode = true): Promise<Pair> {
  const venue = await createVenue(a);
  await checkIn(b, venue);
  for (const u of [a, b]) await setMode(u, mode);
  return { venue, a, b };
}

/** Two new users checked into a fresh venue. */
export async function newPair(mode = true): Promise<Pair> {
  const [a, b] = await createUsers(2);
  return openVenue(a, b, mode);
}

// ---------------------------------------------------------------------------
// DB state helpers (service role)
// ---------------------------------------------------------------------------

export interface MatchRow {
  id: string;
  session_id: string | null;
  venue_id: string | null;
  user_a: string;
  user_b: string;
  first_signal_at: string;
  venue_label: string;
  venue_label_source: "manual" | "venue_checkin" | "phone_location";
  status: "active" | "ended";
  ended_by: string | null;
  ended_reason: string | null;
}

export interface EventRow {
  id: string;
  event_id: string;
  user_id: string;
  session_id: string | null;
  source: string;
  gesture: string;
  received_at: string;
  expires_at: string;
  status: "pending" | "consumed" | "expired" | "cancelled";
  resolved_at: string | null;
  match_id: string | null;
}

/** Every match (any status) involving `user`, oldest first. */
export async function matchesOf(user: TestUser | string): Promise<MatchRow[]> {
  const id = typeof user === "string" ? user : user.id;
  return must(
    await admin.from("matches").select("*").or(`user_a.eq.${id},user_b.eq.${id}`).order("created_at"),
  ) as MatchRow[];
}

/** Every match (any status) between exactly these two people, oldest first. */
export async function matchesBetween(a: TestUser, b: TestUser): Promise<MatchRow[]> {
  const [lo, hi] = [a.id, b.id].sort();
  return must(
    await admin.from("matches").select("*").eq("user_a", lo).eq("user_b", hi).order("created_at"),
  ) as MatchRow[];
}

export async function eventsOf(userId: string): Promise<EventRow[]> {
  return must(await admin.from("interest_events").select("*").eq("user_id", userId).order("received_at")) as EventRow[];
}

export async function eventById(eventId: string, userId: string): Promise<EventRow | null> {
  const rows = must(
    await admin.from("interest_events").select("*").eq("user_id", userId).eq("event_id", eventId),
  ) as EventRow[];
  return rows[0] ?? null;
}

/** Make a pending signal look like it was received `ageSeconds` ago (so it is past its 15 s window). */
export async function backdate(rowId: string, ageSeconds = 30): Promise<void> {
  const received = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const expires = new Date(Date.now() - (ageSeconds - 15) * 1000).toISOString();
  must(await admin.from("interest_events").update({ received_at: received, expires_at: expires }).eq("id", rowId));
}

/** Ack without the timestamps, for "identical apart from timestamps" comparisons. */
export function withoutTimes(ack: Ack): Omit<Ack, "received_at" | "expires_at"> & { hasExpiry: boolean } {
  const { received_at: _r, expires_at, ...rest } = ack;
  void _r;
  return { ...rest, hasExpiry: expires_at !== null };
}

// ---------------------------------------------------------------------------
// HTTP: cookie sessions exactly like the app uses, and a tiny fetch wrapper
// ---------------------------------------------------------------------------

/** Sign in through @supabase/ssr with an in-memory cookie jar; returns the Cookie header value. */
export async function cookieFor(user: TestUser): Promise<string> {
  const jar = new Map<string, string>();
  const supabase = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (toSet) => {
        for (const { name, value } of toSet) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`cookie sign-in failed: ${error.message}`);
  if (jar.size === 0) throw new Error("no auth cookies were issued");
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export interface Reply {
  status: number;
  json: unknown;
  text: string;
}

export interface Creds {
  cookie?: string;
  bearer?: string;
  /** Extra request headers, e.g. a distinct x-forwarded-for so rate limits keyed on the client do not collide across runs. */
  headers?: Record<string, string>;
}

/** A fresh client address for rate-limit keys (the server keys claims on x-forwarded-for). */
export function freshClient(): Creds {
  const n = () => 1 + Math.floor(Math.random() * 253);
  return { headers: { "x-forwarded-for": `198.51.${n()}.${n()}` } };
}

export async function api(method: string, route: string, creds: Creds = {}, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { ...creds.headers };
  if (creds.cookie) headers.cookie = creds.cookie;
  if (creds.bearer !== undefined) headers.authorization = `Bearer ${creds.bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

export function interestBody(source: Source = "web_demo", extra: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    source,
    gesture: GESTURE[source],
    occurredAt: new Date().toISOString(),
    ...extra,
  };
}
