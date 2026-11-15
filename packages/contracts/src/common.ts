import { z } from "zod";

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Every non-2xx API response uses this body. */
export const ApiError = z.object({
  error: z.object({
    code: z.enum([
      "unauthenticated",
      "forbidden",
      "not_found",
      "invalid_request",
      "encounter_mode_off",
      "blocked",
      "rate_limited",
      "upstream_timeout",
      "upstream_error",
      "internal",
    ]),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
export type ApiErrorCode = ApiError["error"]["code"];

/** Matching constants. Mirrored in SQL (`submit_signal` and its helpers); change both. */
export const MATCH_WINDOW_SECONDS = 15;
export const GESTURE_DEBOUNCE_MS = 1000;
/**
 * Two phone locations count as the same place when the distance between them,
 * less both reported accuracies, is at most this.
 */
export const MATCH_RADIUS_M = 40;
/** A phone location older than this cannot be matched on. */
export const LOCATION_MAX_AGE_SECONDS = 60;
/** A phone location less accurate than this cannot be matched on. */
export const LOCATION_MAX_ACCURACY_M = 100;
/** How often the open page re-sends its location while encounter mode is on. */
export const LOCATION_REPORT_INTERVAL_MS = 15_000;
/** Coordinates not refreshed for this long are deleted. */
export const LOCATION_RETENTION_MINUTES = 10;
/** A venue check-in lasts this long unless the person leaves first. */
export const CHECK_IN_HOURS = 8;
