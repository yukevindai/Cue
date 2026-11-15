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
 */
export const InterestSource = z.enum(["mentra_touch", "web_demo", "headset_remote"]);
export type InterestSource = z.infer<typeof InterestSource>;

export const InterestGesture = z.enum([
  "backward_swipe",
  "web_confirm",
  "media_next_track",
  "media_previous_track",
  "media_play_pause",
]);
export type InterestGesture = z.infer<typeof InterestGesture>;

/** The gestures each source may carry. The same table is enforced in SQL. */
export const GESTURES_BY_SOURCE: Record<InterestSource, readonly InterestGesture[]> = {
  mentra_touch: ["backward_swipe"],
  web_demo: ["web_confirm"],
  headset_remote: ["media_next_track", "media_previous_track", "media_play_pause"],
};

/**
 * Body of POST /api/interest. Application-owned labels; the server derives the
 * user from authentication, their place from their presence (venue check-in or
 * phone location), and stamps `receivedAt`. Never carries a user id, a place
 * or coordinates.
 */
export const InterestEvent = z
  .object({
    /** Client-generated idempotency key. Re-sending the same id is a duplicate. */
    eventId: Uuid,
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

/**
 * - `encounter_mode_off`: the sender has encounter mode off.
 * - `no_place`: Cue does not know where the sender is: no venue check-in and
 *   no fresh, accurate phone location.
 * Blocks and existing matches are never a reason: such people are simply not
 * candidates, so neither is disclosed.
 */
export const InterestRejectReason = z.enum(["encounter_mode_off", "no_place", "invalid_event"]);
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
