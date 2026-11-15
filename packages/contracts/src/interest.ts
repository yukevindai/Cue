import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

/**
 * Where a signal came from.
 * - `mentra_touch`: the Mentra Live bridge, authenticated with a device token.
 * - `web_demo`: the "Interested" button, authenticated with the web session.
 * - `headset_remote`: a media command (for example a double tap on the temple
 *   of Meta glasses) received by the signed-in web page from whatever Bluetooth
 *   headset is the phone's audio route. Authenticated with the web session. It
 *   shows that a headset sent the command, not which headset it was.
 * - `spectacles_hand`: a hand-tracking gesture recognised by the Cue Lens on
 *   Snap Spectacles (apps/spectacles), authenticated with a device token.
 */
export const InterestSource = z.enum(["mentra_touch", "web_demo", "headset_remote", "spectacles_hand"]);
export type InterestSource = z.infer<typeof InterestSource>;

export const InterestGesture = z.enum([
  "backward_swipe",
  "web_confirm",
  "media_next_track",
  "media_previous_track",
  "media_play_pause",
  /** Two pinches of the same hand in quick succession (Spectacles hand tracking). */
  "double_pinch",
]);
export type InterestGesture = z.infer<typeof InterestGesture>;

/** The gestures each source may carry. The same table is enforced in SQL. */
export const GESTURES_BY_SOURCE: Record<InterestSource, readonly InterestGesture[]> = {
  mentra_touch: ["backward_swipe"],
  web_demo: ["web_confirm"],
  headset_remote: ["media_next_track", "media_previous_track", "media_play_pause"],
  spectacles_hand: ["double_pinch"],
};

/** Sources sent by glasses software with a device token (never with a web session). */
export const DEVICE_SOURCES: readonly InterestSource[] = ["mentra_touch", "spectacles_hand"];

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
    (e) => GESTURES_BY_SOURCE[e.source].includes(e.gesture),
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
