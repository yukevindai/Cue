import { describe, expect, it } from "vitest";
import { expiresAt, gestureMatchesSource, isExpired, orderPair, sourceAllowedForAuth } from "./index";

describe("window", () => {
  const t = new Date("2026-11-14T12:00:00.000Z");
  it("expires 15s after receipt", () => {
    expect(expiresAt(t).toISOString()).toBe("2026-11-14T12:00:15.000Z");
  });
  it("is alive until exactly expiresAt, then expired", () => {
    const s = { expiresAt: expiresAt(t) };
    expect(isExpired(s, new Date(t.getTime() + 14_999))).toBe(false);
    expect(isExpired(s, new Date(t.getTime() + 15_000))).toBe(true);
    expect(isExpired(s, new Date(t.getTime() + 15_001))).toBe(true);
  });
});

describe("gestureMatchesSource", () => {
  it("pairs sources with their gestures only", () => {
    expect(gestureMatchesSource("mentra_touch", "backward_swipe")).toBe(true);
    expect(gestureMatchesSource("web_demo", "web_confirm")).toBe(true);
    expect(gestureMatchesSource("mentra_touch", "web_confirm")).toBe(false);
    expect(gestureMatchesSource("web_demo", "backward_swipe")).toBe(false);
  });

  const MEDIA = ["media_next_track", "media_previous_track", "media_play_pause"] as const;
  it.each(MEDIA)("headset_remote accepts %s", (g) => {
    expect(gestureMatchesSource("headset_remote", g)).toBe(true);
  });
  it.each(["backward_swipe", "web_confirm"] as const)("headset_remote rejects %s", (g) => {
    expect(gestureMatchesSource("headset_remote", g)).toBe(false);
  });
  it.each(["web_demo", "mentra_touch"] as const)("%s rejects every media gesture", (src) => {
    for (const g of MEDIA) expect(gestureMatchesSource(src, g)).toBe(false);
  });
});

describe("sourceAllowedForAuth", () => {
  it("device -> mentra_touch, session -> web_demo", () => {
    expect(sourceAllowedForAuth("device", "mentra_touch")).toBe(true);
    expect(sourceAllowedForAuth("device", "web_demo")).toBe(false);
    expect(sourceAllowedForAuth("session", "web_demo")).toBe(true);
    expect(sourceAllowedForAuth("session", "mentra_touch")).toBe(false);
  });
  it("session may send headset_remote; a device token may not", () => {
    expect(sourceAllowedForAuth("session", "headset_remote")).toBe(true);
    expect(sourceAllowedForAuth("device", "headset_remote")).toBe(false);
  });
});

describe("orderPair", () => {
  const lo = "00000000-0000-4000-8000-000000000001";
  const hi = "ffffffff-0000-4000-8000-000000000001";
  it("orders either way identically", () => {
    expect(orderPair(lo, hi)).toEqual({ userA: lo, userB: hi });
    expect(orderPair(hi, lo)).toEqual({ userA: lo, userB: hi });
  });
});
