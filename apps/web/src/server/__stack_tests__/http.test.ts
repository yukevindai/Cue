/**
 * HTTP-level acceptance tests against the running web server (CUE_BASE_URL,
 * default http://localhost:3000) and the real local Supabase stack. Skipped
 * unless both are reachable. Every success body is parsed with its contract
 * schema; every error body with ApiError.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  DeviceClaimResult,
  DeviceContext,
  EncounterStatus,
  InterestAck,
  MatchCard,
  MatchList,
  OwnProfile,
  PairingCode,
  routes,
  type ProfileInput,
} from "@cue/contracts";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  anonClient,
  api,
  cleanupUsers,
  cookieFor,
  createUser,
  eventsOf,
  freshClient,
  freshSpot,
  interestBody,
  matchesBetween,
  matchesOf,
  must,
  newPair,
  north,
  presenceOf,
  reportSkips,
  stackUp,
  trackVenue,
  webUp,
  type Reply,
} from "./helpers";

reportSkips("http.test.ts", true);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

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

/** A PUT /api/profile body (input shape: omitted optional fields take their defaults). */
type ProfileBody = z.input<typeof ProfileInput>;

const profileInput = (over: Partial<ProfileBody> = {}): ProfileBody => ({
  displayName: "Tester",
  photoUrl: "https://example.com/p.png",
  bio: "I like coffee",
  interests: ["coffee", "hiking"],
  sharing: { photo: true, bio: true, interests: true, aiAssist: true },
  ...over,
});

/** The new optional SharedProfile fields of a profile that filled none of them. */
const EMPTY_EXTRAS = {
  age: null,
  gender: null,
  genderSelfDescribed: null,
  location: null,
  lookingFor: null,
  workOrSchool: null,
  education: null,
  mbti: null,
  ethnicity: null,
  drinking: null,
  smoking: null,
  drugs: null,
  cards: [],
  archetype: null,
};

