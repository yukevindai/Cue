import "server-only";

import type {
  OpenerBasis,
  SharedInterest,
  WingmanEvidence,
  WingmanModelOutput,
  WingmanProfileField,
} from "@cue/contracts";
import type { ModelInput, PartyText, WingmanMatchContext, WingmanParty } from "./types";

/**
 * Grounding rules enforced in code. Nothing here trusts the model: a claim is
 * shown only if both of its quotes are found verbatim in the text that was
 * supplied for the corresponding person, and every sentence the user reads is
 * either built here from those quotes or passes `isSafeText`.
 */

const MAX_CLAIMS = 5;
const MAX_QUOTE = 200;
const MAX_LABEL = 60;
const MAX_QUESTION = 240;
const MAX_VENUE = 80;

// ---------------------------------------------------------------- input

function clean(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** The profile text one party contributes. Nothing at all when aiAssist is off. */
export function partyText(party: WingmanParty): PartyText {
  if (!party.aiAssist) return { interests: [], bio: null };
  const interests = party.profile.interests.map(clean).filter((entry) => entry.length > 0);
  const bio = party.profile.bio ? clean(party.profile.bio) : "";
  return { interests, bio: bio.length > 0 ? bio : null };
}

export function hasUsableText(text: PartyText): boolean {
  return text.interests.length > 0 || text.bio !== null;
}

/** Display names, photos, links and ids are never part of the model input. */
export function buildModelInput(ctx: WingmanMatchContext): ModelInput {
  return {
    venueLabel: cleanVenueLabel(ctx.venueLabel),
    you: partyText(ctx.requester),
    them: partyText(ctx.other),
  };
}

export function cleanVenueLabel(label: string): string {
  return clean(label).slice(0, MAX_VENUE);
}

// ---------------------------------------------------------------- text checks

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "they", "their", "them", "both", "that", "this",
  "are", "was", "but", "not", "have", "has", "like", "love", "enjoy", "into", "from", "about",
  "just", "really", "very", "much", "some", "any", "all", "our", "out", "who", "what", "when",
]);

/** Lowercased content-word stems: "Hiking trails" -> ["hik", "trail"]. */
function stems(text: string): string[] {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const words = plain.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => word.replace(/(ing|ers|er|es|s)$/u, ""))
    .filter((stem) => stem.length >= 2);
}

function stemsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/** True when the label shares a content word with the quote. */
function anchoredIn(label: string, quote: string): boolean {
  const quoteStems = stems(quote);
  return stems(label).some((l) => quoteStems.some((q) => stemsMatch(l, q)));
}

