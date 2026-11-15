/**
 * Every constant the Cue Lens depends on, in one file.
 *
 * Core/ is plain TypeScript with no Lens Studio globals and no npm imports, so
 * it compiles both inside Lens Studio and under Node (vitest). The wire values
 * below mirror `@cue/contracts`; `test/contract-parity.test.ts` fails if they
 * drift.
 */

/** `InterestEvent.source` for this client (GESTURES_BY_SOURCE in contracts, SQL interest_pair_ok). */
export const SOURCE = "spectacles_hand" as const;
/** `InterestEvent.gesture` for this client. */
export const GESTURE = "double_pinch" as const;

/** Sent on POST /api/devices/claim; the web app shows it and uses it to pick the gesture hint. */
export const DEVICE_LABEL = "Snap Spectacles";

/** API paths (mirror `routes` in packages/contracts/src/routes.ts). */
export const ROUTES = {
  deviceClaim: "/api/devices/claim",
  deviceMe: "/api/devices/me",
  interest: "/api/interest",
} as const;

/**
 * Double pinch: two pinch-downs of the SAME hand, the second starting within
 * this many ms of the first. A single pinch is how Spectacles users select
 * things, so one pinch alone must never send a signal.
 */
export const DOUBLE_PINCH_WINDOW_MS = 450;
/** Two pinch-downs closer than this are treated as tracking jitter, not two pinches. */
export const DOUBLE_PINCH_MIN_GAP_MS = 60;
/** Pinch-downs reported below this tracking confidence are ignored. */
export const MIN_PINCH_CONFIDENCE = 0.5;

/** After one accepted gesture, further ones are dropped for this long (GESTURE_DEBOUNCE_MS). */
export const GESTURE_DEBOUNCE_MS = 1000;

/** How often GET /api/devices/me is polled, and how old an answer may be before gestures are dropped. */
export const CONTEXT_REFRESH_INTERVAL_MS = 2000;
export const CONTEXT_MAX_AGE_MS = 6000;

/** Per-attempt HTTP timeout, retry waits and overall budget for one interest submit. */
export const REQUEST_TIMEOUT_MS = 2000;
export const RETRY_BACKOFF_MS = [300, 700] as const;
export const SUBMIT_BUDGET_MS = 4000;

/** How long a feedback message stays on the display before the status line returns. */
export const FEEDBACK_DISPLAY_MS = 2500;

/** Persistent storage keys. The token is the only secret the Lens keeps. */
export const STORAGE_KEYS = {
  deviceToken: "cue.deviceToken",
} as const;
