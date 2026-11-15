/**
 * Acceptance tests for place-based matching, presence, blocks and resets. They
 * call the real SQL functions of the local Supabase stack through the service
 * role. Coordinates are synthetic: random small offsets around 0, 0.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  backdate,
  backdatePresence,
  checkIn,
  cleanupUsers,
  createUser,
  createUsers,
  createVenue,
  eventById,
  eventsOf,
  freshSpot,
  locate,
  matchesBetween,
  matchesOf,
  must,
  newPair,
  north,
  openVenue,
  presenceOf,
  reportSkips,
  setMode,
  signal,
  stackUp,
  withoutTimes,
  type Ack,
  type Source,
  type TestUser,
} from "./helpers";

reportSkips("matching.test.ts", false);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ms = (iso: string) => new Date(iso).getTime();

/** Two (or more) new users, encounter mode on, located at the given metres north of one fresh spot. */
async function locatedUsers(offsetsM: number[], accuracyM = 5): Promise<TestUser[]> {
  const spot = freshSpot();
  const users = await createUsers(offsetsM.length);
  for (const [i, u] of users.entries()) {
    await setMode(u, true);
    expect(await locate(u, north(spot, offsetsM[i]), accuracyM)).toBe(true);
  }
  return users;
}

const PENDING_SHAPE = { status: "accepted", matched: false, match_id: null, reason: null };