describe.skipIf(!stackUp || !webUp)("HTTP API (real web server + real stack)", () => {
  afterAll(cleanupUsers);

  // -------------------------------------------------------------------------
  describe("unauthenticated requests", () => {
    const id = randomUUID();
    const cases: [string, string, unknown?][] = [
      ["GET", routes.profile],
      ["PUT", routes.profile, profileInput()],
      ["GET", routes.encounter],
      ["POST", routes.encounterMode, { enabled: true }],
      ["POST", routes.encounterLocation, { lat: 0.001, lng: 0.001, accuracyM: 5 }],
      ["DELETE", routes.encounterLocation],
      ["POST", routes.venues, { name: "x" }],
      ["POST", routes.venueCheckIn, { code: "ABCDEF" }],
      ["POST", routes.venueCheckOut],
      ["POST", routes.demoReset, {}],
      ["POST", routes.interest, interestBody()],
      ["GET", routes.matches],
      ["GET", routes.match(id)],
      ["POST", routes.unmatch(id)],
      ["POST", routes.blocks, { userId: id }],
      ["POST", routes.devicePair],
      ["DELETE", routes.deviceUnlink],
      ["GET", routes.deviceMe],
    ];
    it.each(cases)("%s %s -> 401 unauthenticated", async (method, route, body) => {
      err(await api(method, route, {}, body), 401, "unauthenticated");
    });

    it("a garbage cookie is not a session", async () => {
      err(await api("GET", routes.matches, { cookie: "sb-127-auth-token=garbage" }), 401, "unauthenticated");
    });
  });

  // -------------------------------------------------------------------------
  describe("profile", () => {
    it("version increments on a content change and on a sharing-only change, not on an identical PUT", async () => {
      const u = await createUser({ profile: false });
      const cookie = await cookieFor(u);
      err(await api("GET", routes.profile, { cookie }), 404, "not_found");

      const base = profileInput();
      const first = ok(await api("PUT", routes.profile, { cookie }, base), OwnProfile);
      expect(first.userId).toBe(u.id);
      const v1 = first.version;

      const same = ok(await api("PUT", routes.profile, { cookie }, base), OwnProfile);
      expect(same.version).toBe(v1);
      expect(same.updatedAt).toBe(first.updatedAt);

      const bioChanged = ok(await api("PUT", routes.profile, { cookie }, { ...base, bio: "Now I like tea" }), OwnProfile);
      expect(bioChanged.version).toBe(v1 + 1);

      const sharingOnly = ok(
        await api("PUT", routes.profile, { cookie }, { ...base, bio: "Now I like tea", sharing: { ...base.sharing, bio: false } }),
        OwnProfile,
      );
      expect(sharingOnly.version).toBe(v1 + 2);

      const identicalAgain = ok(
        await api("PUT", routes.profile, { cookie }, { ...base, bio: "Now I like tea", sharing: { ...base.sharing, bio: false } }),
        OwnProfile,
      );
      expect(identicalAgain.version).toBe(v1 + 2);

      const got = ok(await api("GET", routes.profile, { cookie }), OwnProfile);
      expect(got).toEqual(identicalAgain);

      // The user id is never taken from the body.
      const spoof = await api("PUT", routes.profile, { cookie }, { ...base, userId: randomUUID() });
      expect([200, 400]).toContain(spoof.status);
      const rows = must(await admin.from("profiles").select("user_id").eq("user_id", u.id)) as unknown[];
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("two users: session, interest, matches", () => {
    it("full web flow creates one match; GET /api/matches honours sharing flags; a third user sees nothing", async () => {
      const [a, b, c] = await Promise.all([createUser({ profile: false }), createUser({ profile: false }), createUser({ profile: false })]);
      const [ca, cb, cc] = await Promise.all([cookieFor(a), cookieFor(b), cookieFor(c)]);

      // Profiles: A shares photo, bio and interests; B hides bio and photo but shares interests.
      const pa = profileInput({
        displayName: "Alice Test",
        bio: "Alice bio",
        sharing: { photo: true, bio: true, interests: true, aiAssist: true },
      });
      const pb = profileInput({
        displayName: "Bob Test",
        bio: "Bob secret bio",
        interests: ["chess"],
        sharing: { photo: false, bio: false, interests: true, aiAssist: false },
      });
      ok(await api("PUT", routes.profile, { cookie: ca }, pa), OwnProfile);
      ok(await api("PUT", routes.profile, { cookie: cb }, pb), OwnProfile);

      // Venue: A creates it (and is checked in); B checks in with the code (case-insensitive).
      const venue = `HTTP Venue ${randomUUID().slice(0, 6)}`;
      const created = ok(await api("POST", routes.venues, { cookie: ca }, { name: venue }), EncounterStatus);
      expect(created.checkIn).not.toBeNull();
      expect(created.checkIn!.name).toBe(venue);
      trackVenue(created.checkIn!.venueId);
      expect(created.checkIn!.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      expect(new Date(created.checkIn!.expiresAt).getTime() - new Date(created.checkIn!.checkedInAt).getTime()).toBe(8 * 3600_000);
      expect(created).toMatchObject({ encounterMode: false, ready: false, pendingSignal: null });
      const joined = ok(
        await api("POST", routes.venueCheckIn, { cookie: cb }, { code: created.checkIn!.code.toLowerCase() }),
        EncounterStatus,
      );
      expect(joined.checkIn!.venueId).toBe(created.checkIn!.venueId);

      // Interest with encounter mode still off is rejected (HTTP 200 ack).
      const early = ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      expect(early).toMatchObject({ status: "rejected", reason: "encounter_mode_off", matched: false });

      for (const cookie of [ca, cb]) {
        const st = ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);
        expect(st).toMatchObject({ encounterMode: true, ready: true });
      }

      // A signals first: accepted, not matched; B's own view shows no incoming interest.
      const ackA = ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      expect(ackA).toMatchObject({ status: "accepted", matched: false, reason: null });
      expect(ackA.expiresAt).not.toBeNull();
      const bStatus = ok(await api("GET", routes.encounter, { cookie: cb }), EncounterStatus);
      expect(bStatus.pendingSignal).toBeNull();
      const aStatus = ok(await api("GET", routes.encounter, { cookie: ca }), EncounterStatus);
      expect(aStatus.pendingSignal?.source).toBe("web_demo");
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
      expect(await matchesOf(a)).toHaveLength(0);

      // B signals: matched true on the second only.
      const ackB = ok(await api("POST", routes.interest, { cookie: cb }, interestBody()), InterestAck);
      expect(ackB).toMatchObject({ status: "accepted", matched: true, expiresAt: null });
      const dbMatches = await matchesBetween(a, b);
      expect(dbMatches).toHaveLength(1);
      expect(new Date(dbMatches[0].first_signal_at).getTime()).toBe(new Date(ackA.receivedAt).getTime());
      expect((await eventsOf(a.id)).filter((e) => e.status === "consumed")).toHaveLength(1);

      // Matches: each sees the OTHER person, honouring their sharing flags.
      const listA = ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches;
      const listB = ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches;
      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA[0].id).toBe(dbMatches[0].id);
      expect(listA[0].venueLabel).toBe(venue);
      expect(listA[0].venueLabelSource).toBe("venue_checkin");
      expect(new Date(listA[0].encounterAt).getTime()).toBe(new Date(ackA.receivedAt).getTime());

      expect(listA[0].other).toEqual({
        userId: b.id,
        displayName: "Bob Test",
        photoUrl: null, // B: photo sharing off
        bio: null, // B: bio sharing off
        interests: ["chess"],
        ...EMPTY_EXTRAS,
      });
      expect(JSON.stringify(listA)).not.toContain("Bob secret bio");
      expect(listB[0].other).toEqual({
        userId: a.id,
        displayName: "Alice Test",
        photoUrl: "https://example.com/p.png",
        bio: "Alice bio",
        interests: ["coffee", "hiking"],
        ...EMPTY_EXTRAS,
      });
      const card = ok(await api("GET", routes.match(dbMatches[0].id), { cookie: ca }), MatchCard);
      expect(card).toEqual(listA[0]);

      // Third user, not in the venue: nothing visible; cannot touch the match; signals do not match.
      expect(ok(await api("GET", routes.matches, { cookie: cc }), MatchList).matches).toEqual([]);
      err(await api("GET", routes.match(dbMatches[0].id), { cookie: cc }), 404, "not_found");
      err(await api("POST", routes.unmatch(dbMatches[0].id), { cookie: cc }), 404, "not_found");
      err(await api("GET", routes.match("not-a-uuid"), { cookie: cc }), 404, "not_found");
      expect((await matchesBetween(a, b))[0].status).toBe("active");
      const third = ok(await api("POST", routes.interest, { cookie: cc }, interestBody()), InterestAck);
      expect(third).toMatchObject({ status: "rejected", reason: "encounter_mode_off", matched: false });
      ok(await api("POST", routes.encounterMode, { cookie: cc }, { enabled: true }), EncounterStatus);
      const thirdNoPlace = ok(await api("POST", routes.interest, { cookie: cc }, interestBody()), InterestAck);
      expect(thirdNoPlace).toMatchObject({ status: "rejected", reason: "no_place", matched: false });
      expect(await eventsOf(c.id)).toHaveLength(0);

      // Unmatch by a participant removes access for both.
      const un = await api("POST", routes.unmatch(dbMatches[0].id), { cookie: cb });
      expect(un.status).toBe(204);
      expect(ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches).toEqual([]);
      err(await api("GET", routes.match(dbMatches[0].id), { cookie: ca }), 404, "not_found");
      expect((await matchesBetween(a, b))[0]).toMatchObject({ status: "ended", ended_reason: "unmatch", ended_by: b.id });
      // Second unmatch: not found.
      err(await api("POST", routes.unmatch(dbMatches[0].id), { cookie: ca }), 404, "not_found");
    });

    it("no route accepts a client-supplied user id: extra userId in the interest body is a 400 and writes nothing", async () => {
      const p = await newPair();
      const cookie = await cookieFor(p.a);
      const other = p.b.id;
      for (const spoof of [p.b.id, randomUUID()]) {
        err(await api("POST", routes.interest, { cookie }, interestBody("web_demo", { userId: spoof })), 400, "invalid_request");
      }
      err(await api("POST", routes.interest, { cookie }, interestBody("web_demo", { user_id: other })), 400, "invalid_request");
      // Nor a place: the old session id or a venue id in the body is refused too.
      err(await api("POST", routes.interest, { cookie }, interestBody("web_demo", { encounterSessionId: randomUUID() })), 400, "invalid_request");
      err(await api("POST", routes.interest, { cookie }, interestBody("web_demo", { venueId: p.venue.id })), 400, "invalid_request");
      expect(await eventsOf(p.a.id)).toHaveLength(0);
      expect(await eventsOf(p.b.id)).toHaveLength(0);
      // Wrong gesture for the source is also invalid.
      err(await api("POST", routes.interest, { cookie }, { ...interestBody(), gesture: "backward_swipe" }), 400, "invalid_request");
    });

    it("blocking over HTTP ends the match; later signals of either person are ordinary pending ones that never match", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      for (const [cookie, who] of [[ca, p.a], [cb, p.b]] as const) {
        ok(await api("PUT", routes.profile, { cookie }, profileInput({ displayName: `Blk ${who.id.slice(0, 4)}` })), OwnProfile);
      }
      ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      const m = ok(await api("POST", routes.interest, { cookie: cb }, interestBody()), InterestAck);
      expect(m.matched).toBe(true);
      expect((await api("POST", routes.blocks, { cookie: ca }, { userId: p.b.id })).status).toBe(204);
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
      expect((await matchesBetween(p.a, p.b))[0]).toMatchObject({ status: "ended", ended_reason: "block" });
      const after = ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      expect(after).toMatchObject({ status: "accepted", matched: false, reason: null });
      const blockedAck = ok(await api("POST", routes.interest, { cookie: cb }, interestBody()), InterestAck);
      expect(blockedAck).toMatchObject({ status: "accepted", matched: false, reason: null });
      expect(Object.keys(blockedAck).sort()).toEqual(Object.keys(after).sort());
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);
      err(await api("POST", routes.blocks, { cookie: ca }, { userId: p.a.id }), 400, "invalid_request");
    });
  });

  // -------------------------------------------------------------------------
  describe("presence: phone location, venues, reset", () => {
    it("two phones close together match as Nearby; the status never contains coordinates", async () => {
      const [a, b] = await Promise.all([createUser(), createUser()]);
      const [ca, cb] = await Promise.all([cookieFor(a), cookieFor(b)]);
      const spot = freshSpot();
      const near = north(spot, 20);
      for (const cookie of [ca, cb]) ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);

      const resA = await api("POST", routes.encounterLocation, { cookie: ca }, { lat: spot.lat, lng: spot.lng, accuracyM: 6 });
      const stA = ok(resA, EncounterStatus);
      expect(stA).toMatchObject({ encounterMode: true, ready: true, checkIn: null, location: { status: "fresh", accuracyM: 6 } });
      expect(stA.location.locatedAt).not.toBeNull();
      const resB = await api("POST", routes.encounterLocation, { cookie: cb }, { lat: near.lat, lng: near.lng, accuracyM: 6 });
      ok(resB, EncounterStatus);
      const resGet = await api("GET", routes.encounter, { cookie: ca });
      ok(resGet, EncounterStatus);
      for (const res of [resA, resB, resGet]) {
        expect(res.text).not.toMatch(/"lat"|"lng"|latitude|longitude/);
        for (const v of [spot.lat, spot.lng, near.lat, near.lng]) expect(res.text).not.toContain(String(v).slice(0, 8));
      }

      ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      const ack = ok(await api("POST", routes.interest, { cookie: cb }, interestBody("headset_remote")), InterestAck);
      expect(ack.matched).toBe(true);
      const [card] = ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches;
      expect(card).toMatchObject({ venueLabel: "Nearby", venueLabelSource: "phone_location" });
      expect(JSON.stringify(card)).not.toMatch(/"lat"|"lng"/);

      // DELETE forgets the location: no place any more.
      const cleared = ok(await api("DELETE", routes.encounterLocation, { cookie: ca }), EncounterStatus);
      expect(cleared).toMatchObject({ ready: false, location: { status: "none", accuracyM: null, locatedAt: null } });
      expect(await presenceOf(a)).toMatchObject({ lat: null, lng: null });
    });

    it("a location reported with encounter mode off is not stored and the status comes back unchanged (200)", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      const spot = freshSpot();
      const before = ok(await api("GET", routes.encounter, { cookie }), EncounterStatus);
      const after = ok(await api("POST", routes.encounterLocation, { cookie }, { lat: spot.lat, lng: spot.lng, accuracyM: 5 }), EncounterStatus);
      expect({ ...after, serverTime: null }).toEqual({ ...before, serverTime: null });
      expect(after).toMatchObject({ encounterMode: false, ready: false, location: { status: "none" } });
      expect((await presenceOf(u))?.lat ?? null).toBeNull();

      // Turning mode off later also forgets a stored location.
      ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);
      ok(await api("POST", routes.encounterLocation, { cookie }, { lat: spot.lat, lng: spot.lng, accuracyM: 5 }), EncounterStatus);
      expect((await presenceOf(u))?.lat).not.toBeNull();
      const off = ok(await api("POST", routes.encounterMode, { cookie }, { enabled: false }), EncounterStatus);
      expect(off).toMatchObject({ encounterMode: false, ready: false, location: { status: "none" } });
      expect(await presenceOf(u)).toMatchObject({ lat: null, lng: null, accuracy_m: null, located_at: null });
    });

    it("an inaccurate location is stored as inaccurate and is not ready", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);
      const spot = freshSpot();
      const st = ok(await api("POST", routes.encounterLocation, { cookie }, { lat: spot.lat, lng: spot.lng, accuracyM: 250 }), EncounterStatus);
      expect(st).toMatchObject({ ready: false, location: { status: "inaccurate", accuracyM: 250 } });
      const ack = ok(await api("POST", routes.interest, { cookie }, interestBody()), InterestAck);
      expect(ack).toMatchObject({ status: "rejected", reason: "no_place" });
    });

    it("bad location and venue bodies are 400 invalid_request", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      for (const body of [
        { lat: 91, lng: 0, accuracyM: 5 },
        { lat: 0, lng: 181, accuracyM: 5 },
        { lat: 0, lng: 0, accuracyM: -1 },
        { lat: 0, lng: 0 },
        { lat: 0.001, lng: 0.001, accuracyM: 5, userId: randomUUID() },
      ]) {
        err(await api("POST", routes.encounterLocation, { cookie }, body), 400, "invalid_request");
      }
      for (const body of [{}, { name: "" }, { name: "x".repeat(81) }]) {
        err(await api("POST", routes.venues, { cookie }, body), 400, "invalid_request");
      }
      for (const body of [{}, { code: "ABC" }, { code: "ABC-12" }]) {
        err(await api("POST", routes.venueCheckIn, { cookie }, body), 400, "invalid_request");
      }
      expect(await presenceOf(u)).toBeNull();
    });

    it("check-in with an unknown code is 404 not_found; repeated attempts are rate limited (429)", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await api("POST", routes.venueCheckIn, { cookie }, { code: "ZZZZZ" + "23456789ABCDEFGHJK"[i] });
        statuses.push(res.status);
        if (res.status === 404) err(res, 404, "not_found");
        if (res.status === 429) err(res, 429, "rate_limited");
      }
      expect(statuses.slice(0, 10).every((x) => x === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect(await presenceOf(u)).toBeNull();
    });

    it("location reports allow bursts but are rate limited past 30 a minute", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);
      const spot = freshSpot();
      const statuses = await Promise.all(
        Array.from({ length: 32 }, () => api("POST", routes.encounterLocation, { cookie }, { lat: spot.lat, lng: spot.lng, accuracyM: 5 })),
      ).then((rs) => rs.map((r) => r.status));
      expect(statuses.filter((x) => x === 200)).toHaveLength(30);
      expect(statuses.filter((x) => x === 429)).toHaveLength(2);
    });

    it("check-out clears the check-in and cancels a pending signal; demo reset ends matches; leave turns everything off", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck);
      const out = ok(await api("POST", routes.venueCheckOut, { cookie: ca }), EncounterStatus);
      expect(out).toMatchObject({ checkIn: null, ready: false, pendingSignal: null, encounterMode: true });
      expect((await eventsOf(p.a.id))[0].status).toBe("cancelled");
      expect(ok(await api("POST", routes.interest, { cookie: cb }, interestBody()), InterestAck).matched).toBe(false);

      // Back in: matches B's pending signal.
      ok(await api("POST", routes.venueCheckIn, { cookie: ca }, { code: p.venue.code }), EncounterStatus);
      expect(ok(await api("POST", routes.interest, { cookie: ca }, interestBody()), InterestAck).matched).toBe(true);
      expect(ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches).toHaveLength(1);

      // Reset with an empty body (no leave): matches end, presence stays.
      const reset = await api("POST", routes.demoReset, { cookie: cb });
      const afterReset = ok(reset, EncounterStatus);
      expect(afterReset).toMatchObject({ encounterMode: true, ready: true });
      expect(afterReset.checkIn?.venueId).toBe(p.venue.id);
      expect(ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches).toEqual([]);
      expect((await matchesBetween(p.a, p.b))[0]).toMatchObject({ status: "ended", ended_reason: "reset" });

      const left = ok(await api("POST", routes.demoReset, { cookie: cb }, { leave: true }), EncounterStatus);
      expect(left).toMatchObject({ encounterMode: false, ready: false, checkIn: null, location: { status: "none" } });
      err(await api("POST", routes.demoReset, { cookie: cb }, { leave: "yes" }), 400, "invalid_request");
    });

    it("creating a venue checks the creator in and leaves any previous venue", async () => {
      const u = await createUser();
      const cookie = await cookieFor(u);
      const first = ok(await api("POST", routes.venues, { cookie }, { name: "  First Hall  " }), EncounterStatus);
      expect(first.checkIn?.name).toBe("First Hall");
      const second = ok(await api("POST", routes.venues, { cookie }, { name: "Second Hall" }), EncounterStatus);
      expect(second.checkIn?.name).toBe("Second Hall");
      expect(second.checkIn?.venueId).not.toBe(first.checkIn?.venueId);
      expect(second.checkIn?.code).not.toBe(first.checkIn?.code);
      trackVenue(first.checkIn!.venueId);
      trackVenue(second.checkIn!.venueId);
    });
  });

  // -------------------------------------------------------------------------
  describe("headset_remote (web session only)", () => {
    it("cookie + headset_remote/media_next_track is accepted; one-sided signal is invisible to the other person", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const ack = ok(await api("POST", routes.interest, { cookie: ca }, interestBody("headset_remote")), InterestAck);
      expect(ack).toMatchObject({ status: "accepted", matched: false, reason: null });
      const [row] = await eventsOf(p.a.id);
      expect(row).toMatchObject({ source: "headset_remote", gesture: "media_next_track", status: "pending" });
      const bStatus = ok(await api("GET", routes.encounter, { cookie: cb }), EncounterStatus);
      expect(bStatus.pendingSignal).toBeNull();
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
      const aStatus = ok(await api("GET", routes.encounter, { cookie: ca }), EncounterStatus);
      expect(aStatus.pendingSignal?.source).toBe("headset_remote");
    });

    it("a device bearer token cannot send headset_remote (403) and nothing is written", async () => {
      const p = await newPair();
      const ca = await cookieFor(p.a);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: ca }), PairingCode);
      const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);
      err(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("headset_remote")), 403, "forbidden");
      expect(await eventsOf(p.a.id)).toHaveLength(0);
    });

    it("headset_remote with a gesture from another source is a 400 (contract refine) and writes nothing", async () => {
      const p = await newPair();
      const ca = await cookieFor(p.a);
      for (const gesture of ["web_confirm", "backward_swipe"]) {
        err(await api("POST", routes.interest, { cookie: ca }, interestBody("headset_remote", { gesture })), 400, "invalid_request");
      }
      err(await api("POST", routes.interest, { cookie: ca }, interestBody("web_demo", { gesture: "media_next_track" })), 400, "invalid_request");
      expect(await eventsOf(p.a.id)).toHaveLength(0);
    });

    it("a Mentra device swipe plus the other person's headset_remote creates one match", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: ca }), PairingCode);
      const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);
      ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("mentra_touch")), InterestAck);
      const ack = ok(await api("POST", routes.interest, { cookie: cb }, interestBody("headset_remote")), InterestAck);
      expect(ack.matched).toBe(true);
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("spectacles_hand (device token only)", () => {
    it("a Spectacles device token sends double_pinch; one-sided signal is invisible to the other person", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: ca }), PairingCode);
      const { deviceToken } = ok(
        await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code, deviceLabel: "Snap Spectacles" }),
        DeviceClaimResult,
      );
      const ack = ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("spectacles_hand")), InterestAck);
      expect(ack).toMatchObject({ status: "accepted", matched: false, reason: null });
      const [row] = await eventsOf(p.a.id);
      expect(row).toMatchObject({ source: "spectacles_hand", gesture: "double_pinch", status: "pending" });
      expect(ok(await api("GET", routes.encounter, { cookie: cb }), EncounterStatus).pendingSignal).toBeNull();
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
    });

    it("a web session cannot send spectacles_hand (403) and nothing is written", async () => {
      const p = await newPair();
      const ca = await cookieFor(p.a);
      err(await api("POST", routes.interest, { cookie: ca }, interestBody("spectacles_hand")), 403, "forbidden");
      expect(await eventsOf(p.a.id)).toHaveLength(0);
    });

    it("a Spectacles double pinch plus the other person's Mentra swipe creates one match", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const claim = async (cookie: string, deviceLabel: string) => {
        const pairing = ok(await api("POST", routes.devicePair, { cookie }), PairingCode);
        return ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code, deviceLabel }), DeviceClaimResult).deviceToken;
      };
      const [specs, mentra] = [await claim(ca, "Snap Spectacles"), await claim(cb, "Mentra Live")];
      ok(await api("POST", routes.interest, { bearer: specs }, interestBody("spectacles_hand")), InterestAck);
      const ack = ok(await api("POST", routes.interest, { bearer: mentra }, interestBody("mentra_touch")), InterestAck);
      expect(ack.matched).toBe(true);
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("device pairing and device-token auth", () => {
    let a: Awaited<ReturnType<typeof newPair>>["a"];
    let b: Awaited<ReturnType<typeof newPair>>["b"];
    let ca: string;
    let cb: string;
    let token: string;
    let deviceId: string;

    beforeAll(async () => {
      const p = await newPair();
      ({ a, b } = p);
      [ca, cb] = await Promise.all([cookieFor(a), cookieFor(b)]);
    });

    it("pair -> claim returns a token; the code is single use; a wrong code fails", async () => {
      const pairing = ok(await api("POST", routes.devicePair, { cookie: ca }), PairingCode);
      const claimed = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code, deviceLabel: "Test Glasses" }), DeviceClaimResult);
      token = claimed.deviceToken;
      deviceId = claimed.deviceId;

      // Only hashes are stored.
      const row = must(await admin.from("device_associations").select("*").eq("id", deviceId).single()) as Record<string, unknown>;
      expect(row.token_hash).toBe(sha256(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row).toMatchObject({ user_id: a.id, pairing_code_hash: null, revoked_at: null, device_label: "Test Glasses" });

      const replay = await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code });
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(replay.status).toBeLessThan(500);
      err(replay, replay.status);

      const wrong = pairing.code === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ";
      const bad = await api("POST", routes.deviceClaim, freshClient(), { code: wrong });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).toBeLessThan(500);
      err(bad, bad.status);

      // The first token is unaffected by the failed claims.
      ok(await api("GET", routes.deviceMe, { bearer: token }), DeviceContext);
    });

    it("GET /api/devices/me with the bearer returns the DeviceContext", async () => {
      const ctx = ok(await api("GET", routes.deviceMe, { bearer: token }), DeviceContext);
      expect(ctx).toMatchObject({ deviceId, encounterMode: true, ready: true });
      expect(Object.keys(ctx).sort()).toEqual(["deviceId", "encounterMode", "ready", "serverTime"]);
      // Cookies alone are not device auth.
      err(await api("GET", routes.deviceMe, { cookie: ca }), 401, "unauthenticated");
    });

    it("a device-token signal uses the wearer's presence: not ready -> rejected, ready -> accepted", async () => {
      const w = await createUser();
      const cw = await cookieFor(w);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: cw }), PairingCode);
      const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);

      expect(ok(await api("GET", routes.deviceMe, { bearer: deviceToken }), DeviceContext)).toMatchObject({ encounterMode: false, ready: false });
      const off = ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("mentra_touch")), InterestAck);
      expect(off).toMatchObject({ status: "rejected", reason: "encounter_mode_off" });

      ok(await api("POST", routes.encounterMode, { cookie: cw }, { enabled: true }), EncounterStatus);
      expect(ok(await api("GET", routes.deviceMe, { bearer: deviceToken }), DeviceContext)).toMatchObject({ encounterMode: true, ready: false });
      const noPlace = ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("mentra_touch")), InterestAck);
      expect(noPlace).toMatchObject({ status: "rejected", reason: "no_place" });
      expect(await eventsOf(w.id)).toHaveLength(0);

      const spot = freshSpot();
      ok(await api("POST", routes.encounterLocation, { cookie: cw }, { lat: spot.lat, lng: spot.lng, accuracyM: 10 }), EncounterStatus);
      const ready = ok(await api("GET", routes.deviceMe, { bearer: deviceToken }), DeviceContext);
      expect(ready).toMatchObject({ encounterMode: true, ready: true });
      expect(JSON.stringify(ready)).not.toMatch(/lat|lng/);
      const accepted = ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("mentra_touch")), InterestAck);
      expect(accepted).toMatchObject({ status: "accepted", matched: false, reason: null });
      expect((await eventsOf(w.id))[0]).toMatchObject({ source: "mentra_touch", status: "pending", session_id: null });
    });

    it("the device token is refused on profile, matches and encounter routes", async () => {
      for (const route of [routes.profile, routes.matches, routes.encounter]) {
        err(await api("GET", route, { bearer: token }), 401, "unauthenticated");
      }
      err(await api("POST", routes.devicePair, { bearer: token }), 401, "unauthenticated");
      err(await api("DELETE", routes.deviceUnlink, { bearer: token }), 401, "unauthenticated");
    });

    it("credential/source mismatches are forbidden and write nothing", async () => {
      err(await api("POST", routes.interest, { bearer: token }, interestBody("web_demo")), 403, "forbidden");
      err(await api("POST", routes.interest, { cookie: ca }, interestBody("mentra_touch")), 403, "forbidden");
      err(await api("POST", routes.interest, { bearer: token }, interestBody("mentra_touch", { userId: b.id })), 400, "invalid_request");
      expect(await eventsOf(a.id)).toHaveLength(0);
    });

    it("an invalid bearer on /api/interest is 401, even when valid cookies are also sent", async () => {
      for (const bearer of ["cue_dev_" + "x".repeat(43), "not-a-device-token", ""]) {
        const res = await api("POST", routes.interest, { cookie: ca, bearer }, interestBody("web_demo"));
        err(res, 401, "unauthenticated");
        const res2 = await api("POST", routes.interest, { cookie: ca, bearer }, interestBody("mentra_touch"));
        err(res2, 401, "unauthenticated");
      }
      expect(await eventsOf(a.id)).toHaveLength(0);
      // A session token used as a bearer is not a device token either.
      const { data } = await (await anonClient(a)).auth.getSession();
      err(await api("POST", routes.interest, { bearer: data.session?.access_token ?? "x" }, interestBody("mentra_touch")), 401, "unauthenticated");
    });

    it("a glasses signal with the bearer works and the web user completing it matches", async () => {
      const glasses = ok(await api("POST", routes.interest, { bearer: token }, interestBody("mentra_touch")), InterestAck);
      expect(glasses).toMatchObject({ status: "accepted", matched: false, reason: null });
      const [row] = await eventsOf(a.id);
      expect(row).toMatchObject({ source: "mentra_touch", gesture: "backward_swipe", status: "pending" });
      const web = ok(await api("POST", routes.interest, { cookie: cb }, interestBody("web_demo")), InterestAck);
      expect(web.matched).toBe(true);
      expect(await matchesBetween(a, b)).toHaveLength(1);
      const lastSeen = must(await admin.from("device_associations").select("last_seen_at").eq("id", deviceId).single()) as {
        last_seen_at: string | null;
      };
      expect(lastSeen.last_seen_at).not.toBeNull();
    });

    it("DELETE /api/devices revokes the token", async () => {
      const res = await api("DELETE", routes.deviceUnlink, { cookie: ca });
      expect(res.status).toBe(204);
      err(await api("GET", routes.deviceMe, { bearer: token }), 401, "unauthenticated");
      err(await api("POST", routes.interest, { bearer: token }, interestBody("mentra_touch")), 401, "unauthenticated");
      const row = must(await admin.from("device_associations").select("revoked_at").eq("id", deviceId).single()) as {
        revoked_at: string | null;
      };
      expect(row.revoked_at).not.toBeNull();
      const st = ok(await api("GET", routes.encounter, { cookie: ca }), EncounterStatus);
      expect(st.device.linked).toBe(false);
    });

    it("unlinking cancels a pending glasses signal, so the other person's signal does not match", async () => {
      const p = await newPair();
      const [pa, pb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: pa }), PairingCode);
      const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);
      ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody("mentra_touch")), InterestAck);
      expect((await eventsOf(p.a.id))[0].status).toBe("pending");
      expect((await api("DELETE", routes.deviceUnlink, { cookie: pa })).status).toBe(204);
      expect((await eventsOf(p.a.id))[0].status).toBe("cancelled");
      const ack = ok(await api("POST", routes.interest, { cookie: pb }, interestBody("web_demo")), InterestAck);
      expect(ack).toMatchObject({ status: "accepted", matched: false });
      expect(await matchesOf(p.a)).toHaveLength(0);
    });
  });
});
