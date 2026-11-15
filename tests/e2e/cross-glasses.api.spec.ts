// Server-path coverage only. A `mentra_touch` event here is an HTTP request
// made with a device token, and a `headset_remote` event is an HTTP request
// made with a web session. Neither is evidence that either pair of physical
// glasses works; the real devices are checked by hand (docs/hardware-check.md
// and docs/meta-glasses-check.md).
import { anonymousApi, deviceApi } from "./helpers/auth";
import { apiFor, interestEvent, must, wasRejected } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches, sleepPast } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { watchTable } from "./helpers/realtime";
import { signal, type Person } from "./helpers/scenario";

/** Pairs a device for `person` through the real pair/claim flow. */
async function linkDevice(person: Person) {
  const pairing = must(await person.api.devicePair(), "devicePair");
  const anon = await anonymousApi();
  try {
    const claim = must(
      await apiFor(anon).deviceClaim({ code: pairing.code, deviceLabel: "E2E Glasses", mentraUserId: null }),
      "deviceClaim",
    );
    const ctx = await deviceApi(claim.deviceToken);
    return { ctx, api: apiFor(ctx) };
  } finally {
    await anon.dispose();
  }
}

test.describe("Mentra swipe and headset remote signal (server path only)", () => {
  for (const order of ["Mentra first", "headset first"] as const) {
    test(`${order}: device-token swipe and the other person's headset_remote make one shared match`, async ({ world }) => {
      const pair = await world.pair({ venue: "E2E Test Cafe" });
      const device = await linkDevice(pair.a);
      try {
        const swipe = () => device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" }));
        const remote = () => signal(pair, pair.b, { source: "headset_remote" });

        const first = must(order === "Mentra first" ? await swipe() : await remote(), "first signal");
        expect(first).toMatchObject({ status: "accepted", matched: false, reason: null });
        await expectNoMatches(pair.a.api, pair.b.api);

        const second = must(order === "Mentra first" ? await remote() : await swipe(), "second signal");
        expect(second).toMatchObject({ status: "accepted", matched: true, reason: null, expiresAt: null });

        const { forA, forB } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
        expect(forA.other.userId).toBe(pair.b.user.id);
        expect(forA.other.displayName).toBe(pair.b.displayName);
        expect(forB.other.userId).toBe(pair.a.user.id);
        expect(forB.other.displayName).toBe(pair.a.displayName);
        for (const card of [forA, forB]) {
          expect(card.venueLabel).toBe("E2E Test Cafe");
          expect(card.venueLabelSource).toBe("manual");
          expect(Math.abs(new Date(card.encounterAt).getTime() - new Date(first.receivedAt).getTime())).toBeLessThan(50);
        }
        expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
        expect(must(await pair.b.api.getEncounter()).pendingSignal).toBeNull();
      } finally {
        await device.ctx.dispose();
      }
    });
  }

  test("two headset_remote signals (two Meta wearers) match", async ({ world }) => {
    const pair = await world.pair();
    const first = must(await signal(pair, pair.a, { source: "headset_remote" }));
    expect(first.matched).toBe(false);
    expect(must(await pair.a.api.getEncounter()).pendingSignal?.source).toBe("headset_remote");
    const second = must(await signal(pair, pair.b, { source: "headset_remote", gesture: "media_play_pause" }));
    expect(second.matched).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  });

  test("one-sided headset_remote is invisible to the other person and expires with no match", async ({ world }) => {
    test.setTimeout(90_000);
    const pair = await world.pair();
    const watchB = await watchTable(pair.b, "interest_events");
    const watchBMatches = await watchTable(pair.b, "matches");
    try {
      const first = must(await signal(pair, pair.a, { source: "headset_remote" }), "A headset signal");
      expect(first).toMatchObject({ status: "accepted", matched: false });
      expect(must(await pair.a.api.getEncounter()).pendingSignal?.source).toBe("headset_remote");

      // B sees nothing: status, match list, and both realtime feeds.
      const bStatus = must(await pair.b.api.getEncounter());
      expect(bStatus.pendingSignal).toBeNull();
      await expectNoMatches(pair.b.api);
      expect(await watchB.waitFor(1500), "B's interest_events feed stays silent").toBeNull();
      expect(await watchBMatches.waitFor(10), "B's matches feed stays silent").toBeNull();

      await sleepPast(first.expiresAt!);
      expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();

      const late = must(await signal(pair, pair.b), "B late web signal");
      expect(late).toMatchObject({ status: "accepted", matched: false });
      await expectNoMatches(pair.a.api, pair.b.api);
      // Supabase realtime cannot RLS-filter DELETE events (they carry only the id), and other tests'
      // cleanup deletes rows, so only inserts and updates are meaningful here.
      expect(watchBMatches.events.filter((e) => e.eventType !== "DELETE")).toEqual([]);
    } finally {
      await watchB.close();
      await watchBMatches.close();
    }
  });

  test("a device token cannot send headset_remote, and an outsider cannot inject one", async ({ world }) => {
    const pair = await world.pair();
    const third = await world.person();
    const device = await linkDevice(pair.a);
    try {
      const viaDevice = await device.api.interest(interestEvent(pair.session.id, { source: "headset_remote" }));
      expect(viaDevice.status).toBe(403);
      expect(viaDevice.error?.code).toBe("forbidden");

      const outsider = await third.api.interest(interestEvent(pair.session.id, { source: "headset_remote" }));
      expect(wasRejected(outsider, "not_in_session")).toBe(true);

      expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
      // B's signal finds nothing to match: neither refused attempt left a pending signal.
      expect(must(await signal(pair, pair.b)).matched).toBe(false);
      await expectNoMatches(pair.a.api, pair.b.api, third.api);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("headset_remote rejects gestures of other sources and a client user id", async ({ world }) => {
    const pair = await world.pair();
    const base = interestEvent(pair.session.id, { source: "headset_remote" });
    for (const body of [
      { ...base, gesture: "web_confirm" },
      { ...base, gesture: "backward_swipe" },
      { ...base, userId: pair.b.user.id },
    ] as Array<Record<string, unknown>>) {
      const r = await pair.a.api.interest(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe("invalid_request");
    }
    expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
  });

  for (const gesture of ["media_next_track", "media_previous_track", "media_play_pause"] as const) {
    test(`headset_remote accepts ${gesture}`, async ({ world }) => {
      const pair = await world.pair();
      const ack = must(await signal(pair, pair.a, { source: "headset_remote", gesture }));
      expect(ack).toMatchObject({ status: "accepted", matched: false, reason: null });
      expect(must(await pair.b.api.getEncounter()).pendingSignal).toBeNull();
      expect(must(await signal(pair, pair.b, { source: "headset_remote", gesture })).matched).toBe(true);
    });
  }
});
