import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

/** Profile fields the wingman may cite as evidence. */
export const WingmanProfileField = z.enum(["interests", "bio"]);
export type WingmanProfileField = z.infer<typeof WingmanProfileField>;

/** A verbatim snippet from one profile that supports a claim. */
export const WingmanEvidence = z.object({
  field: WingmanProfileField,
  /** Exact text copied from the profile field (an interest entry or a bio excerpt). */
  quote: z.string().min(1).max(200),
});
export type WingmanEvidence = z.infer<typeof WingmanEvidence>;

export const SharedInterest = z.object({
  /** Short neutral label, e.g. "Hiking" or "Coffee". */
  label: z.string().min(1).max(60),
  /** One sentence shown to the user, e.g. "You both enjoy hiking." */
  summary: z.string().min(1).max(160),
  /** Evidence from the requesting user's profile. */
  yourEvidence: WingmanEvidence,
  /** Evidence from the other person's approved profile. */
  theirEvidence: WingmanEvidence,
});
export type SharedInterest = z.infer<typeof SharedInterest>;

export const OpenerBasis = z.enum(["shared_interest", "encounter_context"]);
export type OpenerBasis = z.infer<typeof OpenerBasis>;

/**
 * Structured output requested from Claude. Wire names are snake_case to match
 * the spec (`shared_interests`, `suggested_question`, `opener_basis`).
 */
export const WingmanModelOutput = z.object({
  shared_interests: z.array(
    z.object({
      label: z.string(),
      summary: z.string(),
      your_evidence: z.object({ field: WingmanProfileField, quote: z.string() }),
      their_evidence: z.object({ field: WingmanProfileField, quote: z.string() }),
    }),
  ),
  suggested_question: z.string().nullable(),
  opener_basis: OpenerBasis,
});
export type WingmanModelOutput = z.infer<typeof WingmanModelOutput>;

/** Response of POST /api/matches/[id]/suggestions, after grounding validation. */
export const WingmanSuggestion = z.object({
  matchId: Uuid,
  sharedInterests: z.array(SharedInterest).max(5),
  /** One optional opening question; null when nothing grounded can be offered. */
  suggestedQuestion: z.string().max(240).nullable(),
  openerBasis: OpenerBasis,
  /** True when no supported overlap was found. */
  noOverlap: z.boolean(),
  generatedAt: IsoDateTime,
  cached: z.boolean(),
});
export type WingmanSuggestion = z.infer<typeof WingmanSuggestion>;
