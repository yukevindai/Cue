import { MATCH_WINDOW_SECONDS } from "@cue/contracts";
import { interestEvent, must } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches, sleepPast } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { signal } from "./helpers/scenario";

const ACK_KEYS = ["eventId", "expiresAt", "matched", "reason", "receivedAt", "status"];

test.describe("two-account matching (spec section 3)", () => {
  for (const order of ["A then B", "B then A"] as const) {
    test(`exactly one match when ${order} signal`, async ({ world }) => {
      const pair = await world.pair({ venue: "E2E Test Cafe" });
      const [first, second] = order === "A then B" ? [pair.a, pair.b] : [pair.b, pair.a];

      const ackFirst = must(await signal(pair, first), "first signal");
      expect(ackFirst.status).toBe("accepted");
      expect(ackFirst.matched, "first signal alone must not match").toBe(false);
      expect(ackFirst.reason).toBeNull();
      expect(ackFirst.expiresAt).not.toBeNull();
      const windowMs = new Date(ackFirst.expiresAt!).getTime() - new Date(ackFirst.receivedAt).getTime();
      expect(windowMs).toBeGreaterThanOrEqual(MATCH_WINDOW_SECONDS * 1000 - 500);
      expect(windowMs).toBeLessThanOrEqual(MATCH_WINDOW_SECONDS * 1000 + 500);
      expect(Object.keys(ackFirst).sort()).toEqual(ACK_KEYS);
      // No match exists for either person after the first signal alone.
      await expectNoMatches(pair.a.api, pair.b.api);

      const ackSecond = must(await signal(pair, second), "second signal");
      expect(ackSecond.status).toBe("accepted");
      expect(ackSecond.matched).toBe(true);
      expect(ackSecond.reason).toBeNull();
      expect(ackSecond.expiresAt, "a completed match has no pending expiry").toBeNull();
      expect(Object.keys(ackSecond).sort()).toEqual(ACK_KEYS);

      const { forA, forB } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
      // Each side sees the other person's approved profile, the venue label and the first signal time.
      expect(forA.other.userId).toBe(pair.b.user.id);
      expect(forA.other.displayName).toBe(pair.b.displayName);
      expect(forB.other.userId).toBe(pair.a.user.id);
      expect(forB.other.displayName).toBe(pair.a.displayName);
      for (const card of [forA, forB]) {
        expect(card.venueLabel).toBe("E2E Test Cafe");
        expect(card.venueLabelSource).toBe("manual");
        expect(Math.abs(new Date(card.encounterAt).getTime() - new Date(ackFirst.receivedAt).getTime())).toBeLessThan(50);
      }
      // GET /api/matches/[id] agrees with the list.
      expect(must(await pair.a.api.getMatch(forA.id)).id).toBe(forA.id);
      expect(must(await pair.b.api.getMatch(forB.id)).id).toBe(forB.id);
    });
  }

  test("match card honours each owner's sharing settings", async ({ world }) => {
    const pair = await world.pair({
      b: {
        bio: "PRIVATE-BIO-MARKER",
        interests: ["PRIVATE-INTEREST-MARKER"],
        sharing: { photo: false, bio: false, interests: false, aiAssist: true },
      },
    });
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect(forA.other.displayName).toBe(pair.b.displayName); // display name is always shared
    expect(forA.other.bio).toBeNull();
    expect(forA.other.interests).toEqual([]);
    expect(forA.other).not.toHaveProperty("socialLinks");
    expect(forA.other.photoUrl).toBeNull();
    const raw = (await pair.a.api.listMatches()).text;
    expect(raw).not.toContain("PRIVATE-BIO-MARKER");
    expect(raw).not.toContain("PRIVATE-INTEREST-MARKER");
  });

  test("a second signal after the 15 s window creates no match (real wait)", async ({ world }) => {
    // Chosen approach: really wait past the window. The migration's expiry is
    // enforced by comparing interest_events.expires_at with the DB clock, so
    // mutating expires_at via the service role would only test our mutation.
    test.setTimeout(60_000);
    const pair = await world.pair();
    const first = must(await signal(pair, pair.a), "A signal");
    expect(first.matched).toBe(false);
    await sleepPast(first.expiresAt!);

    // A's own view: the expired signal is no longer pending.
    expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();

    const late = must(await signal(pair, pair.b), "B late signal");
    expect(late.matched, "A's expired signal must not be replayed").toBe(false);
    expect(late.status).toBe("accepted");
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("duplicate input: repeated eventId and a second signal while pending never add matches", async ({ world }) => {
    const pair = await world.pair();
    const ev = interestEvent(pair.session.id);

    const first = must(await pair.a.api.interest(ev), "first");
    expect(first.status).toBe("accepted");
    // Same eventId again.
    const again = must(await pair.a.api.interest(ev), "repeat");
    expect(again.status).toBe("duplicate");
    expect(again.matched).toBe(false);
    expect(again.eventId).toBe(ev.eventId);
    // A brand-new eventId while the first is still pending is also a duplicate.
    const second = must(await signal(pair, pair.a), "second event id");
    expect(second.status).toBe("duplicate");
    expect(second.matched).toBe(false);
    await expectNoMatches(pair.a.api, pair.b.api);

    // B completes the match once.
    const evB = interestEvent(pair.session.id);
    const done = must(await pair.b.api.interest(evB), "B");
    expect(done.matched).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    // Replays of both events, and fresh signals from both people, never add a second match.
    expect(must(await pair.b.api.interest(evB)).status).toBe("duplicate");
    expect(must(await pair.a.api.interest(ev)).status).toBe("duplicate");
    for (const who of [pair.a, pair.b, pair.a, pair.b]) {
      const r = must(await signal(pair, who), "post-match signal");
      expect(r.matched, "no further match after a match").toBe(false);
    }
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  });

  test("the same eventId sent concurrently is accepted once", async ({ world }) => {
    const pair = await world.pair();
    const ev = interestEvent(pair.session.id);
    const [r1, r2] = await Promise.all([pair.a.api.interest(ev), pair.a.api.interest(ev)]);
    const statuses = [must(r1).status, must(r2).status].sort();
    expect(statuses).toEqual(["accepted", "duplicate"]);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("simultaneous signals create exactly one match", async ({ world }) => {
    const pair = await world.pair();
    const [ra, rb] = await Promise.all([signal(pair, pair.a), signal(pair, pair.b)]);
    const acks = [must(ra, "A"), must(rb, "B")];
    expect(acks.filter((x) => x.matched)).toHaveLength(1);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  });

  test("an unmatched pair can match again after unmatch with fresh gestures", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect((await pair.a.api.unmatch(forA.id)).status).toBe(204);
    await expectNoMatches(pair.a.api, pair.b.api);

    must(await signal(pair, pair.b));
    const again = must(await signal(pair, pair.a));
    expect(again.matched).toBe(true);
    const { forA: second } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect(second.id).not.toBe(forA.id);
  });
});
