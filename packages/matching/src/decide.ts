import type { InterestGesture, InterestRejectReason, InterestSource } from "@cue/contracts";
import { gestureMatchesSource, orderPair } from "./rules";
import { expiresAt, isExpired } from "./window";

/** Reference for SQL `submit_interest`: same checks, same order, same outcomes. */
export type OwnEvent = {
  eventId: string;
  sessionId: string;
  status: "pending" | "consumed" | "expired" | "cancelled";
  receivedAt: Date;
  expiresAt: Date;
};

export type InterestInput = {
  now: Date;
  userId: string;
  sessionId: string;
  event: { eventId: string; source: InterestSource; gesture: InterestGesture };
  session: { status: "active" | "ended" } | null;
  /** Caller's active (not left) membership in `sessionId`. */
  member: { encounterMode: boolean } | null;
  /** Caller's prior events (any session; event ids are unique per user). */
  ownEvents: OwnEvent[];
  /** The sole other active member, if any. `pendingSignal` is their pending event in this session. */
  other: null | {
    userId: string;
    blockedByCaller: boolean;
    blocksCaller: boolean;
    activeMatchWithCaller: boolean;
    pendingSignal: { receivedAt: Date; expiresAt: Date } | null;
  };
};

export type InterestDecision =
  | { status: "rejected"; reason: InterestRejectReason }
  | { status: "duplicate"; receivedAt: Date; expiresAt: Date | null; matched: boolean }
  | { status: "accepted"; matched: false; receivedAt: Date; expiresAt: Date }
  | {
      status: "accepted";
      matched: true;
      receivedAt: Date;
      firstSignalAt: Date;
      pair: { userA: string; userB: string };
    };

const reject = (reason: InterestRejectReason): InterestDecision => ({ status: "rejected", reason });

export function decideInterest(input: InterestInput): InterestDecision {
  const { now, userId, event, session, member, other } = input;

  if (!gestureMatchesSource(event.source, event.gesture)) return reject("invalid_event");

  // A missing session looks exactly like a non-member (no existence leak).
  if (!member || !session) return reject("not_in_session");

  // Idempotency comes before session/encounter checks, so a retry of an
  // accepted event keeps answering truthfully even after the session ends.
  const prior = input.ownEvents.find((e) => e.eventId === event.eventId);
  if (prior) {
    const stillPending = prior.status === "pending" && !isExpired(prior, now);
    return {
      status: "duplicate",
      receivedAt: prior.receivedAt,
      expiresAt: stillPending ? prior.expiresAt : null,
      matched: prior.status === "consumed",
    };
  }

  if (session.status !== "active") return reject("session_inactive");
  if (!member.encounterMode) return reject("encounter_mode_off");

  // One gesture: an unexpired pending signal of ours (an expired one does not count).
  const pending = input.ownEvents.find(
    (e) => e.sessionId === input.sessionId && e.status === "pending" && !isExpired(e, now),
  );
  if (pending) {
    return { status: "duplicate", receivedAt: pending.receivedAt, expiresAt: pending.expiresAt, matched: false };
  }

  if (other) {
    if (other.blockedByCaller) return reject("blocked");
    if (other.activeMatchWithCaller) return reject("already_matched");

    // If they blocked us, accept but never match: the block is not disclosed.
    if (!other.blocksCaller && other.pendingSignal && !isExpired(other.pendingSignal, now)) {
      return {
        status: "accepted",
        matched: true,
        receivedAt: now,
        firstSignalAt: other.pendingSignal.receivedAt,
        pair: orderPair(userId, other.userId),
      };
    }
  }

  return { status: "accepted", matched: false, receivedAt: now, expiresAt: expiresAt(now) };
}
