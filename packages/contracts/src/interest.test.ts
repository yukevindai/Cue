import { describe, expect, it } from "vitest";
import { DEVICE_SOURCES, GESTURES_BY_SOURCE, InterestEvent } from "./interest";

const base = {
  eventId: "11111111-1111-4111-8111-111111111111",
  encounterSessionId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-11-15T12:00:00.000Z",
};
const parse = (source: string, gesture: string, extra: Record<string, unknown> = {}) =>
  InterestEvent.safeParse({ ...base, source, gesture, ...extra });

describe("InterestEvent source/gesture pairing", () => {
  it.each(["media_next_track", "media_previous_track", "media_play_pause"])(
    "accepts headset_remote + %s",
    (g) => {
      expect(parse("headset_remote", g).success).toBe(true);
    },
  );
  it("keeps the existing pairs", () => {
    expect(parse("mentra_touch", "backward_swipe").success).toBe(true);
    expect(parse("web_demo", "web_confirm").success).toBe(true);
  });
  it("accepts spectacles_hand + double_pinch", () => {
    expect(parse("spectacles_hand", "double_pinch").success).toBe(true);
  });
  it.each([
    ["headset_remote", "backward_swipe"],
    ["headset_remote", "web_confirm"],
    ["web_demo", "media_next_track"],
    ["mentra_touch", "media_next_track"],
    ["mentra_touch", "media_play_pause"],
    ["web_demo", "backward_swipe"],
    ["spectacles_hand", "backward_swipe"],
    ["spectacles_hand", "media_next_track"],
    ["mentra_touch", "double_pinch"],
    ["headset_remote", "double_pinch"],
    ["web_demo", "double_pinch"],
  ])("rejects %s + %s", (s, g) => {
    expect(parse(s, g).success).toBe(false);
  });
  it("rejects unknown sources and gestures", () => {
    expect(parse("bluetooth", "media_next_track").success).toBe(false);
    expect(parse("headset_remote", "media_stop").success).toBe(false);
  });
  it("is strict: unknown keys (such as a user id) are rejected", () => {
    expect(parse("headset_remote", "media_next_track", { userId: "x" }).success).toBe(false);
    expect(parse("web_demo", "web_confirm", { extra: 1 }).success).toBe(false);
  });
  it("GESTURES_BY_SOURCE lists every source", () => {
    expect(Object.keys(GESTURES_BY_SOURCE).sort()).toEqual(["headset_remote", "mentra_touch", "spectacles_hand", "web_demo"]);
  });
  it("DEVICE_SOURCES are the glasses sources only", () => {
    expect([...DEVICE_SOURCES].sort()).toEqual(["mentra_touch", "spectacles_hand"]);
  });
});
