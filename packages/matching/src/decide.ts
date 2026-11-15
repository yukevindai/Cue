import type { InterestGesture, InterestRejectReason, InterestSource } from "@cue/contracts";
import { distanceM, locationUsable, presenceVenue, withinRadius, type Presence } from "./place";
import { gestureMatchesSource, orderPair } from "./rules";
import { expiresAt, isExpired } from "./window";

/** One of the caller's prior signals (event ids are unique per user). */
export type OwnEvent = {
  eventId: string;
  status: "pending" | "consumed" | "expired" | "cancelled";
  receivedAt: Date;
  expiresAt: Date;
};

/** Another person who has a pending signal. */
export type Candidate = {
  userId: string;
  presence: Presence;
  pendingSignal: { receivedAt: Date; expiresAt: Date };
  /** A block exists between them and the caller, in either direction. */
  blocked: boolean;
  activeMatchWithCaller: boolean;
};

export type InterestInput = {
  now: Date;
  userId: string;
  event: { eventId: string; source: InterestSource; gesture: InterestGesture };
  /** The caller's `user_presence` row, or null when there is none. */
  presence: Presence | null;
  ownEvents: OwnEvent[];
  /** Everyone else with a pending signal (the decision filters them). */
  candidates: Candidate[];
};

/** Where the two matched: the shared venue, or two nearby phones ("Nearby"). */
export type MatchPlace = { kind: "venue"; venueId: string } | { kind: "nearby" };

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
      otherUserId: string;
      place: MatchPlace;
    };

const reject = (reason: InterestRejectReason): InterestDecision => ({ status: "rejected", reason });

/**
 * Reference for SQL `submit_signal`: same checks, same order, same outcomes.
 *
 * A signal pairs with the closest other person who has an unexpired pending
 * signal and is in the same place (same valid venue, or both usable locations
 * within MATCH_RADIUS_M after both accuracies). Closest = by distance when
 * both are located, otherwise the most recent signal. Blocked and
 * already-matched pairs are simply never candidates.
 */
export function decideInterest(input: InterestInput): InterestDecision {
  const { now, userId, event, presence } = input;

  if (!gestureMatchesSource(event.source, event.gesture)) return reject("invalid_event");

  // Idempotency first, so a retry keeps answering truthfully after mode or place changes.
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

  if (!presence || !presence.encounterMode) return reject("encounter_mode_off");

  const myVenue = presenceVenue(presence, now);
  const myLocation = locationUsable(presence.location, now) ? presence.location : null;
  if (myVenue === null && myLocation === null) return reject("no_place");

  // One gesture: an unexpired pending signal of ours (an expired one does not count).
  const pending = input.ownEvents.find((e) => e.status === "pending" && !isExpired(e, now));
  if (pending) {
    return { status: "duplicate", receivedAt: pending.receivedAt, expiresAt: pending.expiresAt, matched: false };
  }

  type Ranked = { c: Candidate; shared: boolean; distance: number | null };
  const ranked: Ranked[] = [];
  for (const c of input.candidates) {
    if (c.userId === userId || c.blocked || c.activeMatchWithCaller) continue;
    if (!c.presence.encounterMode || isExpired(c.pendingSignal, now)) continue;
    const shared = myVenue !== null && presenceVenue(c.presence, now) === myVenue;
    const theirLocation = locationUsable(c.presence.location, now) ? c.presence.location : null;
    const bothLocated = myLocation !== null && theirLocation !== null;
    if (!shared && !(bothLocated && withinRadius(myLocation, theirLocation))) continue;
    const distance = bothLocated
      ? distanceM(myLocation.lat, myLocation.lng, theirLocation.lat, theirLocation.lng)
      : null;
    ranked.push({ c, shared, distance });
  }

  // Distance ascending (no distance last), then most recent signal first.
  ranked.sort((x, y) => {
    if (x.distance !== y.distance) {
      if (x.distance === null) return 1;
      if (y.distance === null) return -1;
      return x.distance - y.distance;
    }
    return y.c.pendingSignal.receivedAt.getTime() - x.c.pendingSignal.receivedAt.getTime();
  });

  const best = ranked[0];
  if (best) {
    return {
      status: "accepted",
      matched: true,
      receivedAt: now,
      firstSignalAt: best.c.pendingSignal.receivedAt,
      pair: orderPair(userId, best.c.userId),
      otherUserId: best.c.userId,
      place: best.shared && myVenue !== null ? { kind: "venue", venueId: myVenue } : { kind: "nearby" },
    };
  }

  return { status: "accepted", matched: false, receivedAt: now, expiresAt: expiresAt(now) };
}
