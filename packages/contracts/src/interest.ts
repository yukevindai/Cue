import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const InterestSource = z.enum(["mentra_touch", "web_demo"]);
export type InterestSource = z.infer<typeof InterestSource>;

export const InterestGesture = z.enum(["backward_swipe", "web_confirm"]);
export type InterestGesture = z.infer<typeof InterestGesture>;

/**
 * Body of POST /api/interest. Application-owned labels; the server derives the
 * user from authentication and stamps `receivedAt`. Never carries a user id.
 */
export const InterestEvent = z
  .object({
    /** Client-generated idempotency key. Re-sending the same id is a duplicate. */
    eventId: Uuid,
    encounterSessionId: Uuid,
    source: InterestSource,
    gesture: InterestGesture,
    /** Device clock; informational only. The matching window uses server receipt time. */
    occurredAt: IsoDateTime,
  })
  .strict()
  .refine(
    (e) =>
      (e.source === "mentra_touch" && e.gesture === "backward_swipe") ||
      (e.source === "web_demo" && e.gesture === "web_confirm"),
    { message: "gesture does not belong to source" },
  );
export type InterestEvent = z.infer<typeof InterestEvent>;

export const InterestAckStatus = z.enum(["accepted", "duplicate", "rejected"]);
export type InterestAckStatus = z.infer<typeof InterestAckStatus>;

export const InterestRejectReason = z.enum([
  "not_in_session",
  "session_inactive",
  "encounter_mode_off",
  "blocked",
  "already_matched",
  "invalid_event",
]);
export type InterestRejectReason = z.infer<typeof InterestRejectReason>;

/**
 * Response of POST /api/interest (HTTP 200 for all three states).
 * Deliberately says nothing about the other person: `matched` only tells the
 * sender to expect a realtime match update. Full match details arrive through
 * authorized realtime / GET /api/matches.
 */
export const InterestAck = z.object({
  status: InterestAckStatus,
  eventId: Uuid,
  receivedAt: IsoDateTime,
  /** When the pending signal will expire. Present when accepted and not yet matched. */
  expiresAt: IsoDateTime.nullable(),
  /** True when this signal completed a mutual match. */
  matched: z.boolean(),
  reason: InterestRejectReason.nullable(),
});
export type InterestAck = z.infer<typeof InterestAck>;
