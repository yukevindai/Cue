import type { SharedProfile, WingmanSuggestion } from "@cue/contracts";

/** One side of a match as the backend exposes it to the wingman. */
export interface WingmanParty {
  userId: string;
  /** Already reduced to the fields the owner approved for sharing. */
  profile: SharedProfile;
  /** Owner allows the shared fields to be sent to Claude. */
  aiAssist: boolean;
  version: number;
}

/**
 * Return type of `getWingmanMatchContext(matchId, userId)` in
 * `apps/web/src/server/matches.ts` (backend). It throws
 * `HttpError("not_found")` unless the caller participates in the active match.
 */
export interface WingmanMatchContext {
  matchId: string;
  venueLabel: string;
  requester: WingmanParty;
  other: WingmanParty;
  /** Both profile versions + sharing; changes whenever either side edits. */
  cacheKey: string;
}

/**
 * The only profile text that may reach the model for one party. Human-readable
 * text only (card labels, the character name, option labels), never ids or
 * enum codes. Empty / null means "not shared" or "not filled in"; the model
 * cannot tell which. Age, ethnicity, drinking, smoking, drugs and gender have
 * no place here by design.
 */
export interface PartyText {
  interests: string[];
  bio: string | null;
  /** Personality card labels, e.g. "On a trail". */
  cards: string[];
  /** Character name, e.g. "The Night Owl". */
  archetype: string | null;
  mbti: string | null;
  /** Option label, e.g. "Friendship first". */
  lookingFor: string | null;
  location: string | null;
  workOrSchool: string | null;
  /** Option label, e.g. "Bachelor's degree". */
  education: string | null;
}

/** Everything the model is allowed to see. */
export interface ModelInput {
  venueLabel: string;
  you: PartyText;
  them: PartyText;
}

/** What is stored in `wingman_suggestions.payload`. */
export type StoredSuggestion = Omit<WingmanSuggestion, "cached">;
