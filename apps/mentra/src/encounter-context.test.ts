import { describe, expect, it } from "vitest";
import { CONTEXT_MAX_AGE_MS, EncounterContextTracker, type ContextFetchResult } from "./encounter-context";
import { DEVICE_ID } from "./testing";

const ctx = (encounterMode: boolean, ready: boolean): ContextFetchResult => ({
  ok: true,
  context: { deviceId: DEVICE_ID, encounterMode, ready, latestMatchId: null, serverTime: "2026-11-14T10:00:00.000Z" },
});

function make(fetchContext: () => Promise<ContextFetchResult>) {
  const clock = { t: 1000 };
  return { clock, tracker: new EncounterContextTracker(fetchContext, () => clock.t) };
}

describe("EncounterContextTracker", () => {
  it("is stale before the first refresh", () => {
    expect(make(async () => ctx(true, true)).tracker.snapshot()).toEqual({ state: "stale" });
  });

  it("mode on and ready is ready", async () => {
    const { tracker } = make(async () => ctx(true, true));
    expect(await tracker.refresh()).toEqual({ state: "ready" });
  });

  it("mode off is encounter_mode_off, whatever ready says", async () => {
    expect(await make(async () => ctx(false, true)).tracker.refresh()).toEqual({ state: "encounter_mode_off" });
    expect(await make(async () => ctx(false, false)).tracker.refresh()).toEqual({ state: "encounter_mode_off" });
  });

  it("mode on but not ready is no_place", async () => {
    expect(await make(async () => ctx(true, false)).tracker.refresh()).toEqual({ state: "no_place" });
  });

  it("a failed refresh takes effect immediately", async () => {
    let result: ContextFetchResult = ctx(true, true);
    const { tracker } = make(async () => result);
    await tracker.refresh();
    result = { ok: false, reason: "offline" };
    expect(await tracker.refresh()).toEqual({ state: "offline" });
    result = { ok: false, reason: "unlinked" };
    expect(await tracker.refresh()).toEqual({ state: "unlinked" });
  });

  it("goes stale after the max age", async () => {
    const { tracker, clock } = make(async () => ctx(true, true));
    await tracker.refresh();
    clock.t += CONTEXT_MAX_AGE_MS;
    expect(tracker.snapshot().state).toBe("ready");
    clock.t += 1;
    expect(tracker.snapshot()).toEqual({ state: "stale" });
  });

  it("a thrown fetch is offline", async () => {
    const { tracker } = make(async () => {
      throw new Error("boom");
    });
    expect(await tracker.refresh()).toEqual({ state: "offline" });
  });

  it("out-of-order responses: the older request cannot overwrite the newer", async () => {
    const resolvers: ((r: ContextFetchResult) => void)[] = [];
    const { tracker } = make(() => new Promise<ContextFetchResult>((r) => resolvers.push(r)));
    const first = tracker.refresh();
    const second = tracker.refresh();
    resolvers[1]!(ctx(true, true));
    await second;
    resolvers[0]!(ctx(false, false));
    await first;
    expect(tracker.snapshot()).toEqual({ state: "ready" });
  });

  it("reset forgets everything", async () => {
    const { tracker } = make(async () => ctx(true, true));
    await tracker.refresh();
    tracker.reset();
    expect(tracker.snapshot()).toEqual({ state: "stale" });
  });
});
