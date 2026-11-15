import { must, notMatched, wasRejected } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { signal } from "./helpers/scenario";

test.describe("blocked accounts", () => {
  test("after A blocks B no match can be created, in either order", async ({ world }) => {
    const pair = await world.pair();
    expect((await pair.a.api.block(pair.b.user.id)).status).toBe(204);

    // Neither side is told anything: a signal from either is an ordinary
    // accepted one that waits out its window and can never complete a match.
    const fromBlocker = must(await signal(pair, pair.a), "blocker signal");
    expect(fromBlocker).toMatchObject({ status: "accepted", matched: false, reason: null });
    expect(fromBlocker.expiresAt).not.toBeNull();
    const fromBlocked = must(await signal(pair, pair.b), "blocked signal");
    expect(fromBlocked).toMatchObject({ status: "accepted", matched: false, reason: null });
    expect(fromBlocked.expiresAt).not.toBeNull();
    expect(Object.keys(fromBlocked).sort()).toEqual(Object.keys(fromBlocker).sort());
    // Both are still pending on their own side (the other's signal did not consume or cancel it).
    for (const who of [pair.a, pair.b]) expect(must(await who.api.getEncounter()).pendingSignal).not.toBeNull();
    // A fresh gesture while pending is a duplicate for both, still not a match.
    expect(notMatched(await signal(pair, pair.b))).toBe(true);
    expect(notMatched(await signal(pair, pair.a))).toBe(true);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("a block placed while the other person's signal is pending prevents the match", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a)); // A pending
    expect((await pair.b.api.block(pair.a.user.id)).status).toBe(204);
    const r = await signal(pair, pair.b);
    expect(notMatched(r)).toBe(true);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("blocking ends an active match and removes access for both people", async ({ world, fake }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA, forB } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    expect((await pair.b.api.block(pair.a.user.id)).status).toBe(204);

    await expectNoMatches(pair.a.api, pair.b.api);
    for (const who of [pair.a, pair.b]) {
      const card = await who.api.getMatch(forA.id);
      expect(card.status).toBe(404);
      expect(card.error?.code).toBe("not_found");
      const sugg = await who.api.suggestions(forB.id);
      expect(sugg.status).toBe(404);
    }
    expect(await fake.requests(), "no model call for an ended match").toHaveLength(0);
  });

  test("a block is permanent for matching: fresh gestures later still do not match", async ({ world }) => {
    const pair = await world.pair();
    must(await pair.a.api.block(pair.b.user.id));
    await signal(pair, pair.b);
    await signal(pair, pair.a);
    await expectNoMatches(pair.a.api, pair.b.api);
  });
});

test.describe("paused encounter mode", () => {
  test("a paused person's signal is refused and no match results", async ({ world }) => {
    const pair = await world.pair();
    must(await pair.b.api.setMode(false));
    expect(must(await pair.b.api.getEncounter()).encounterMode).toBe(false);

    expect(wasRejected(await signal(pair, pair.b), "encounter_mode_off")).toBe(true);
    // A is still active and may signal, but nobody can reciprocate.
    expect(notMatched(await signal(pair, pair.a))).toBe(true);
    expect(wasRejected(await signal(pair, pair.b), "encounter_mode_off")).toBe(true);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("pausing the first signaller cancels their pending signal", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    expect(must(await pair.a.api.getEncounter()).pendingSignal).not.toBeNull();

    must(await pair.a.api.setMode(false));
    expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();

    // B signals within the original window: A's cancelled signal must not match.
    expect(notMatched(await signal(pair, pair.b))).toBe(true);
    // Resuming does not resurrect it either; a fresh gesture is required.
    must(await pair.a.api.setMode(true));
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("a person who paused and resumed can match again with fresh gestures", async ({ world }) => {
    const pair = await world.pair();
    must(await pair.a.api.setMode(false));
    must(await pair.a.api.setMode(true));
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  });

  test("encounter mode never turned on: signals are refused", async ({ world }) => {
    const pair = await world.pair({ encounterMode: false });
    expect(wasRejected(await signal(pair, pair.a), "encounter_mode_off")).toBe(true);
    expect(wasRejected(await signal(pair, pair.b), "encounter_mode_off")).toBe(true);
    await expectNoMatches(pair.a.api, pair.b.api);
  });
});
