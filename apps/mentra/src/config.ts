/**
 * THE gesture mapping. This is the single value that decides which raw
 * touch-strip gesture means "interested".
 *
 * `backward_swipe` is the name Mentra's firmware driver gives to touch code 5
 * on Mentra Live (@mentra/bluetooth-sdk 3.4.0, sgcs/MentraLive.kt
 * `mapK900GestureType`; the miniapp host forwards the same string as
 * `TouchData.kind`). The NAME is verified in the SDK source. That this name is
 * physically "finger moving toward the ear" on the loaner is NOT verified: no
 * Mentra source states the physical direction. Confirm it with calibration
 * mode (docs/hardware-check.md, step 5) and record the result there.
 *
 * To change it without a rebuild, use "Use as backward swipe" in the miniapp
 * UI, which stores an override under STORAGE_KEYS.backwardGesture. Set it to
 * null to disable submission entirely.
 */
export const DEFAULT_BACKWARD_SWIPE_GESTURE_NAME: string | null = "backward_swipe";

/** Gesture names Mentra Live can report (reference only; never used for matching). */
export const MENTRA_LIVE_GESTURE_NAMES = [
  "single_tap",
  "double_tap",
  "triple_tap",
  "long_press",
  "forward_swipe",
  "backward_swipe",
  "up_swipe",
  "down_swipe",
] as const;

export const STORAGE_KEYS = {
  deviceToken: "cue.deviceToken",
  serverUrl: "cue.serverUrl",
  backwardGesture: "cue.backwardGesture",
  calibration: "cue.calibration",
} as const;

/** Stored value meaning "submission disabled" for STORAGE_KEYS.backwardGesture. */
export const BACKWARD_GESTURE_DISABLED = "__none__";

export const DEVICE_LABEL = "Mentra Live";

/** Accepts only http(s) origins; returns the normalized origin or null. */
export function normalizeServerUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/?#]+(:\d+)?$/i.test(trimmed)) return null;
  return trimmed;
}
