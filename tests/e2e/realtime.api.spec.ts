import { MatchRealtimeRow } from "@cue/contracts";
import { must } from "./helpers/api";
import { expectExactlyOneSharedMatch } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { watchTable } from "./helpers/realtime";
import { signal } from "./helpers/scenario";

test("both participants get a matches realtime event within 2 s of the second signal's response", async ({ world }) => {
  const pair = await world.pair();
  const watchA = await watchTable(pair.a, "matches");
  const watchB = await watchTable(pair.b, "matches");
  try {
    const first = must(await signal(pair, pair.a));
    expect(first.matched).toBe(false);
    // The first signal alone produces no matches event for anyone.
    expect(await watchA.waitFor(1000)).toBeNull();
    expect(await watchB.waitFor(10)).toBeNull();

    const second = must(await signal(pair, pair.b));
    const t0 = Date.now(); // the second signal's response has just arrived
    expect(second.matched).toBe(true);

    const [evA, evB] = await Promise.all([watchA.waitFor(2000), watchB.waitFor(2000)]);
    expect(evA, "A receives a matches event").not.toBeNull();
    expect(evB, "B receives a matches event").not.toBeNull();
    expect(evA!.at - t0).toBeLessThanOrEqual(2000);
    expect(evB!.at - t0).toBeLessThanOrEqual(2000);

    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    for (const ev of [evA!, evB!]) {
      const row = MatchRealtimeRow.parse(ev.new);
      expect(row.id).toBe(forA.id);
      expect([row.user_a, row.user_b].sort()).toEqual([pair.a.user.id, pair.b.user.id].sort());
      expect(row.status).toBe("active");
    }
  } finally {
    await watchA.close();
    await watchB.close();
  }
});
