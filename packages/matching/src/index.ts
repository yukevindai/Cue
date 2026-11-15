// Pure reference rules mirroring the SQL authority (`submit_signal`). No I/O, no clock reads.
export { expiresAt, isExpired } from "./window";
export { gestureMatchesSource, sourceAllowedForAuth, orderPair } from "./rules";
export {
  EARTH_RADIUS_M,
  distanceM,
  locationUsable,
  presenceReady,
  presenceVenue,
  withinRadius,
} from "./place";
export type { PhoneLocation, Presence, VenueCheckIn } from "./place";
export { decideInterest } from "./decide";
export type { Candidate, InterestDecision, InterestInput, MatchPlace, OwnEvent } from "./decide";
