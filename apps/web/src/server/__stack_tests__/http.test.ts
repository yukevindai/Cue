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
  interestBody,
  matchesOf,
  must,
  newPair,
  reportSkips,
  stackUp,
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

const profileInput = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  displayName: "Tester",
  photoUrl: "https://example.com/p.png",
  bio: "I like coffee",
  interests: ["coffee", "hiking"],
  socialLinks: [{ label: "site", url: "https://example.com/me" }],
  sharing: { photo: true, bio: true, interests: true, socialLinks: true, aiAssist: true },
  ...over,
});

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
      ["POST", routes.demoSession, { venueLabel: "x" }],
      ["POST", routes.demoSessionJoin, { joinCode: "ABCDEF" }],
      ["POST", routes.demoReset, {}],
      ["POST", routes.interest, interestBody(id)],
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

      // Profiles: A shares everything but social links; B hides bio and photo but shares interests + links.
      const pa = profileInput({
        displayName: "Alice Test",
        bio: "Alice bio",
        sharing: { photo: true, bio: true, interests: true, socialLinks: false, aiAssist: true },
      });
      const pb = profileInput({
        displayName: "Bob Test",
        bio: "Bob secret bio",
        interests: ["chess"],
        socialLinks: [{ label: "bob", url: "https://example.com/bob" }],
        sharing: { photo: false, bio: false, interests: true, socialLinks: true, aiAssist: false },
      });
      ok(await api("PUT", routes.profile, { cookie: ca }, pa), OwnProfile);
      ok(await api("PUT", routes.profile, { cookie: cb }, pb), OwnProfile);

      // Session
      const venue = `HTTP Venue ${randomUUID().slice(0, 6)}`;
      const created = ok(await api("POST", routes.demoSession, { cookie: ca }, { venueLabel: venue }), EncounterStatus);
      expect(created.session).not.toBeNull();
      expect(created.session!.memberCount).toBe(1);
      expect(created.session!.venueLabel).toBe(venue);
      const sessionId = created.session!.id;
      const joined = ok(
        await api("POST", routes.demoSessionJoin, { cookie: cb }, { joinCode: created.session!.joinCode }),
        EncounterStatus,
      );
      expect(joined.session!.id).toBe(sessionId);
      expect(joined.session!.memberCount).toBe(2);

      // Interest with encounter mode still off is rejected (HTTP 200 ack).
      const early = ok(await api("POST", routes.interest, { cookie: ca }, interestBody(sessionId)), InterestAck);
      expect(early).toMatchObject({ status: "rejected", reason: "encounter_mode_off", matched: false });

      for (const cookie of [ca, cb]) {
        const st = ok(await api("POST", routes.encounterMode, { cookie }, { enabled: true }), EncounterStatus);
        expect(st.encounterMode).toBe(true);
      }

      // A signals first: accepted, not matched; B's own view shows no incoming interest.
      const ackA = ok(await api("POST", routes.interest, { cookie: ca }, interestBody(sessionId)), InterestAck);
      expect(ackA).toMatchObject({ status: "accepted", matched: false, reason: null });
      expect(ackA.expiresAt).not.toBeNull();
      const bStatus = ok(await api("GET", routes.encounter, { cookie: cb }), EncounterStatus);
      expect(bStatus.pendingSignal).toBeNull();
      const aStatus = ok(await api("GET", routes.encounter, { cookie: ca }), EncounterStatus);
      expect(aStatus.pendingSignal?.source).toBe("web_demo");
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
      expect(await matchesOf(sessionId)).toHaveLength(0);

      // B signals: matched true on the second only.
      const ackB = ok(await api("POST", routes.interest, { cookie: cb }, interestBody(sessionId)), InterestAck);
      expect(ackB).toMatchObject({ status: "accepted", matched: true, expiresAt: null });
      const dbMatches = await matchesOf(sessionId);
      expect(dbMatches).toHaveLength(1);
      expect(new Date(dbMatches[0].first_signal_at).getTime()).toBe(new Date(ackA.receivedAt).getTime());
      expect((await eventsOf(a.id, sessionId)).filter((e) => e.status === "consumed")).toHaveLength(1);

      // Matches: each sees the OTHER person, honouring their sharing flags.
      const listA = ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches;
      const listB = ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches;
      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA[0].id).toBe(dbMatches[0].id);
      expect(listA[0].venueLabel).toBe(venue);
      expect(new Date(listA[0].encounterAt).getTime()).toBe(new Date(ackA.receivedAt).getTime());

      expect(listA[0].other).toEqual({
        userId: b.id,
        displayName: "Bob Test",
        photoUrl: null, // B: photo sharing off
        bio: null, // B: bio sharing off
        interests: ["chess"],
        socialLinks: [{ label: "bob", url: "https://example.com/bob" }],
      });
      expect(JSON.stringify(listA)).not.toContain("Bob secret bio");
      expect(listB[0].other).toEqual({
        userId: a.id,
        displayName: "Alice Test",
        photoUrl: "https://example.com/p.png",
        bio: "Alice bio",
        interests: ["coffee", "hiking"],
        socialLinks: [], // A: social link sharing off
      });
      const card = ok(await api("GET", routes.match(dbMatches[0].id), { cookie: ca }), MatchCard);
      expect(card).toEqual(listA[0]);

      // Third user: join -> 409 session_full; nothing visible; cannot touch the match.
      err(await api("POST", routes.demoSessionJoin, { cookie: cc }, { joinCode: created.session!.joinCode }), 409, "session_full");
      expect(ok(await api("GET", routes.matches, { cookie: cc }), MatchList).matches).toEqual([]);
      err(await api("GET", routes.match(dbMatches[0].id), { cookie: cc }), 404, "not_found");
      err(await api("POST", routes.unmatch(dbMatches[0].id), { cookie: cc }), 404, "not_found");
      err(await api("GET", routes.match("not-a-uuid"), { cookie: cc }), 404, "not_found");
      expect((await matchesOf(sessionId))[0].status).toBe("active");
      const third = ok(await api("POST", routes.interest, { cookie: cc }, interestBody(sessionId)), InterestAck);
      expect(third).toMatchObject({ status: "rejected", reason: "not_in_session", matched: false });
      expect(await eventsOf(c.id)).toHaveLength(0);
      const members = must(
        await admin.from("demo_session_members").select("user_id").eq("session_id", sessionId).is("left_at", null),
      ) as unknown[];
      expect(members).toHaveLength(2);

      // Unmatch by a participant removes access for both.
      const un = await api("POST", routes.unmatch(dbMatches[0].id), { cookie: cb });
      expect(un.status).toBe(204);
      expect(ok(await api("GET", routes.matches, { cookie: ca }), MatchList).matches).toEqual([]);
      err(await api("GET", routes.match(dbMatches[0].id), { cookie: ca }), 404, "not_found");
      expect((await matchesOf(sessionId))[0]).toMatchObject({ status: "ended", ended_reason: "unmatch", ended_by: b.id });
      // Second unmatch: not found.
      err(await api("POST", routes.unmatch(dbMatches[0].id), { cookie: ca }), 404, "not_found");
    });

    it("no route accepts a client-supplied user id: extra userId in the interest body is a 400 and writes nothing", async () => {
      const p = await newPair();
      const cookie = await cookieFor(p.a);
      const other = p.b.id;
      for (const spoof of [p.b.id, randomUUID()]) {
        err(await api("POST", routes.interest, { cookie }, interestBody(p.sessionId, "web_demo", { userId: spoof })), 400, "invalid_request");
      }
      err(await api("POST", routes.interest, { cookie }, interestBody(p.sessionId, "web_demo", { user_id: other })), 400, "invalid_request");
      expect(await eventsOf(p.a.id)).toHaveLength(0);
      expect(await eventsOf(p.b.id)).toHaveLength(0);
      // Wrong gesture for the source is also invalid.
      err(await api("POST", routes.interest, { cookie }, { ...interestBody(p.sessionId), gesture: "backward_swipe" }), 400, "invalid_request");
    });

    it("blocking over HTTP ends the match and the blocker's later signal is rejected", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      for (const [cookie, who] of [[ca, p.a], [cb, p.b]] as const) {
        ok(await api("PUT", routes.profile, { cookie }, profileInput({ displayName: `Blk ${who.id.slice(0, 4)}` })), OwnProfile);
      }
      ok(await api("POST", routes.interest, { cookie: ca }, interestBody(p.sessionId)), InterestAck);
      const m = ok(await api("POST", routes.interest, { cookie: cb }, interestBody(p.sessionId)), InterestAck);
      expect(m.matched).toBe(true);
      expect((await api("POST", routes.blocks, { cookie: ca }, { userId: p.b.id })).status).toBe(204);
      expect(ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches).toEqual([]);
      expect((await matchesOf(p.sessionId))[0]).toMatchObject({ status: "ended", ended_reason: "block" });
      const after = ok(await api("POST", routes.interest, { cookie: ca }, interestBody(p.sessionId)), InterestAck);
      expect(after).toMatchObject({ status: "rejected", reason: "blocked" });
      err(await api("POST", routes.blocks, { cookie: ca }, { userId: p.a.id }), 400, "invalid_request");
    });
  });

  // -------------------------------------------------------------------------
  describe("headset_remote (web session only)", () => {
    it("cookie + headset_remote/media_next_track is accepted; one-sided signal is invisible to the other person", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const ack = ok(await api("POST", routes.interest, { cookie: ca }, interestBody(p.sessionId, "headset_remote")), InterestAck);
      expect(ack).toMatchObject({ status: "accepted", matched: false, reason: null });
      const [row] = await eventsOf(p.a.id, p.sessionId);
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
      err(await api("POST", routes.interest, { bearer: deviceToken }, interestBody(p.sessionId, "headset_remote")), 403, "forbidden");
      expect(await eventsOf(p.a.id, p.sessionId)).toHaveLength(0);
    });

    it("headset_remote with a gesture from another source is a 400 (contract refine) and writes nothing", async () => {
      const p = await newPair();
      const ca = await cookieFor(p.a);
      for (const gesture of ["web_confirm", "backward_swipe"]) {
        err(await api("POST", routes.interest, { cookie: ca }, interestBody(p.sessionId, "headset_remote", { gesture })), 400, "invalid_request");
      }
      err(await api("POST", routes.interest, { cookie: ca }, interestBody(p.sessionId, "web_demo", { gesture: "media_next_track" })), 400, "invalid_request");
      expect(await eventsOf(p.a.id, p.sessionId)).toHaveLength(0);
    });

    it("a Mentra device swipe plus the other person's headset_remote creates one match", async () => {
      const p = await newPair();
      const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
      const pairing = ok(await api("POST", routes.devicePair, { cookie: ca }), PairingCode);
      const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);
      ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody(p.sessionId, "mentra_touch")), InterestAck);
      const ack = ok(await api("POST", routes.interest, { cookie: cb }, interestBody(p.sessionId, "headset_remote")), InterestAck);
      expect(ack.matched).toBe(true);
      expect(await matchesOf(p.sessionId)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("device pairing and device-token auth", () => {
    let a: Awaited<ReturnType<typeof newPair>>["a"];
    let b: Awaited<ReturnType<typeof newPair>>["b"];
    let sessionId: string;
    let ca: string;
    let cb: string;
    let token: string;
    let deviceId: string;

    beforeAll(async () => {
      const p = await newPair();
      ({ a, b, sessionId } = p);
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
      expect(ctx).toMatchObject({ deviceId, encounterMode: true, encounterSessionId: sessionId });
      // Cookies alone are not device auth.
      err(await api("GET", routes.deviceMe, { cookie: ca }), 401, "unauthenticated");
    });

    it("the device token is refused on profile, matches and encounter routes", async () => {
      for (const route of [routes.profile, routes.matches, routes.encounter]) {
        err(await api("GET", route, { bearer: token }), 401, "unauthenticated");
      }
      err(await api("POST", routes.devicePair, { bearer: token }), 401, "unauthenticated");
      err(await api("DELETE", routes.deviceUnlink, { bearer: token }), 401, "unauthenticated");
    });

    it("credential/source mismatches are forbidden and write nothing", async () => {
      err(await api("POST", routes.interest, { bearer: token }, interestBody(sessionId, "web_demo")), 403, "forbidden");
      err(await api("POST", routes.interest, { cookie: ca }, interestBody(sessionId, "mentra_touch")), 403, "forbidden");
      err(await api("POST", routes.interest, { bearer: token }, interestBody(sessionId, "mentra_touch", { userId: b.id })), 400, "invalid_request");
      expect(await eventsOf(a.id)).toHaveLength(0);
    });

    it("an invalid bearer on /api/interest is 401, even when valid cookies are also sent", async () => {
      for (const bearer of ["cue_dev_" + "x".repeat(43), "not-a-device-token", ""]) {
        const res = await api("POST", routes.interest, { cookie: ca, bearer }, interestBody(sessionId, "web_demo"));
        err(res, 401, "unauthenticated");
        const res2 = await api("POST", routes.interest, { cookie: ca, bearer }, interestBody(sessionId, "mentra_touch"));
        err(res2, 401, "unauthenticated");
      }
      expect(await eventsOf(a.id)).toHaveLength(0);
      // A session token used as a bearer is not a device token either.
      const { data } = await (await anonClient(a)).auth.getSession();
      err(await api("POST", routes.interest, { bearer: data.session?.access_token ?? "x" }, interestBody(sessionId, "mentra_touch")), 401, "unauthenticated");
    });

    it("a glasses signal with the bearer works and the web user completing it matches", async () => {
      const glasses = ok(await api("POST", routes.interest, { bearer: token }, interestBody(sessionId, "mentra_touch")), InterestAck);
      expect(glasses).toMatchObject({ status: "accepted", matched: false, reason: null });
      const [row] = await eventsOf(a.id, sessionId);
      expect(row).toMatchObject({ source: "mentra_touch", gesture: "backward_swipe", status: "pending" });
      const web = ok(await api("POST", routes.interest, { cookie: cb }, interestBody(sessionId, "web_demo")), InterestAck);
      expect(web.matched).toBe(true);
      expect(await matchesOf(sessionId)).toHaveLength(1);
      const lastSeen = must(await admin.from("device_associations").select("last_seen_at").eq("id", deviceId).single()) as {
        last_seen_at: string | null;
      };
      expect(lastSeen.last_seen_at).not.toBeNull();
    });

    it("DELETE /api/devices revokes the token", async () => {
      const res = await api("DELETE", routes.deviceUnlink, { cookie: ca });
      expect(res.status).toBe(204);
      err(await api("GET", routes.deviceMe, { bearer: token }), 401, "unauthenticated");
      err(await api("POST", routes.interest, { bearer: token }, interestBody(sessionId, "mentra_touch")), 401, "unauthenticated");
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
      ok(await api("POST", routes.interest, { bearer: deviceToken }, interestBody(p.sessionId, "mentra_touch")), InterestAck);
      expect((await eventsOf(p.a.id, p.sessionId))[0].status).toBe("pending");
      expect((await api("DELETE", routes.deviceUnlink, { cookie: pa })).status).toBe(204);
      expect((await eventsOf(p.a.id, p.sessionId))[0].status).toBe("cancelled");
      const ack = ok(await api("POST", routes.interest, { cookie: pb }, interestBody(p.sessionId, "web_demo")), InterestAck);
      expect(ack).toMatchObject({ status: "accepted", matched: false });
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
    });
  });
});
