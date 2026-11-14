import { DEMO_SESSION_CAPACITY } from "@cue/contracts";
import type { InterestGesture, InterestSource } from "@cue/contracts";

export function gestureMatchesSource(source: InterestSource, gesture: InterestGesture): boolean {
  return (
    (source === "mentra_touch" && gesture === "backward_swipe") ||
    (source === "web_demo" && gesture === "web_confirm")
  );
}

/** Glasses devices may only send touch events; browser sessions only the web demo input. */
export function sourceAllowedForAuth(auth: "session" | "device", source: InterestSource): boolean {
  return auth === "device" ? source === "mentra_touch" : source === "web_demo";
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
