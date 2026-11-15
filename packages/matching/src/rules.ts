import { DEMO_SESSION_CAPACITY, GESTURES_BY_SOURCE } from "@cue/contracts";
import type { InterestGesture, InterestSource } from "@cue/contracts";

export function gestureMatchesSource(source: InterestSource, gesture: InterestGesture): boolean {
  return GESTURES_BY_SOURCE[source].includes(gesture);
}

/**
 * Which credential may speak for which input. A device token (the Mentra
 * bridge) may only send its touch source. A browser session may send the web
 * button, or a headset media command that the signed-in page itself received.
 */
export function sourceAllowedForAuth(auth: "session" | "device", source: InterestSource): boolean {
  return auth === "device" ? source === "mentra_touch" : source === "web_demo" || source === "headset_remote";
}

export function canJoinSession(activeMemberCount: number): boolean {
  return activeMemberCount < DEMO_SESSION_CAPACITY;
}

/**
 * Canonical pair order, userA < userB. Postgres compares uuids bytewise, which
 * equals comparing their lowercase hex strings (same length, hex digits and
 * dashes at fixed positions), so plain string comparison agrees with
 * least()/greatest() in SQL. Inputs must be lowercase uuids.
 */
export function orderPair(a: string, b: string): { userA: string; userB: string } {
  return a < b ? { userA: a, userB: b } : { userA: b, userB: a };
}
