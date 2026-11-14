import { GESTURE_DEBOUNCE_MS } from "@cue/contracts";

/**
 * Raw touch-strip events, as delivered by a Mentra runtime, and the one
 * decision this app makes about them: is this THE backward swipe?
 *
 * Nothing here imports a Mentra SDK. The SDK binding hands whatever object it
 * receives to `normalizeTouchEvent`.
 */
export interface RawTouchEvent {
  /** Gesture name exactly as the runtime reported it (never rewritten). */
  gestureName: string;
  /** Runtime-supplied event time in epoch ms, if the payload carried one. */
  timestampMs: number | null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything before year 2001 in ms is taken as seconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string" && value.length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toEpochMs(asNumber);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Accepts the payload shapes Mentra runtimes use for a touch event
 * (`gestureName` from the Bluetooth SDK, which the miniapp host forwards and
 * also copies to `kind`, the only field @mentra/miniapp types; `gesture_name`
 * in the retired cloud SDK) and returns null for anything else.
 */
export function normalizeTouchEvent(input: unknown): RawTouchEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const name = record.gestureName ?? record.gesture_name ?? record.kind;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  return {
    gestureName: name.trim(),
    timestampMs: toEpochMs(record.timestamp ?? record.timestampMs ?? null),
  };
}

/**
 * The gesture mapping: ONE explicit value. `backwardSwipeGestureName` is the
 * raw gesture name that, on the tested unit, is a finger moving along the
 * temple toward the ear. `null` means "not calibrated": nothing is submitted.
 * See `config.ts` for where the value comes from and docs/hardware-check.md
 * for how to confirm it on the device.
 */
export interface GestureMapping {
  backwardSwipeGestureName: string | null;
}

export type GestureClass = "backward_swipe" | "other";

/** Exact, case-sensitive match. No aliases, no fuzzy matching, no direction inference. */
export function classifyGesture(raw: RawTouchEvent, mapping: GestureMapping): GestureClass {
  return mapping.backwardSwipeGestureName !== null && raw.gestureName === mapping.backwardSwipeGestureName
    ? "backward_swipe"
    : "other";
}

/** Leading-edge debounce: after one accepted gesture, further ones are dropped for `windowMs`. */
export class Debouncer {
  private lastAcceptedAt: number | null = null;

  constructor(private readonly windowMs: number = GESTURE_DEBOUNCE_MS) {}

  tryAccept(nowMs: number): boolean {
    if (this.lastAcceptedAt !== null && nowMs - this.lastAcceptedAt < this.windowMs) return false;
    this.lastAcceptedAt = nowMs;
    return true;
  }
}
