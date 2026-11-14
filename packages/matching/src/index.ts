// Pure reference rules mirroring the SQL authority (`submit_interest`). No I/O, no clock reads.
export { expiresAt, isExpired } from "./window";
export { gestureMatchesSource, sourceAllowedForAuth, canJoinSession, orderPair } from "./rules";
export { decideInterest } from "./decide";
export type { InterestInput, InterestDecision, OwnEvent } from "./decide";