describe.skipIf(!stackUp)("matching (SQL submit_signal, real stack)", () => {
  afterAll(cleanupUsers);

  // -------------------------------------------------------------------------
  describe("mutual signals in one venue inside the window create exactly one match", () => {
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

      const ack1 = await signal(u1, { source });
      expect(ack1).toMatchObject(PENDING_SHAPE);
      expect(ack1.expires_at).not.toBeNull();
      expect(ms(ack1.expires_at!) - ms(ack1.received_at)).toBe(15_000);
      expect(await matchesOf(u1)).toHaveLength(0);

      const ack2 = await signal(u2, { source });
      expect(ack2).toMatchObject({ status: "accepted", matched: true, reason: null, expires_at: null });
      expect(ack2.match_id).toBeTruthy();

      const matches = await matchesBetween(p.a, p.b);
      expect(matches).toHaveLength(1);
      const m = matches[0];
      expect(m.id).toBe(ack2.match_id);
      expect(m.user_a < m.user_b).toBe(true);
      expect(m).toMatchObject({
        status: "active",
        session_id: null,
        venue_id: p.venue.id,
        venue_label: p.venue.name,
        venue_label_source: "venue_checkin",
      });

      const [first1] = await eventsOf(u1.id);
      const [second] = await eventsOf(u2.id);
      expect(m.first_signal_at).toBe(first1.received_at);
      expect(ms(second.received_at)).toBeGreaterThanOrEqual(ms(first1.received_at));
      expect(first1).toMatchObject({ status: "consumed", match_id: m.id, source, session_id: null });
      expect(second).toMatchObject({ status: "consumed", match_id: m.id, source, session_id: null });
      expect(first1.resolved_at).not.toBeNull();
    });
  });

  describe("mixed sources: mentra_touch with headset_remote", () => {
    it.each([
      { first: "mentra_touch" as Source, second: "headset_remote" as Source },
      { first: "headset_remote" as Source, second: "mentra_touch" as Source },
    ])("A via $first then B via $second gives exactly one match, both consumed", async ({ first, second }) => {
      const p = await newPair();
      expect(await signal(p.a, { source: first })).toMatchObject(PENDING_SHAPE);
      const ack2 = await signal(p.b, { source: second });
      expect(ack2).toMatchObject({ status: "accepted", matched: true, reason: null });
      const matches = await matchesBetween(p.a, p.b);
      expect(matches).toHaveLength(1);
      expect(ack2.match_id).toBe(matches[0].id);
      const [ra] = await eventsOf(p.a.id);
      const [rb] = await eventsOf(p.b.id);
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
      const ack = await signal(p.a, { source, gesture });
      expect(ack).toMatchObject({ status: "rejected", reason: "invalid_event", matched: false });
      expect(await eventsOf(p.a.id)).toHaveLength(0);
    });

    it.each(["media_next_track", "media_previous_track", "media_play_pause"])(
      "headset_remote + %s is accepted",
      async (gesture) => {
        const p = await newPair();
        const ack = await signal(p.a, { source: "headset_remote", gesture });
        expect(ack).toMatchObject(PENDING_SHAPE);
        const [row] = await eventsOf(p.a.id);
        expect(row).toMatchObject({ source: "headset_remote", gesture, status: "pending" });
      },
    );
  });

  // -------------------------------------------------------------------------
  describe("phone location", () => {
    it("two located users within range match, labelled Nearby / phone_location, with no venue", async () => {
      const [a, b] = await locatedUsers([0, 30]);
      expect(await signal(a)).toMatchObject(PENDING_SHAPE);
      const ack = await signal(b);
      expect(ack).toMatchObject({ status: "accepted", matched: true });
      const [m] = await matchesBetween(a, b);
      expect(m).toMatchObject({
        id: ack.match_id,
        venue_id: null,
        session_id: null,
        venue_label: "Nearby",
        venue_label_source: "phone_location",
      });
    });

    it("in range only after allowing for accuracy: 49 m apart at 5 m each matches, 51 m does not", async () => {
      const [a, b] = await locatedUsers([0, 49]);
      await signal(a);
      expect((await signal(b)).matched).toBe(true);

      const [c, d] = await locatedUsers([0, 51]);
      expect(await signal(c)).toMatchObject(PENDING_SHAPE);
      expect(await signal(d)).toMatchObject(PENDING_SHAPE);
      expect(await matchesOf(c)).toHaveLength(0);
      expect((await eventsOf(c.id))[0].status).toBe("pending");
    });

    it("larger accuracies widen the range: 150 m apart at 60 m each matches", async () => {
      const [a, b] = await locatedUsers([0, 150], 60);
      await signal(a);
      expect((await signal(b)).matched).toBe(true);
    });

    it("a stale location (over 60 s) gives no_place without a check-in and stores nothing", async () => {
      const [a] = await locatedUsers([0]);
      await backdatePresence(a, { locatedAgoS: 61 });
      const st = must(await admin.rpc("presence_state", { p_user_id: a.id })) as {
        ready: boolean;
        location: { status: string };
      };
      expect(st).toMatchObject({ ready: false, location: { status: "stale" } });
      expect(await signal(a)).toMatchObject({ status: "rejected", reason: "no_place", matched: false, expires_at: null });
      expect(await eventsOf(a.id)).toHaveLength(0);
    });

    it("an inaccurate location (over 100 m) gives no_place without a check-in", async () => {
      const [a] = await locatedUsers([0], 150);
      const st = must(await admin.rpc("presence_state", { p_user_id: a.id })) as {
        ready: boolean;
        location: { status: string; accuracy_m: number };
      };
      expect(st).toMatchObject({ ready: false, location: { status: "inaccurate", accuracy_m: 150 } });
      expect(await signal(a)).toMatchObject({ status: "rejected", reason: "no_place" });
      expect(await eventsOf(a.id)).toHaveLength(0);
    });

    it("no presence at all is encounter_mode_off; mode on with no place is no_place", async () => {
      const u = await createUser();
      expect(await signal(u)).toMatchObject({ status: "rejected", reason: "encounter_mode_off" });
      await setMode(u, true);
      expect(await signal(u)).toMatchObject({ status: "rejected", reason: "no_place" });
      expect(await eventsOf(u.id)).toHaveLength(0);
    });

    it("presence_state never returns coordinates", async () => {
      const [a] = await locatedUsers([0]);
      const row = await presenceOf(a);
      const st = must(await admin.rpc("presence_state", { p_user_id: a.id }));
      const text = JSON.stringify(st);
      expect(text).not.toMatch(/"lat"|"lng"/);
      expect(text).not.toContain(String(row!.lat));
      expect(text).not.toContain(String(row!.lng));
    });
  });

  // -------------------------------------------------------------------------
  describe("venues", () => {
    it("same venue matches with no location, labelled by the venue name", async () => {
      const p = await newPair();
      expect((await presenceOf(p.a))?.lat).toBeNull();
      await signal(p.a);
      const ack = await signal(p.b);
      expect(ack.matched).toBe(true);
      const [m] = await matchesBetween(p.a, p.b);
      expect(m).toMatchObject({ venue_id: p.venue.id, venue_label: p.venue.name, venue_label_source: "venue_checkin" });
    });

    it("different venues and no location never match", async () => {
      const [a, b] = await createUsers(2);
      await createVenue(a);
      await createVenue(b);
      for (const u of [a, b]) await setMode(u, true);
      expect(await signal(a)).toMatchObject(PENDING_SHAPE);
      expect(await signal(b)).toMatchObject(PENDING_SHAPE);
      expect(await matchesOf(a)).toHaveLength(0);
    });

    it("check_in_venue with an unknown code is not_found and changes nothing", async () => {
      const u = await createUser();
      expect(must(await admin.rpc("check_in_venue", { p_user_id: u.id, p_code: "ZZZZZZ" }))).toBe("not_found");
      expect(await presenceOf(u)).toBeNull();
    });

    it("create_venue with a colliding code raises 23505", async () => {
      const [a, b] = await createUsers(2);
      const v = await createVenue(a);
      const res = await admin.rpc("create_venue", { p_user_id: b.id, p_name: "Dup", p_code: v.code });
      expect(res.error?.code).toBe("23505");
    });

    it("a check-in older than 8 hours no longer counts", async () => {
      const p = await newPair();
      await backdatePresence(p.b, { checkedInAgoS: 8 * 3600 + 5 });
      const st = must(await admin.rpc("presence_state", { p_user_id: p.b.id })) as { venue: unknown; ready: boolean };
      expect(st).toMatchObject({ venue: null, ready: false });
      expect(await signal(p.a)).toMatchObject(PENDING_SHAPE);
      expect(await signal(p.b)).toMatchObject({ status: "rejected", reason: "no_place" });
      expect(await matchesOf(p.a)).toHaveLength(0);
      expect((await eventsOf(p.a.id))[0].status).toBe("pending");
    });

    it("check-out cancels a pending signal, so a later signal from the other person does not match", async () => {
      const p = await newPair();
      await signal(p.a);
      must(await admin.rpc("check_out_venue", { p_user_id: p.a.id }));
      const [row] = await eventsOf(p.a.id);
      expect(row).toMatchObject({ status: "cancelled" });
      expect(row.resolved_at).not.toBeNull();
      expect((await presenceOf(p.a))).toMatchObject({ venue_id: null, checked_in_at: null });
      expect(await signal(p.b)).toMatchObject(PENDING_SHAPE);
      expect(await matchesOf(p.a)).toHaveLength(0);
    });

    it("venue-only candidates: the most recent signal wins", async () => {
      const [a, b, c] = await createUsers(3);
      const venue = await createVenue(a);
      await checkIn(b, venue);
      await checkIn(c, venue);
      for (const u of [a, b, c]) await setMode(u, true);
      // A block keeps A and B from matching each other, so both stay pending.
      must(await admin.rpc("block_user", { p_blocker_id: a.id, p_blocked_id: b.id }));
      await signal(a);
      await new Promise((r) => setTimeout(r, 30));
      await signal(b);
      const ack = await signal(c);
      expect(ack.matched).toBe(true);
      expect(await matchesBetween(b, c)).toHaveLength(1);
      expect(await matchesOf(a)).toHaveLength(0);
      expect((await eventsOf(a.id))[0].status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  describe("crowds", () => {
    it("three people: C matches the nearer pending one; the other stays pending, expires, and learns nothing", async () => {
      // A and B are 60 m apart (out of range of each other); C is 25 m from A and 35 m from B.
      const [a, b, c] = await locatedUsers([0, 60, 25]);
      const ackA = await signal(a);
      const ackB = await signal(b);
      // B's own ack is exactly what a lone signal gets.
      const [lone] = await locatedUsers([0]);
      const ackLone = await signal(lone);
      expect(withoutTimes(ackB)).toEqual(withoutTimes(ackLone));
      expect(withoutTimes(ackA)).toEqual(withoutTimes(ackLone));
      expect(Object.keys(ackB).sort()).toEqual(Object.keys(ackLone).sort());

      const [bBefore] = await eventsOf(b.id);
      const ackC = await signal(c);
      expect(ackC.matched).toBe(true);
      expect(await matchesBetween(a, c)).toHaveLength(1);
      expect(await matchesOf(b)).toHaveLength(0);

      // C's signal did not touch B's row in any way (it would reach B over realtime).
      const [bAfter] = await eventsOf(b.id);
      expect(bAfter).toEqual(bBefore);
      expect(bAfter.status).toBe("pending");

      // B's signal later expires through B's own calls only; B never sees C.
      await backdate(bAfter.id, 30);
      must(await admin.rpc("expire_own_signals", { p_user_id: b.id }));
      const [bExpired] = await eventsOf(b.id);
      expect(bExpired).toMatchObject({ status: "expired", match_id: null });
      expect(await matchesOf(b)).toHaveLength(0);
      expect(JSON.stringify(await eventsOf(b.id))).not.toContain(c.id);
    });

    it("blocked pairs (either direction) are never candidates, and the blocked person's ack is an ordinary pending one", async () => {
      for (const direction of ["a blocks b", "b blocks a"] as const) {
        for (const firstSignal of ["a", "b"] as const) {
          const [a, b] = await locatedUsers([0, 5]);
          const [blocker, blocked] = direction === "a blocks b" ? [a, b] : [b, a];
          must(await admin.rpc("block_user", { p_blocker_id: blocker.id, p_blocked_id: blocked.id }));
          const [lone] = await locatedUsers([0]);
          const reference = await signal(lone);

          const [u1, u2] = firstSignal === "a" ? [a, b] : [b, a];
          const ack1 = await signal(u1);
          const ack2 = await signal(u2);
          const label = `${direction}, ${firstSignal} first`;
          expect(withoutTimes(ack1), label).toEqual(withoutTimes(reference));
          expect(withoutTimes(ack2), label).toEqual(withoutTimes(reference));
          expect(await matchesBetween(a, b), label).toHaveLength(0);
          expect((await eventsOf(a.id))[0].status, label).toBe("pending");
          expect((await eventsOf(b.id))[0].status, label).toBe("pending");
        }
      }
    });

    it("a blocked candidate is skipped in favour of the next one", async () => {
      // B and C are 53 m apart (out of range of each other); A is 5 m from B and 48 m from C.
      const [a, b, c] = await locatedUsers([0, -5, 48]);
      must(await admin.rpc("block_user", { p_blocker_id: b.id, p_blocked_id: a.id }));
      await signal(b);
      await signal(c);
      const ack = await signal(a);
      expect(ack.matched).toBe(true);
      expect(await matchesBetween(a, c)).toHaveLength(1);
      expect(await matchesBetween(a, b)).toHaveLength(0);
    });

    it("an already-matched pair does not match again and does not stop matching with a third person", async () => {
      const p = await newPair();
      await signal(p.a);
      expect((await signal(p.b)).matched).toBe(true);

      expect(await signal(p.a)).toMatchObject(PENDING_SHAPE);
      expect(await signal(p.b)).toMatchObject(PENDING_SHAPE);
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);

      const third = await createUser();
      await checkIn(third, p.venue);
      await setMode(third, true);
      const ack = await signal(third);
      expect(ack.matched).toBe(true);
      // Most recent pending signal in the venue is B's.
      expect(await matchesBetween(p.b, third)).toHaveLength(1);
      expect((await eventsOf(p.a.id)).filter((e) => e.status === "pending")).toHaveLength(1);
    });

    it("20 people in one venue signalling at once: 10 matches, nobody in two, no errors", async () => {
      const N = 20;
      const users = await createUsers(N, { profile: false });
      const venue = await createVenue(users[0]);
      for (const u of users.slice(1)) await checkIn(u, venue);
      for (const u of users) await setMode(u, true);

      const results = await Promise.all(
        users.map(async (u) => {
          const r = await admin.rpc("submit_signal", {
            p_user_id: u.id,
            p_event_id: randomUUID(),
            p_source: "web_demo",
            p_gesture: "web_confirm",
            p_occurred_at: new Date().toISOString(),
          });
          return { error: r.error, ack: r.data as Ack | null };
        }),
      );
      expect(results.filter((r) => r.error).map((r) => r.error?.message)).toEqual([]);
      const acks = results.map((r) => r.ack!);
      expect(acks.every((a) => a.status === "accepted")).toBe(true);
      expect(acks.filter((a) => a.matched)).toHaveLength(N / 2);

      const ids = new Set(users.map((u) => u.id));
      const all = must(await admin.from("matches").select("*").eq("venue_id", venue.id)) as {
        user_a: string;
        user_b: string;
      }[];
      expect(all).toHaveLength(N / 2);
      const seen = all.flatMap((m) => [m.user_a, m.user_b]);
      expect(new Set(seen).size).toBe(N);
      expect(seen.every((id) => ids.has(id))).toBe(true);
      const rows = (await Promise.all(users.map((u) => eventsOf(u.id)))).flat();
      expect(rows.map((r) => r.status).sort()).toEqual(Array(N).fill("consumed"));
    });
  });

  // -------------------------------------------------------------------------
  it("does not match after the window elapsed, leaves the stale row untouched, and never replays it", async () => {
    const p = await newPair();
    expect((await signal(p.a)).matched).toBe(false);
    const [rowA] = await eventsOf(p.a.id);
    await backdate(rowA.id, 30);
    const [before] = await eventsOf(p.a.id);

    expect(await signal(p.b)).toMatchObject(PENDING_SHAPE);
    expect(await matchesOf(p.a)).toHaveLength(0);

    // Privacy: B's submission must not touch A's row (that would reach A over realtime).
    const after = (await eventsOf(p.a.id)).find((r) => r.id === rowA.id);
    expect(after).toEqual(before);

    // A fresh signal from A matches B's still-valid signal; A's old row is only now expired (by A's own call).
    expect(await signal(p.a)).toMatchObject({ status: "accepted", matched: true });
    const rowsA = await eventsOf(p.a.id);
    expect(rowsA).toHaveLength(2);
    expect(rowsA.find((r) => r.id === rowA.id)?.status).toBe("expired");
    expect(rowsA.find((r) => r.id !== rowA.id)?.status).toBe("consumed");
    const [rowB] = await eventsOf(p.b.id);
    expect(rowB.status).toBe("consumed");
    const [m] = await matchesBetween(p.a, p.b);
    expect(m.first_signal_at).toBe(rowB.received_at);
  });

  // -------------------------------------------------------------------------
  describe("duplicates", () => {
    it("the same event id twice is a duplicate and stores one row", async () => {
      const p = await newPair();
      const eventId = randomUUID();
      const first = await signal(p.a, { eventId });
      const second = await signal(p.a, { eventId });
      expect(first.status).toBe("accepted");
      expect(second).toMatchObject({ status: "duplicate", matched: false, match_id: null });
      expect(second.received_at).toBe(first.received_at);
      expect(await eventsOf(p.a.id)).toHaveLength(1);
    });

    it("a second signal with a new id while one is pending is a duplicate and creates nothing", async () => {
      const p = await newPair();
      const first = await signal(p.a);
      const newId = randomUUID();
      const second = await signal(p.a, { eventId: newId });
      expect(second).toMatchObject({ status: "duplicate", matched: false, match_id: null });
      expect(second.received_at).toBe(first.received_at);
      expect(await eventsOf(p.a.id)).toHaveLength(1);
      expect(await eventById(newId, p.a.id)).toBeNull();
    });

    it("replaying the matching event is idempotent and still reports the match", async () => {
      const p = await newPair();
      await signal(p.a);
      const ack = await signal(p.b);
      const [bRow] = await eventsOf(p.b.id);
      const replay = await signal(p.b, { eventId: bRow.event_id });
      expect(replay).toMatchObject({ status: "duplicate", matched: true, match_id: ack.match_id });
      // Even after leaving and turning encounter mode off.
      must(await admin.rpc("reset_my_demo", { p_user_id: p.b.id, p_leave: true }));
      expect((await signal(p.b, { eventId: bRow.event_id })).status).toBe("duplicate");
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("concurrency", () => {
    it("simultaneous signals from both users give exactly one match, 25 fresh pairs in a row", async () => {
      for (let round = 0; round < 25; round++) {
        const p = await newPair();
        const acks = await Promise.all([signal(p.a), signal(p.b)]);
        const matched = acks.filter((x) => x.matched);
        expect(acks.map((x) => x.status), `round ${round}`).toEqual(["accepted", "accepted"]);
        expect(matched, `round ${round}`).toHaveLength(1);
        const matches = await matchesBetween(p.a, p.b);
        expect(matches).toHaveLength(1);
        expect(matches[0].id).toBe(matched[0].match_id);
        const rows = [...(await eventsOf(p.a.id)), ...(await eventsOf(p.b.id))];
        expect(rows.map((r) => r.status)).toEqual(["consumed", "consumed"]);
      }
    });

    it("the same pair reset between rounds never produces two active matches", async () => {
      const p = await newPair();
      for (let round = 1; round <= 10; round++) {
        const acks = await Promise.all([signal(p.a), signal(p.b)]);
        expect(acks.filter((x) => x.matched), `round ${round}`).toHaveLength(1);
        const all = await matchesBetween(p.a, p.b);
        expect(all, `round ${round}: total`).toHaveLength(round);
        expect(all.filter((m) => m.status === "active")).toHaveLength(1);
        must(await admin.rpc("reset_my_demo", { p_user_id: p.a.id, p_leave: false }));
        expect((await matchesBetween(p.a, p.b)).filter((m) => m.status === "active")).toHaveLength(0);
      }
    });

    it("10 simultaneous submissions per user give one match and at most one pending row per user", async () => {
      const p = await newPair();
      const acks = await Promise.all(Array.from({ length: 20 }, (_, i) => signal(i % 2 === 0 ? p.a : p.b)));
      expect(acks.filter((x) => x.matched)).toHaveLength(1);
      for (const ack of acks) expect(["accepted", "duplicate"]).toContain(ack.status);
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);
      for (const u of [p.a, p.b]) {
        const rows = await eventsOf(u.id);
        expect(rows.filter((r) => r.status === "consumed")).toHaveLength(1);
        expect(rows.filter((r) => r.status === "pending").length).toBeLessThanOrEqual(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("block", () => {
    it("blocking while matched ends the match with reason block and deletes cached suggestions", async () => {
      const p = await newPair();
      await signal(p.a);
      await signal(p.b);
      const [match] = await matchesBetween(p.a, p.b);
      must(
        await admin
          .from("wingman_suggestions")
          .insert({ match_id: match.id, requester_id: p.a.id, cache_key: "k", payload: { x: 1 } }),
      );
      const count = async () =>
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", match.id)) as unknown[]).length;
      expect(await count()).toBe(1);

      must(await admin.rpc("block_user", { p_blocker_id: p.b.id, p_blocked_id: p.a.id }));
      const [after] = await matchesBetween(p.a, p.b);
      expect(after).toMatchObject({ status: "ended", ended_reason: "block", ended_by: p.b.id });
      expect(await count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("encounter mode and coordinates", () => {
    it("a signal with mode off is rejected encounter_mode_off and stores nothing", async () => {
      const p = await newPair(false);
      expect(await signal(p.a)).toMatchObject({ status: "rejected", reason: "encounter_mode_off", matched: false });
      expect(await eventsOf(p.a.id)).toHaveLength(0);
      await setMode(p.a, true);
      expect((await signal(p.b)).reason).toBe("encounter_mode_off");
      expect((await signal(p.a)).status).toBe("accepted");
      expect(await matchesOf(p.a)).toHaveLength(0);
    });

    it("turning mode off cancels the pending signal and clears lat/lng", async () => {
      const [a, b] = await locatedUsers([0, 5]);
      await signal(a);
      await setMode(a, false);
      const [row] = await eventsOf(a.id);
      expect(row.status).toBe("cancelled");
      expect(row.resolved_at).not.toBeNull();
      expect(await presenceOf(a)).toMatchObject({ encounter_mode: false, lat: null, lng: null, accuracy_m: null, located_at: null });
      expect(await signal(b)).toMatchObject(PENDING_SHAPE);
      expect(await matchesOf(a)).toHaveLength(0);
    });

    it("report_location with mode off stores nothing", async () => {
      const u = await createUser();
      expect(await locate(u, freshSpot())).toBe(false);
      expect(await presenceOf(u)).toBeNull();
      await setMode(u, false);
      expect(await locate(u, freshSpot())).toBe(false);
      expect(await presenceOf(u)).toMatchObject({ lat: null, lng: null, located_at: null });
    });

    it("clear_location forgets the coordinates", async () => {
      const [a] = await locatedUsers([0]);
      must(await admin.rpc("clear_location", { p_user_id: a.id }));
      expect(await presenceOf(a)).toMatchObject({ encounter_mode: true, lat: null, lng: null });
    });

    it("coordinates not refreshed for 10 minutes are swept by the next report", async () => {
      const [a, b] = await locatedUsers([0, 0]);
      await backdatePresence(a, { locatedAgoS: 10 * 60 + 5 });
      await backdatePresence(b, { locatedAgoS: 9 * 60 });
      const [c] = await locatedUsers([0]); // any report runs the sweep
      expect(await presenceOf(a)).toMatchObject({ lat: null, lng: null, accuracy_m: null, located_at: null });
      expect((await presenceOf(b))?.lat).not.toBeNull();
      expect((await presenceOf(c))?.lat).not.toBeNull();
    });

    it("matches and interest_events carry no coordinate columns", async () => {
      const [a, b] = await locatedUsers([0, 5]);
      await signal(a);
      await signal(b);
      const [m] = await matchesBetween(a, b);
      const [e] = await eventsOf(a.id);
      for (const row of [m, e]) {
        for (const key of Object.keys(row)) expect(key).not.toMatch(/^(lat|lng|latitude|longitude|accuracy|located)/);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("one-sided interest is invisible", () => {
    async function bAckWhenAIs(state: "expired" | "cancelled" | "none") {
      const p = await newPair();
      if (state !== "none") {
        await signal(p.a);
        const [row] = await eventsOf(p.a.id);
        if (state === "expired") await backdate(row.id, 30);
        else await setMode(p.a, false);
      }
      return signal(p.b);
    }

    it("B's ack is the same whether A's signal is expired, cancelled or absent", async () => {
      const acks = {
        expired: await bAckWhenAIs("expired"),
        cancelled: await bAckWhenAIs("cancelled"),
        none: await bAckWhenAIs("none"),
      };
      for (const ack of Object.values(acks)) {
        expect(ack).toMatchObject(PENDING_SHAPE);
        expect(ms(ack.expires_at!) - ms(ack.received_at)).toBe(15_000);
      }
      expect(withoutTimes(acks.expired)).toEqual(withoutTimes(acks.none));
      expect(withoutTimes(acks.cancelled)).toEqual(withoutTimes(acks.none));
      expect(Object.keys(acks.expired).sort()).toEqual(Object.keys(acks.none).sort());
    });

    it("A's ack has the same shape whether or not anyone else is in the venue", async () => {
      const [solo, a2, b2] = await createUsers(3);
      await createVenue(solo);
      await setMode(solo, true);
      const alone = await signal(solo);
      await openVenue(a2, b2);
      const withB = await signal(a2);
      expect(withoutTimes(alone)).toEqual(withoutTimes(withB));
      expect(Object.keys(alone).sort()).toEqual(Object.keys(withB).sort());
    });
  });

  // -------------------------------------------------------------------------
  describe("unmatch and reset", () => {
    it("end_match by a non-participant returns false and changes nothing; by a participant it ends the match", async () => {
      const p = await newPair();
      const stranger = await createUser();
      await signal(p.a);
      await signal(p.b);
      const [match] = await matchesBetween(p.a, p.b);
      must(
        await admin.from("wingman_suggestions").insert({ match_id: match.id, requester_id: p.b.id, cache_key: "k", payload: {} }),
      );
      const suggestions = async () =>
        (must(await admin.from("wingman_suggestions").select("match_id").eq("match_id", match.id)) as unknown[]).length;

      for (const who of [stranger.id, randomUUID()]) {
        expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: who, p_reason: "unmatch" }))).toBe(false);
      }
      expect((await matchesBetween(p.a, p.b))[0]).toMatchObject({ status: "active", ended_by: null });
      expect(await suggestions()).toBe(1);

      expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: p.b.id, p_reason: "unmatch" }))).toBe(true);
      expect((await matchesBetween(p.a, p.b))[0]).toMatchObject({ status: "ended", ended_by: p.b.id, ended_reason: "unmatch" });
      expect(await suggestions()).toBe(0);
      expect(must(await admin.rpc("end_match", { p_match_id: match.id, p_user_id: p.a.id, p_reason: "unmatch" }))).toBe(false);
    });

    it("reset_my_demo ends recent matches, expires the pending signal, and lets the same pair match again", async () => {
      const p = await newPair();
      await signal(p.a);
      await signal(p.b);
      const [first] = await matchesBetween(p.a, p.b);
      must(await admin.rpc("reset_my_demo", { p_user_id: p.b.id, p_leave: false }));
      expect((await matchesBetween(p.a, p.b))[0]).toMatchObject({ status: "ended", ended_reason: "reset", ended_by: p.b.id, id: first.id });

      await signal(p.a);
      must(await admin.rpc("reset_my_demo", { p_user_id: p.a.id, p_leave: false }));
      expect((await eventsOf(p.a.id)).filter((r) => r.status === "pending")).toHaveLength(0);
      expect(await signal(p.b)).toMatchObject(PENDING_SHAPE);
      expect(await matchesBetween(p.a, p.b)).toHaveLength(1);

      const again = await signal(p.a);
      expect(again.matched).toBe(true);
      const all = await matchesBetween(p.a, p.b);
      expect(all).toHaveLength(2);
      expect(all.find((m) => m.status === "active")?.id).toBe(again.match_id);
    });

    it("reset_my_demo with leave checks out, turns mode off and forgets the location", async () => {
      const p = await newPair();
      await locate(p.a, freshSpot());
      must(await admin.rpc("reset_my_demo", { p_user_id: p.a.id, p_leave: true }));
      expect(await presenceOf(p.a)).toMatchObject({
        encounter_mode: false,
        venue_id: null,
        checked_in_at: null,
        lat: null,
        lng: null,
      });
      expect((await signal(p.a)).reason).toBe("encounter_mode_off");
      // A user with no presence at all: reset is a harmless no-op.
      const lonely = await createUser();
      expect((await admin.rpc("reset_my_demo", { p_user_id: lonely.id, p_leave: true })).error).toBeNull();
    });
  });
});
