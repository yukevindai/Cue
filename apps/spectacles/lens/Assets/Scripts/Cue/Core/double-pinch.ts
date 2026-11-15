import {
  DOUBLE_PINCH_MIN_GAP_MS,
  DOUBLE_PINCH_WINDOW_MS,
  GESTURE_DEBOUNCE_MS,
  MIN_PINCH_CONFIDENCE,
} from "./config";

export type Hand = "left" | "right";

/** One pinch-down as reported by Spectacles hand tracking (GestureModule.getPinchDownEvent). */
export interface PinchDown {
  hand: Hand;
  timestampMs: number;
  /** PinchDownArgs.confidence, 0..1. */
  confidence: number;
}

export interface DoublePinchOptions {
  windowMs?: number;
  minGapMs?: number;
  minConfidence?: number;
}

/**
 * Turns a stream of pinch-downs into double pinches.
 *
 * Rules (each one is a test in test/double-pinch.test.ts):
 * - Two pinch-downs of the same hand, the second within `windowMs` of the
 *   first, are one double pinch. A third pinch does not chain into a second
 *   double pinch: the pair is consumed.
 * - Pinches of different hands never pair (that is two people's worth of
 *   hands in view, or a two-handed UI action, not a signal).
 * - Low-confidence pinch-downs are ignored, and two pinch-downs closer than
 *   `minGapMs` count as one (tracking jitter).
 */
export class DoublePinchDetector {
  private readonly windowMs: number;
  private readonly minGapMs: number;
  private readonly minConfidence: number;
  private pending: { hand: Hand; at: number } | null = null;

  constructor(options: DoublePinchOptions = {}) {
    this.windowMs = options.windowMs ?? DOUBLE_PINCH_WINDOW_MS;
    this.minGapMs = options.minGapMs ?? DOUBLE_PINCH_MIN_GAP_MS;
    this.minConfidence = options.minConfidence ?? MIN_PINCH_CONFIDENCE;
  }

  /** Returns true when this pinch-down completes a double pinch. */
  feed(pinch: PinchDown): boolean {
    if (!(pinch.confidence >= this.minConfidence)) return false;
    const prev = this.pending;
    if (prev !== null && prev.hand === pinch.hand) {
      const gap = pinch.timestampMs - prev.at;
      if (gap >= 0 && gap < this.minGapMs) return false; // jitter: same pinch
      if (gap >= 0 && gap <= this.windowMs) {
        this.pending = null;
        return true;
      }
    }
    this.pending = { hand: pinch.hand, at: pinch.timestampMs };
    return false;
  }

  reset(): void {
    this.pending = null;
  }
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
