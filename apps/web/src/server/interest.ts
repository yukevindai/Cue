import "server-only";

import type { InterestAck, InterestEvent, InterestRejectReason } from "@cue/contracts";
import { sourceAllowedForAuth } from "@cue/matching";
import { iso, isoOrNull, rpc } from "@/server/db";
import { bearerToken, requireDevice } from "@/server/devices";
import { requireSessionUser } from "@/server/auth";
import { HttpError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export type InterestCaller = { userId: string; via: "session" | "device" };

/**
 * A request that carries an Authorization header is a device request and must
 * hold a valid device token (it never falls back to cookies). Otherwise the
 * Supabase cookie session is used.
 */
export async function authenticateInterestCaller(req: Request): Promise<InterestCaller> {
  if (bearerToken(req) !== null) {
    const device = await requireDevice(req);
    return { userId: device.userId, via: "device" };
  }
  const user = await requireSessionUser();
  return { userId: user.id, via: "session" };
}

interface SubmitInterestResult {
  status: "accepted" | "duplicate" | "rejected";
  received_at: string;
  expires_at: string | null;
  matched: boolean;
  match_id: string | null;
  reason: InterestRejectReason | null;
}

/**
 * The single matching entry point for glasses and web input. The user id comes
 * from authentication only. The acknowledgement says nothing about the other
 * person except `matched` at the moment a match is created.
 */
export async function submitInterest(
  caller: InterestCaller,
  event: InterestEvent,
): Promise<InterestAck> {
  // The glasses touch source needs the device credential; the web button needs
  // the web session. Neither credential can speak for the other input.
  if (!sourceAllowedForAuth(caller.via, event.source)) {
    throw new HttpError("forbidden", `source ${event.source} is not allowed with this credential`);
  }
  rateLimit(`interest:${caller.userId}`, 30, 10_000);

  const result = await rpc<SubmitInterestResult>("submit_interest", {
    p_user_id: caller.userId,
    p_session_id: event.encounterSessionId,
    p_event_id: event.eventId,
    p_source: event.source,
    p_gesture: event.gesture,
    p_occurred_at: event.occurredAt,
  });

  return {
    status: result.status,
    eventId: event.eventId,
    receivedAt: iso(result.received_at),
    expiresAt: isoOrNull(result.expires_at),
    matched: result.matched,
    reason: result.reason,
  };
}
