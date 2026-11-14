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
      "session_full",
      "not_in_session",
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

/** Matching constants. Proposed defaults from the spec; change here only. */
export const MATCH_WINDOW_SECONDS = 15;
export const GESTURE_DEBOUNCE_MS = 1000;
export const DEMO_SESSION_CAPACITY = 2;
