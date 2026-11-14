// A pending signal is interest in the one other person who was in the session
// when it was sent. If that person leaves and somebody else joins, the old
// signal must not complete a match with the newcomer.
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  cleanupUsers,
  createUser,
  eventsOf,
  matchesOf,
  must,
  newPair,
  reportSkips,
  signal,
  stackUp,
} from "./helpers";

reportSkips("partner-swap.test.ts", false);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!stackUp)("pending signals do not survive a change of session partner", () => {
  afterAll(cleanupUsers);

  it("B leaves and C joins inside the window: A's signal is cancelled and C's signal does not match", async () => {
    const p = await newPair();
    const c = await createUser();

    const first = await signal(p.a, p.sessionId);
    expect(first).toMatchObject({ status: "accepted", matched: false });

    must(await admin.rpc("leave_demo_session", { p_user_id: p.b.id }));
    expect((await eventsOf(p.a.id, p.sessionId))[0]).toMatchObject({ status: "cancelled" });

    const joined = must(await admin.rpc("join_demo_session", { p_user_id: c.id, p_join_code: p.joinCode })) as {
      status: string;
    };
    expect(joined.status).toBe("joined");
    must(await admin.rpc("set_encounter_mode", { p_user_id: c.id, p_enabled: true }));

    const fromC = await signal(c, p.sessionId);
    expect(fromC).toMatchObject({ status: "accepted", matched: false, match_id: null });
    expect(await matchesOf(p.sessionId)).toHaveLength(0);

    // Fresh interest from A, now aimed at C, does match.
    const again = await signal(p.a, p.sessionId);
    expect(again).toMatchObject({ status: "accepted", matched: true });
    const matches = await matchesOf(p.sessionId);
    expect(matches).toHaveLength(1);
    expect([matches[0].user_a, matches[0].user_b].sort()).toEqual([p.a.id, c.id].sort());
  });

  it("a signal sent while alone in the session is cancelled when someone joins", async () => {
    const p = await newPair();
    const c = await createUser();
    must(await admin.rpc("leave_demo_session", { p_user_id: p.b.id }));

    await signal(p.a, p.sessionId);
    must(await admin.rpc("join_demo_session", { p_user_id: c.id, p_join_code: p.joinCode }));
    must(await admin.rpc("set_encounter_mode", { p_user_id: c.id, p_enabled: true }));

    const pending = (await eventsOf(p.a.id, p.sessionId)).filter((e) => e.status === "pending");
    expect(pending).toHaveLength(0);
    expect(await signal(c, p.sessionId)).toMatchObject({ matched: false });
    expect(await matchesOf(p.sessionId)).toHaveLength(0);
  });
});