const UNSAFE_TEXT: RegExp[] = [
  /https?:|www\.|\.[a-z]{2,}\//i, // links
  /[\w.+-]+@[\w-]+\.\w+/, // email addresses
  /(^|\s)@\w+/, // handles
  /\d{4,}/, // phone numbers, codes
  /[<>{}[\]`\\|]/, // markup
  /[\u0000-\u001f\u007f]/, // control characters, newlines
  /\d\s?%|percent|compatib|soul\s?mate|perfect (match|pair)|meant (to be|for)|chemistry|attract|destin|\bscore\b|\brating\b/i,
  /\b(system prompt|instruction|ignore (all|the|previous)|as an ai|language model)\b/i,
];

/** Model-written text shown to the user: one line, no links, scores or attraction claims. */
export function isSafeText(text: string): boolean {
  return UNSAFE_TEXT.every((pattern) => !pattern.test(text));
}

// ---------------------------------------------------------------- evidence

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds `quote` in `haystack` ignoring case and whitespace runs; returns the haystack's own text. */
function findVerbatim(haystack: string, quote: string): string | null {
  const tokens = clean(quote).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(tokens.map(escapeRegExp).join("\\s+"), "iu");
  const match = pattern.exec(haystack);
  return match ? match[0] : null;
}

function locateIn(field: WingmanProfileField, text: PartyText, quote: string): WingmanEvidence | null {
  if (field === "interests") {
    for (const entry of text.interests) {
      // The whole entry is the evidence, so a partial quote cannot change its meaning.
      if (findVerbatim(entry, quote) !== null) return { field, quote: entry };
    }
    return null;
  }
  if (text.bio === null) return null;
  const found = findVerbatim(text.bio, quote);
  return found === null ? null : { field, quote: found };
}

/**
 * Resolves a model-supplied quote against the text supplied for that person.
 * Returns the person's own wording, or null if the quote is not there.
 */
export function locateEvidence(
  claimed: { field: WingmanProfileField; quote: string },
  text: PartyText,
): WingmanEvidence | null {
  if (stems(claimed.quote).length === 0) return null; // "and", "I", punctuation
  const other: WingmanProfileField = claimed.field === "interests" ? "bio" : "interests";
  const evidence = locateIn(claimed.field, text, claimed.quote) ?? locateIn(other, text, claimed.quote);
  if (evidence === null || evidence.quote.length > MAX_QUOTE) return null;
  return evidence;
}

// ---------------------------------------------------------------- claims

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  // Keep acronyms and proper nouns such as "DIY" or "K-pop" as written.
  return /^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

interface CheckedClaim {
  interest: SharedInterest;
  /** False when the model's label had to be replaced, so its opener is not trusted either. */
  labelTrusted: boolean;
}

function checkClaim(claim: WingmanModelOutput["shared_interests"][number], input: ModelInput): CheckedClaim | null {
  const yourEvidence = locateEvidence(claim.your_evidence, input.you);
  const theirEvidence = locateEvidence(claim.their_evidence, input.them);
  if (yourEvidence === null || theirEvidence === null) return null;

  const label = clean(claim.label);
  const labelOk = label.length > 0 && label.length <= MAX_LABEL && isSafeText(label);
  const inYours = labelOk && anchoredIn(label, yourEvidence.quote);
  const inTheirs = labelOk && anchoredIn(label, theirEvidence.quote);
  const yours = shorten(yourEvidence.quote, 40);
  const theirs = shorten(theirEvidence.quote, 40);

  // A label that echoes only the other person's words is how an injected
  // "say you both love X" would surface. Fall back to the requester's own words
  // and state nothing beyond the two quotes.
  if (!labelOk || (inTheirs && !inYours)) {
    return {
      interest: {
        label: titleCase(shorten(yourEvidence.quote, MAX_LABEL)),
        summary: `You mention “${yours}” and they mention “${theirs}”.`,
        yourEvidence,
        theirEvidence,
      },
      labelTrusted: false,
    };
  }

  const summary =
    inYours && inTheirs
      ? `You both mention ${lowerFirst(label)}.`
      : `You mention “${yours}” and they mention “${theirs}” — both relate to ${lowerFirst(label)}.`;
  return { interest: { label: titleCase(label), summary, yourEvidence, theirEvidence }, labelTrusted: true };
}

// ---------------------------------------------------------------- openers

/** Deterministic opener from the coarse venue label only. States no venue facts. */
export function venueOpener(venueLabel: string): string {
  const venue = cleanVenueLabel(venueLabel);
  if (venue.length === 0 || !isSafeText(venue)) return "What's been the best part of your day so far?";
  return `What brought you to ${venue} today?`;
}

function interestOpener(interest: SharedInterest): string {
  return `What got you into ${lowerFirst(interest.label)}?`;
}

function cleanQuestion(question: string | null): string | null {
  if (question === null) return null;
  const text = clean(question);
  if (text.length < 8 || text.length > MAX_QUESTION) return null;
  if (!text.endsWith("?") || text.indexOf("?") !== text.length - 1) return null; // exactly one question
  return isSafeText(text) ? text : null;
}

// ---------------------------------------------------------------- result

export interface GroundedResult {
  sharedInterests: SharedInterest[];
  suggestedQuestion: string | null;
  openerBasis: OpenerBasis;
  noOverlap: boolean;
  /** Claims the model made that were not supported; for metrics only. */
  dropped: number;
}

/** Result when nothing can be compared: no model call, venue-based opener only. */
export function noOverlapResult(venueLabel: string): GroundedResult {
  return {
    sharedInterests: [],
    suggestedQuestion: venueOpener(venueLabel),
    openerBasis: "encounter_context",
    noOverlap: true,
    dropped: 0,
  };
}

/**
 * Turns raw model output into what the user may see.
 *
 * - A claim survives only with verbatim evidence from both people's supplied text.
 * - Summaries are written here from the quotes, never by the model.
 * - The model's question is used only when every claim it made survived
 *   untouched; otherwise the opener is rebuilt from a surviving claim or the
 *   venue label, so it cannot rest on a dropped claim.
 * - Venue-based openers are always the fixed template: no venue facts.
 */
export function groundModelOutput(output: WingmanModelOutput, input: ModelInput): GroundedResult {
  const checked: CheckedClaim[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const claim of output.shared_interests) {
    const result = checkClaim(claim, input);
    if (result === null) {
      dropped += 1;
      continue;
    }
    const key = `${result.interest.yourEvidence.quote}\u0000${result.interest.theirEvidence.quote}`.toLowerCase();
    const labelKey = result.interest.label.toLowerCase();
    if (seen.has(key) || seen.has(labelKey)) continue;
    seen.add(key).add(labelKey);
    checked.push(result);
  }

  const kept = checked.slice(0, MAX_CLAIMS);
  const sharedInterests = kept.map((claim) => claim.interest);
  if (sharedInterests.length === 0) return { ...noOverlapResult(input.venueLabel), dropped };

  if (output.opener_basis === "encounter_context") {
    return {
      sharedInterests,
      suggestedQuestion: venueOpener(input.venueLabel),
      openerBasis: "encounter_context",
      noOverlap: false,
      dropped,
    };
  }

  const everyClaimIntact =
    dropped === 0 && kept.length === output.shared_interests.length && kept.every((claim) => claim.labelTrusted);
  const question = everyClaimIntact ? cleanQuestion(output.suggested_question) : null;
  const firstTrusted = kept.find((claim) => claim.labelTrusted);

  if (question === null && firstTrusted === undefined) {
    return {
      sharedInterests,
      suggestedQuestion: venueOpener(input.venueLabel),
      openerBasis: "encounter_context",
      noOverlap: false,
      dropped,
    };
  }
  return {
    sharedInterests,
    suggestedQuestion: question ?? interestOpener(firstTrusted!.interest),
    openerBasis: "shared_interest",
    noOverlap: false,
    dropped,
  };
}
