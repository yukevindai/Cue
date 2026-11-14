import { describe, expect, it } from "vitest";
import { canJoinSession, expiresAt, gestureMatchesSource, isExpired, orderPair, sourceAllowedForAuth } from "./index";

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
});

describe("sourceAllowedForAuth", () => {
  it("device -> mentra_touch, session -> web_demo", () => {
    expect(sourceAllowedForAuth("device", "mentra_touch")).toBe(true);
    expect(sourceAllowedForAuth("device", "web_demo")).toBe(false);
    expect(sourceAllowedForAuth("session", "web_demo")).toBe(true);
    expect(sourceAllowedForAuth("session", "mentra_touch")).toBe(false);
  });
});

describe("canJoinSession", () => {
  it("allows up to capacity 2", () => {
    expect(canJoinSession(0)).toBe(true);
    expect(canJoinSession(1)).toBe(true);
    expect(canJoinSession(2)).toBe(false);
    expect(canJoinSession(3)).toBe(false);
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
