/**
 * Acceptance tests for matching, sessions, blocks and resets. They call the real
 * SQL functions of the local Supabase stack through the service role.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  activeMembers,
  admin,
  backdate,
  cleanupUsers,
  createUser,
  createUsers,
  eventById,
  eventsOf,
  matchesOf,
  must,
  newPair,
  openSession,
  reportSkips,
  signal,
  stackUp,
  withoutTimes,
  type Source,
} from "./helpers";

reportSkips("matching.test.ts", false);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ms = (iso: string) => new Date(iso).getTime();

describe.skipIf(!stackUp)("matching (SQL submit_interest, real stack)", () => {
  afterAll(cleanupUsers);

  // -------------------------------------------------------------------------
  // A1
  // -------------------------------------------------------------------------
  describe("mutual signals inside the window create exactly one match", () => {
    const cases: { first: "A" | "B"; source: Source }[] = [
      { first: "A", source: "web_demo" },
      { first: "B", source: "web_demo" },
      { first: "A", source: "mentra_touch" },
      { first: "B", source: "mentra_touch" },
      { first: "A", source: "headset_remote" },
      { first: "B", source: "headset_remote" },
    ];
    it.each(cases)("$first signals first via $source", async ({ first, source }) => {
      const p = await newPair();
      const [u1, u2] = first === "A" ? [p.a, p.b] : [p.b, p.a];

      const ack1 = await signal(u1, p.sessionId, { source });
      expect(ack1).toMatchObject({ status: "accepted", matched: false, match_id: null, reason: null });
      expect(ack1.expires_at).not.toBeNull();
      expect(ms(ack1.expires_at!) - ms(ack1.received_at)).toBe(15_000);
      expect(await matchesOf(p.sessionId)).toHaveLength(0);

      const ack2 = await signal(u2, p.sessionId, { source });
      expect(ack2).toMatchObject({ status: "accepted", matched: true, reason: null });
      expect(ack2.match_id).toBeTruthy();

      const matches = await matchesOf(p.sessionId);
      expect(matches).toHaveLength(1);
      const m = matches[0];
      expect(m.id).toBe(ack2.match_id);
      expect(m.user_a < m.user_b).toBe(true);
      expect([m.user_a, m.user_b].sort()).toEqual([p.a.id, p.b.id].sort());
      expect(m.status).toBe("active");
      expect(m.venue_label).toBe(p.venue);

      const first1 = (await eventsOf(u1.id, p.sessionId))[0];
      const second = (await eventsOf(u2.id, p.sessionId))[0];
      expect(m.first_signal_at).toBe(first1.received_at);
      expect(ms(m.first_signal_at)).toBe(ms(ack1.received_at));
      expect(ms(second.received_at)).toBeGreaterThanOrEqual(ms(first1.received_at));
      expect(first1).toMatchObject({ status: "consumed", match_id: m.id, source });
      expect(second).toMatchObject({ status: "consumed", match_id: m.id, source });
      expect(first1.resolved_at).not.toBeNull();
    });
  });

  describe("mixed sources: mentra_touch with headset_remote", () => {
    it.each([
      { first: "mentra_touch" as Source, second: "headset_remote" as Source },
      { first: "headset_remote" as Source, second: "mentra_touch" as Source },
    ])("A via $first then B via $second gives exactly one match, both consumed", async ({ first, second }) => {
      const p = await newPair();
      const ack1 = await signal(p.a, p.sessionId, { source: first });
      expect(ack1).toMatchObject({ status: "accepted", matched: false, reason: null });
      const ack2 = await signal(p.b, p.sessionId, { source: second });
      expect(ack2).toMatchObject({ status: "accepted", matched: true, reason: null });
      const matches = await matchesOf(p.sessionId);
      expect(matches).toHaveLength(1);
      expect(ack2.match_id).toBe(matches[0].id);
      const [ra] = await eventsOf(p.a.id, p.sessionId);
      const [rb] = await eventsOf(p.b.id, p.sessionId);
      expect(ra).toMatchObject({ status: "consumed", match_id: matches[0].id, source: first });
      expect(rb).toMatchObject({ status: "consumed", match_id: matches[0].id, source: second });
    });
  });

  describe("source and gesture pairs are enforced in SQL", () => {
    it.each([
      { source: "headset_remote" as Source, gesture: "backward_swipe" },
      { source: "headset_remote" as Source, gesture: "web_confirm" },
      { source: "web_demo" as Source, gesture: "media_next_track" },
      { source: "mentra_touch" as Source, gesture: "media_next_track" },
      { source: "web_demo" as Source, gesture: "media_play_pause" },
    ])("$source + $gesture is rejected invalid_event and stores nothing", async ({ source, gesture }) => {
      const p = await newPair();
      const ack = await signal(p.a, p.sessionId, { source, gesture });
      expect(ack).toMatchObject({ status: "rejected", reason: "invalid_event", matched: false });
      expect(await eventsOf(p.a.id, p.sessionId)).toHaveLength(0);
    });

    it.each(["media_next_track", "media_previous_track", "media_play_pause"])(
      "headset_remote + %s is accepted",
      async (gesture) => {
        const p = await newPair();
        const ack = await signal(p.a, p.sessionId, { source: "headset_remote", gesture });
        expect(ack).toMatchObject({ status: "accepted", matched: false, reason: null });
        const [row] = await eventsOf(p.a.id, p.sessionId);
        expect(row).toMatchObject({ source: "headset_remote", gesture, status: "pending" });
      },
    );

    it("the table CHECK also refuses a bad pair written directly", async () => {
      const p = await newPair();
      const res = await admin.from("interest_events").insert({
        event_id: randomUUID(),
        user_id: p.a.id,
        session_id: p.sessionId,
        source: "headset_remote",
        gesture: "backward_swipe",
        occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15_000).toISOString(),
        status: "pending",
      });
      expect(res.error).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // A2
  // -------------------------------------------------------------------------
  it("does not match after the window elapsed, leaves the stale row untouched, and never replays it", async () => {
    const p = await newPair();
    const ackA = await signal(p.a, p.sessionId);
    expect(ackA.matched).toBe(false);
    const [rowA] = await eventsOf(p.a.id, p.sessionId);
    await backdate(rowA.id, 30);
    const before = (await eventsOf(p.a.id, p.sessionId))[0];

    const ackB = await signal(p.b, p.sessionId);
    expect(ackB).toMatchObject({ status: "accepted", matched: false, match_id: null, reason: null });
    expect(await matchesOf(p.sessionId)).toHaveLength(0);

    // Privacy property: B's submission must not touch A's row (that would reach A over realtime).
    const after = (await eventsOf(p.a.id, p.sessionId))[0];
    expect(after).toEqual(before);
    expect(after.status).toBe("pending");
    expect(after.resolved_at).toBeNull();

    // A fresh signal from A matches B's still-valid signal; A's old row is only now expired (by A's own call).
    const ackA2 = await signal(p.a, p.sessionId);
    expect(ackA2).toMatchObject({ status: "accepted", matched: true });
    const rowsA = await eventsOf(p.a.id, p.sessionId);
    expect(rowsA).toHaveLength(2);
    expect(rowsA.find((r) => r.id === rowA.id)?.status).toBe("expired");
    expect(rowsA.find((r) => r.id !== rowA.id)?.status).toBe("consumed");
    expect((await eventsOf(p.b.id, p.sessionId))[0].status).toBe("consumed");

    const matches = await matchesOf(p.sessionId);
    expect(matches).toHaveLength(1);
    // first_signal_at is the earlier of the two signals that actually matched (B's), not A's stale one.
    expect(matches[0].first_signal_at).toBe((await eventsOf(p.b.id, p.sessionId))[0].received_at);
  });

  // -------------------------------------------------------------------------
  // A3
  // -------------------------------------------------------------------------
  describe("duplicates", () => {
    it("the same event id twice is a duplicate and stores one row", async () => {
      const p = await newPair();
      const eventId = randomUUID();
      const first = await signal(p.a, p.sessionId, { eventId });
      const second = await signal(p.a, p.sessionId, { eventId });
      expect(first.status).toBe("accepted");
      expect(second).toMatchObject({ status: "duplicate", matched: false, match_id: null });
      expect(second.received_at).toBe(first.received_at);
      const rows = must(
        await admin.from("interest_events").select("id").eq("user_id", p.a.id).eq("event_id", eventId),
      ) as unknown[];
      expect(rows).toHaveLength(1);
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
    });

    it("a second signal with a new id while one is pending is a duplicate and creates nothing", async () => {
      const p = await newPair();
      const first = await signal(p.a, p.sessionId);
      const newId = randomUUID();
      const second = await signal(p.a, p.sessionId, { eventId: newId });
      expect(second).toMatchObject({ status: "duplicate", matched: false, match_id: null });
      expect(second.received_at).toBe(first.received_at); // the original pending signal, not a new one
      const rows = await eventsOf(p.a.id, p.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(await eventById(newId, p.a.id)).toBeNull();
    });

    it("after a match further signals are rejected already_matched and never create a second match", async () => {
      const p = await newPair();
      await signal(p.a, p.sessionId);
      const matchAck = await signal(p.b, p.sessionId);
      expect(matchAck.matched).toBe(true);

      for (const u of [p.a, p.b, p.a, p.b]) {
        const ack = await signal(u, p.sessionId);
        expect(ack).toMatchObject({ status: "rejected", reason: "already_matched", matched: false, match_id: null });
      }
      const matches = await matchesOf(p.sessionId);
      expect(matches).toHaveLength(1);
      expect(await eventsOf(p.a.id, p.sessionId)).toHaveLength(1);
      expect(await eventsOf(p.b.id, p.sessionId)).toHaveLength(1);

      // Replaying the matching event itself is idempotent and still reports the same match.
      const [bRow] = await eventsOf(p.b.id, p.sessionId);
      const replay = await signal(p.b, p.sessionId, { eventId: bRow.event_id });
      expect(replay).toMatchObject({ status: "duplicate", matched: true, match_id: matches[0].id });
      expect(await matchesOf(p.sessionId)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // A4
  // -------------------------------------------------------------------------
  describe("concurrency", () => {
    it("simultaneous signals from both users give exactly one match, 25 fresh sessions in a row", async () => {
      for (let round = 0; round < 25; round++) {
        // Fresh users per round: an active match belongs to the pair, not the session.
        const p = await newPair();
        const { a, b } = p;
        const acks = await Promise.all([signal(a, p.sessionId), signal(b, p.sessionId)]);
        const matched = acks.filter((x) => x.matched);
        expect(acks.map((x) => x.status), `round ${round}`).toEqual(["accepted", "accepted"]);
        expect(matched, `round ${round}: exactly one ack has matched=true`).toHaveLength(1);
        const matches = await matchesOf(p.sessionId);
        expect(matches, `round ${round}: matches`).toHaveLength(1);
        expect(matches[0].id).toBe(matched[0].match_id);
        const rows = [...(await eventsOf(a.id, p.sessionId)), ...(await eventsOf(b.id, p.sessionId))];
        expect(rows.map((r) => r.status)).toEqual(["consumed", "consumed"]);
      }
    });

    it("the same pair reset between rounds also never produces two matches", async () => {
      const p = await newPair();
      for (let round = 1; round <= 10; round++) {
        const acks = await Promise.all([signal(p.a, p.sessionId), signal(p.b, p.sessionId)]);
        expect(acks.filter((x) => x.matched), `round ${round}`).toHaveLength(1);
        const all = await matchesOf(p.sessionId);
        expect(all, `round ${round}: total`).toHaveLength(round);
        expect(all.filter((m) => m.status === "active")).toHaveLength(1);
        expect(must(await admin.rpc("reset_demo_session", { p_user_id: p.a.id, p_leave: false }))).toBe(true);
        expect((await matchesOf(p.sessionId)).filter((m) => m.status === "active")).toHaveLength(0);
      }
    });

    it("10 simultaneous submissions per user (distinct event ids) give one match and at most one live row per user", async () => {
      const p = await newPair();
      const acks = await Promise.all(
        Array.from({ length: 20 }, (_, i) => signal(i % 2 === 0 ? p.a : p.b, p.sessionId)),
      );
      expect(acks.filter((x) => x.matched)).toHaveLength(1);
      for (const ack of acks) {
        if (ack.status === "rejected") expect(ack.reason).toBe("already_matched");
        else expect(["accepted", "duplicate"]).toContain(ack.status);
      }
      const matches = await matchesOf(p.sessionId);
      expect(matches).toHaveLength(1);
      for (const u of [p.a, p.b]) {
        const live = (await eventsOf(u.id, p.sessionId)).filter((r) => r.status === "pending" || r.status === "consumed");
        expect(live).toHaveLength(1);
        expect(live[0].status).toBe("consumed");
      }
    });
  });

  // -------------------------------------------------------------------------
  // A5
  // -------------------------------------------------------------------------
  describe("third account", () => {
    it("join_demo_session for a third user is session_full and adds nothing", async () => {
      const p = await newPair(false);
      const third = await createUser();
      const res = must(await admin.rpc("join_demo_session", { p_user_id: third.id, p_join_code: p.joinCode })) as {
        status: string;
        session_id: string | null;
      };
      expect(res).toEqual({ status: "session_full", session_id: null });
      expect((await activeMembers(p.sessionId)).sort()).toEqual([p.a.id, p.b.id].sort());
    });

    it("20 simultaneous joins to a session with one member: exactly one succeeds, two active members", async () => {
      const host = await createUser();
      const joiners = await createUsers(20, { profile: false });
      const code = "T" + randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();
      const sessionId = must(
        await admin.rpc("create_demo_session", { p_user_id: host.id, p_venue_label: "Race Venue", p_join_code: code }),
      ) as string;
      const results = await Promise.all(
        joiners.map(async (u) => {
          const r = await admin.rpc("join_demo_session", { p_user_id: u.id, p_join_code: code });
          return { user: u.id, error: r.error, data: r.data as { status: string } | null };
        }),
      );
      expect(results.filter((r) => r.error).map((r) => r.error?.message)).toEqual([]);
      const joined = results.filter((r) => r.data?.status === "joined");
      const full = results.filter((r) => r.data?.status === "session_full");
      expect(joined).toHaveLength(1);
      expect(full).toHaveLength(19);
      const members = await activeMembers(sessionId);
      expect(members).toHaveLength(2);
      expect(members.sort()).toEqual([host.id, joined[0].user].sort());
    });

    it("a direct service-role insert of a third member row is refused by the database", async () => {
      const p = await newPair(false);
      const third = await createUser();
      const res = await admin.from("demo_session_members").insert({ session_id: p.sessionId, user_id: third.id });
      expect(res.error).not.toBeNull();
      expect(res.error?.code).toBe("CUE01");
      expect(await activeMembers(p.sessionId)).toHaveLength(2);
    });

    it("the third user's signal is rejected not_in_session, identical to a nonexistent session, and writes nothing", async () => {
      const p = await newPair();
      const third = await createUser();
      await signal(p.a, p.sessionId); // a pending signal exists in the session
      const eventId = randomUUID();
      const real = await signal(third, p.sessionId, { eventId });
      const fake = await signal(third, randomUUID(), { eventId });
      expect(real).toMatchObject({ status: "rejected", reason: "not_in_session", matched: false, match_id: null });
      expect(real.expires_at).toBeNull();
      expect(withoutTimes(real)).toEqual(withoutTimes(fake));
      expect(Object.keys(real).sort()).toEqual(Object.keys(fake).sort());
      expect(await eventsOf(third.id)).toHaveLength(0);
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
      // The existing pending signal was not consumed or altered.
      expect((await eventsOf(p.a.id, p.sessionId))[0].status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // A6
  // -------------------------------------------------------------------------
  describe("block", () => {
    it("blocker's signal is rejected blocked; the blocked person's is accepted but never matches (either order)", async () => {
      const p = await newPair();
      must(await admin.rpc("block_user", { p_blocker_id: p.a.id, p_blocked_id: p.b.id }));

      const aAck = await signal(p.a, p.sessionId);
      expect(aAck).toMatchObject({ status: "rejected", reason: "blocked", matched: false });
      expect(await eventsOf(p.a.id, p.sessionId)).toHaveLength(0);

      const bAck = await signal(p.b, p.sessionId);
      expect(bAck).toMatchObject({ status: "accepted", matched: false, match_id: null, reason: null });
      expect(bAck.expires_at).not.toBeNull();

      // B pending first, then A: still no match.
      const aAgain = await signal(p.a, p.sessionId);
      expect(aAgain).toMatchObject({ status: "rejected", reason: "blocked" });
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
      expect((await eventsOf(p.b.id, p.sessionId))[0].status).toBe("pending");
    });

    it("block after the blocked person's signal was already pending: blocker's signal is rejected, no match", async () => {
      const p = await newPair();
      await signal(p.b, p.sessionId);
      must(await admin.rpc("block_user", { p_blocker_id: p.a.id, p_blocked_id: p.b.id }));
      const aAck = await signal(p.a, p.sessionId);
      expect(aAck).toMatchObject({ status: "rejected", reason: "blocked" });
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
    });

    it("block after the blocker's own signal is pending: the blocked person's signal is accepted and never matches", async () => {
      const p = await newPair();
      await signal(p.a, p.sessionId);
      must(await admin.rpc("block_user", { p_blocker_id: p.a.id, p_blocked_id: p.b.id }));
      const bAck = await signal(p.b, p.sessionId);
      expect(bAck).toMatchObject({ status: "accepted", matched: false, match_id: null, reason: null });
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
      expect((await eventsOf(p.a.id, p.sessionId))[0].status).toBe("pending");
    });

    it("blocking while matched ends the match with reason block and deletes cached suggestions", async () => {
      const p = await newPair();
      await signal(p.a, p.sessionId);
      await signal(p.b, p.sessionId);
      const [match] = await matchesOf(p.sessionId);
      must(
        await admin
          .from("wingman_suggestions")
          .insert({ match_id: match.id, requester_id: p.a.id, cache_key: "k", payload: { x: 1 } }),
      );
      const count = async () =>
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", match.id)) as unknown[]).length;
      expect(await count()).toBe(1);

      must(await admin.rpc("block_user", { p_blocker_id: p.b.id, p_blocked_id: p.a.id }));
      const [after] = await matchesOf(p.sessionId);
      expect(after).toMatchObject({ status: "ended", ended_reason: "block", ended_by: p.b.id });
      expect(await count()).toBe(0);
      const blocks = must(await admin.from("blocks").select("*").eq("blocker_id", p.b.id)) as unknown[];
      expect(blocks).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // A7
  // -------------------------------------------------------------------------
  describe("encounter mode", () => {
    it("a signal with mode off is rejected encounter_mode_off and stores nothing", async () => {
      const p = await newPair(false);
      const ack = await signal(p.a, p.sessionId);
      expect(ack).toMatchObject({ status: "rejected", reason: "encounter_mode_off", matched: false });
      expect(await eventsOf(p.a.id)).toHaveLength(0);
      // Only A turned it on: B is still rejected, and A's lone signal cannot match.
      must(await admin.rpc("set_encounter_mode", { p_user_id: p.a.id, p_enabled: true }));
      expect((await signal(p.b, p.sessionId)).reason).toBe("encounter_mode_off");
      expect((await signal(p.a, p.sessionId)).status).toBe("accepted");
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
    });

    it("turning mode off cancels the pending signal, so the other person's signal does not match", async () => {
      const p = await newPair();
      await signal(p.a, p.sessionId);
      expect(must(await admin.rpc("set_encounter_mode", { p_user_id: p.a.id, p_enabled: false }))).toBe(true);
      const [row] = await eventsOf(p.a.id, p.sessionId);
      expect(row.status).toBe("cancelled");
      expect(row.resolved_at).not.toBeNull();

      const bAck = await signal(p.b, p.sessionId);
      expect(bAck).toMatchObject({ status: "accepted", matched: false });
      expect(await matchesOf(p.sessionId)).toHaveLength(0);
      expect((await eventsOf(p.a.id, p.sessionId))[0].status).toBe("cancelled");
    });

    it("set_encounter_mode returns false for a user who is not in a session", async () => {
      const lonely = await createUser();
      expect(must(await admin.rpc("set_encounter_mode", { p_user_id: lonely.id, p_enabled: true }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // A8
  // -------------------------------------------------------------------------
  describe("one-sided interest is invisible", () => {
    async function bAckWhenAIs(state: "expired" | "cancelled" | "none") {
      const p = await newPair();
      if (state !== "none") {
        await signal(p.a, p.sessionId);
        const [row] = await eventsOf(p.a.id, p.sessionId);
        if (state === "expired") await backdate(row.id, 30);
        else must(await admin.rpc("set_encounter_mode", { p_user_id: p.a.id, p_enabled: false }));
      }
      const ack = await signal(p.b, p.sessionId);
      return ack;
    }

    it("B's ack is the same whether A's signal is expired, cancelled or absent", async () => {
      const acks = {
        expired: await bAckWhenAIs("expired"),
        cancelled: await bAckWhenAIs("cancelled"),
        none: await bAckWhenAIs("none"),
      };
      for (const ack of Object.values(acks)) {
        expect(ack).toMatchObject({ status: "accepted", matched: false, match_id: null, reason: null });
        expect(ms(ack.expires_at!) - ms(ack.received_at)).toBe(15_000);
      }
      expect(Object.keys(acks.expired).sort()).toEqual(Object.keys(acks.none).sort());
      expect(Object.keys(acks.cancelled).sort()).toEqual(Object.keys(acks.none).sort());
      expect(withoutTimes(acks.expired)).toEqual(withoutTimes(acks.none));
      expect(withoutTimes(acks.cancelled)).toEqual(withoutTimes(acks.none));
    });

    it("A's ack has the same shape whether or not B is in the session", async () => {
      const [solo, a2, b2] = await createUsers(3);
      const soloSession = must(
        await admin.rpc("create_demo_session", { p_user_id: solo.id, p_venue_label: "Solo", p_join_code: "S" + randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase() }),
      ) as string;
      must(await admin.rpc("set_encounter_mode", { p_user_id: solo.id, p_enabled: true }));
      const alone = await signal(solo, soloSession);

      const p = await openSession(a2, b2);
      const withB = await signal(a2, p.sessionId);

      expect(withoutTimes(alone)).toEqual(withoutTimes(withB));
      expect(Object.keys(alone).sort()).toEqual(Object.keys(withB).sort());
      expect(ms(alone.expires_at!) - ms(alone.received_at)).toBe(15_000);
      expect(ms(withB.expires_at!) - ms(withB.received_at)).toBe(15_000);
    });
  });

  // -------------------------------------------------------------------------
  // A9
  // -------------------------------------------------------------------------
  describe("unmatch and reset", () => {
    it("end_match by a non-participant returns false and changes nothing; by a participant it ends the match", async () => {
      const p = await newPair();
      const stranger = await createUser();
      await signal(p.a, p.sessionId);
      await signal(p.b, p.sessionId);
      const [match] = await matchesOf(p.sessionId);
      must(
        await admin
          .from("wingman_suggestions")
          .insert({ match_id: match.id, requester_id: p.b.id, cache_key: "k", payload: {} }),
      );

      for (const who of [stranger.id, randomUUID()]) {
        expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: who, p_reason: "unmatch" }))).toBe(false);
      }
      expect(must(await admin.rpc("end_match", { p_match_id: randomUUID(), p_user_id: p.a.id, p_reason: "unmatch" }))).toBe(false);
      const untouched = (await matchesOf(p.sessionId))[0];
      expect(untouched).toMatchObject({ status: "active", ended_by: null, ended_reason: null });
      expect(
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", match.id)) as unknown[]).length,
      ).toBe(1);

      expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: p.b.id, p_reason: "unmatch" }))).toBe(true);
      const ended = (await matchesOf(p.sessionId))[0];
      expect(ended).toMatchObject({ status: "ended", ended_by: p.b.id, ended_reason: "unmatch" });
      expect(
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", match.id)) as unknown[]).length,
      ).toBe(0);
      // Already ended: a second call by either participant is a no-op false.
      expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: p.a.id, p_reason: "unmatch" }))).toBe(false);
    });

    it("reset_demo_session ends matches, expires pending signals, and lets the same pair match again", async () => {
      const p = await newPair();
      await signal(p.a, p.sessionId);
      await signal(p.b, p.sessionId);
      const [first] = await matchesOf(p.sessionId);
      must(
        await admin
          .from("wingman_suggestions")
          .insert({ match_id: first.id, requester_id: p.a.id, cache_key: "k", payload: {} }),
      );

      expect(must(await admin.rpc("reset_demo_session", { p_user_id: p.b.id, p_leave: false }))).toBe(true);
      const afterReset = (await matchesOf(p.sessionId))[0];
      expect(afterReset).toMatchObject({ status: "ended", ended_reason: "reset", ended_by: p.b.id });
      expect(
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", first.id)) as unknown[]).length,
      ).toBe(0);

      // Pending signals are expired by reset and never replayed.
      await signal(p.a, p.sessionId);
      expect(must(await admin.rpc("reset_demo_session", { p_user_id: p.a.id, p_leave: false }))).toBe(true);
      expect((await eventsOf(p.a.id, p.sessionId)).filter((r) => r.status === "pending")).toHaveLength(0);
      const lateB = await signal(p.b, p.sessionId);
      expect(lateB).toMatchObject({ status: "accepted", matched: false });
      expect(await matchesOf(p.sessionId)).toHaveLength(1); // still just the ended first one

      // B is pending now; a fresh A signal matches again: a new, second match row.
      const aAck = await signal(p.a, p.sessionId);
      expect(aAck.matched).toBe(true);
      const all = await matchesOf(p.sessionId);
      expect(all).toHaveLength(2);
      expect(all.filter((m) => m.status === "active")).toHaveLength(1);
      expect(all.find((m) => m.status === "active")?.id).toBe(aAck.match_id);
    });

    it("reset_demo_session returns false for a user not in a session; leave:true ends the session", async () => {
      const lonely = await createUser();
      expect(must(await admin.rpc("reset_demo_session", { p_user_id: lonely.id, p_leave: false }))).toBe(false);

      const p = await newPair();
      expect(must(await admin.rpc("reset_demo_session", { p_user_id: p.a.id, p_leave: true }))).toBe(true);
      expect(await activeMembers(p.sessionId)).toHaveLength(0);
      const s = must(await admin.from("demo_sessions").select("status").eq("id", p.sessionId).single()) as { status: string };
      expect(s.status).toBe("ended");
      expect((await signal(p.a, p.sessionId)).reason).toBe("not_in_session");
    });
  });
});
