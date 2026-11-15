import { describe, expect, it } from "vitest";
import { glassesRecentlySeen, parseAnnounced, parseVoicePref, shouldSpeakHype } from "./wingman-voice";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const device = (lastSeenAt: string | null, linked = true) => ({
  linked,
  deviceId: null,
  deviceLabel: null,
  lastSeenAt,
});

describe("wingman voice", () => {
  it("is on by default", () => {
    expect(parseVoicePref(null)).toBe(true);
    expect(parseVoicePref("on")).toBe(true);
    expect(parseVoicePref("off")).toBe(false);
  });

  it("treats glasses seen under 30 s ago as recent", () => {
    expect(glassesRecentlySeen(device("2026-11-15T17:59:40.000Z"), NOW)).toBe(true);
    expect(glassesRecentlySeen(device("2026-11-15T17:59:30.000Z"), NOW)).toBe(false);
    expect(glassesRecentlySeen(device("2026-11-15T17:59:59.000Z", false), NOW)).toBe(false);
    expect(glassesRecentlySeen(device(null), NOW)).toBe(false);
    expect(glassesRecentlySeen(null, NOW)).toBe(false);
  });

  it("speaks only when on and the glasses won't", () => {
    expect(shouldSpeakHype({ voiceOn: true, device: device(null), nowMs: NOW })).toBe(true);
    expect(shouldSpeakHype({ voiceOn: false, device: null, nowMs: NOW })).toBe(false);
    expect(shouldSpeakHype({ voiceOn: true, device: device("2026-11-15T17:59:50.000Z"), nowMs: NOW })).toBe(false);
  });

  it("parses announced ids defensively", () => {
    expect(parseAnnounced(null)).toEqual([]);
    expect(parseAnnounced("not json")).toEqual([]);
    expect(parseAnnounced('["a", 1, "b"]')).toEqual(["a", "b"]);
  });
});
