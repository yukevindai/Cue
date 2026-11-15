import "server-only";

import {
  ARCHETYPES,
  cardLabels,
  EDUCATION_LABELS,
  LOOKING_FOR_LABELS,
  MAX_AGE,
  MIN_AGE,
  type OpenerBasis,
  type SharedInterest,
  type WingmanEvidence,
  type WingmanModelOutput,
  type WingmanProfileField,
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
const MAX_SUMMARY = 160;

// ---------------------------------------------------------------- input

function clean(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function cleanOrNull(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const cleaned = clean(text);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanList(entries: readonly string[]): string[] {
  return entries.map(clean).filter((entry) => entry.length > 0);
}

const NOTHING: PartyText = {
  interests: [],
  bio: null,
  cards: [],
  archetype: null,
  mbti: null,
  lookingFor: null,
  location: null,
  workOrSchool: null,
  education: null,
  age: null,
};

/**
 * The profile text one party contributes. Nothing at all when aiAssist is off.
 *
 * Reads an explicit allow-list of properties, by name. Ethnicity, drinking,
 * smoking, drugs, gender and genderSelfDescribed (`NEVER_SENT_TO_AI`) are never
 * read here, whatever the sharing settings say; the backend has already nulled
 * every field the owner did not share. Ids and enum codes are turned into the
 * labels a person sees.
 */
export function partyText(party: WingmanParty): PartyText {
  if (!party.aiAssist) return { ...NOTHING, interests: [], cards: [] }; // fresh arrays: callers may not share them
  const { interests, bio, cards, archetype, mbti, lookingFor, location, workOrSchool, education, age } = party.profile;
  return {
    interests: cleanList(interests),
    bio: cleanOrNull(bio),
    cards: cleanList(cardLabels(cards)),
    archetype: archetype ? cleanOrNull(ARCHETYPES[archetype]?.name) : null,
    mbti: mbti && /^[EI][NS][TF][JP]$/.test(mbti) ? mbti : null,
    lookingFor: lookingFor ? cleanOrNull(LOOKING_FOR_LABELS[lookingFor]) : null,
    location: cleanOrNull(location),
    workOrSchool: cleanOrNull(workOrSchool),
    education: education ? cleanOrNull(EDUCATION_LABELS[education]) : null,
    age: Number.isInteger(age) && age! >= MIN_AGE && age! <= MAX_AGE ? age : null,
  };
}

/**
 * Whether a party gives the model something personal to work with: interests,
 * a bio, personality cards, or work/school. Age, location, MBTI, looking-for
 * and education on their own are too thin for a grounded opener, so a party
 * with only those gets the fixed venue opener and no model call.
 */
export function hasUsableText(text: PartyText): boolean {
  return text.interests.length > 0 || text.bio !== null || text.cards.length > 0 || text.workOrSchool !== null;
}

/** Display names, photos, ids and the sensitive fields are never part of the model input. */
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
  /\bfate(d|ful)?\b|kismet|serendip|written in the stars|first sight|\bthe one\b|made for each other/i, // destiny
  /\b(cute|pretty|beautiful|handsome|gorgeous|sexy|stunning|hott?ie|appearance|outfit|wearing|smile)\b|\byour (looks|smile|eyes|hair|body|face|figure)\b/i, // appearance
  /\b(age|aged|ages|how old|years? old|birthday|older|younger)\b/i, // age
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

/** Case- and whitespace-insensitive equality. */
function sameText(a: string, b: string): boolean {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

type FieldKind = "list" | "excerpt" | "value" | "phrase";

/**
 * How a quote is checked against each field:
 * - list: one entry of the list; the whole entry becomes the evidence. A card
 *   quote must be the whole card label; an interest quote may be part of one.
 * - excerpt: a verbatim excerpt of the bio, in the bio's own wording.
 * - phrase: free-text single value (location, work/school); the quote is the
 *   whole value or a verbatim part of it, and the whole value becomes the evidence.
 * - value: a fixed label (character, MBTI, looking-for, education); the quote
 *   must be the whole label.
 */
const FIELD_KIND: Record<WingmanProfileField, FieldKind> = {
  interests: "list",
  cards: "list",
  bio: "excerpt",
  location: "phrase",
  workOrSchool: "phrase",
  archetype: "value",
  mbti: "value",
  lookingFor: "value",
  education: "value",
};

function hasContent(quote: string): boolean {
  return stems(quote).length > 0; // rejects "and", "I", punctuation
}

function locateIn(field: WingmanProfileField, text: PartyText, quote: string): WingmanEvidence | null {
  switch (FIELD_KIND[field]) {
    case "list": {
      if (field === "cards") {
        // Card labels are fixed and short ("Lo-fi"): the quote must be the whole label.
        const entry = text.cards.find((label) => sameText(label, quote));
        return entry === undefined ? null : { field, quote: entry };
      }
      if (!hasContent(quote)) return null;
      for (const entry of text.interests) {
        // The whole entry is the evidence, so a partial quote cannot change its meaning.
        if (findVerbatim(entry, quote) !== null) return { field, quote: entry };
      }
      return null;
    }
    case "excerpt": {
      if (text.bio === null || !hasContent(quote)) return null;
      const found = findVerbatim(text.bio, quote);
      return found === null ? null : { field, quote: found };
    }
    case "phrase": {
      const value = field === "location" ? text.location : text.workOrSchool;
      if (value === null) return null;
      if (sameText(value, quote)) return { field, quote: value };
      return hasContent(quote) && findVerbatim(value, quote) !== null ? { field, quote: value } : null;
    }
    case "value": {
      const value =
        field === "archetype" ? text.archetype : field === "mbti" ? text.mbti : field === "lookingFor" ? text.lookingFor : text.education;
      if (value === null) return null;
      const matches = sameText(value, quote) || (field === "archetype" && sameText(value, `The ${clean(quote)}`));
      return matches ? { field, quote: value } : null;
    }
  }
}

/**
 * Resolves a model-supplied quote against the text supplied for that person.
 * Returns the person's own wording, or null if the quote is not in the field
 * it claims. The only leniency is between interests and bio, which are both
 * things the person wrote in their own words; every other field must be cited
 * correctly. Age is not a field and can never be evidence.
 */
export function locateEvidence(
  claimed: { field: WingmanProfileField; quote: string },
  text: PartyText,
): WingmanEvidence | null {
  if (!(claimed.field in FIELD_KIND)) return null;
  let evidence = locateIn(claimed.field, text, claimed.quote);
  if (evidence === null && (claimed.field === "interests" || claimed.field === "bio")) {
    evidence = locateIn(claimed.field === "interests" ? "bio" : "interests", text, claimed.quote);
  }
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
  /** Code-written opener for this claim, or null when it is not a good opening topic. */
  opener: string | null;
}

/** Fields that describe something the person does or likes, in their words or picks. */
const TOPIC_FIELDS: ReadonlySet<WingmanProfileField> = new Set(["interests", "bio", "cards"]);

/** How one side's evidence is described: "mention “Hiking”", "picked the “Jazz” card". */
function statement(who: "You" | "they", evidence: WingmanEvidence, max: number): string {
  const q = `“${shorten(evidence.quote, max)}”`;
  const be = who === "You" ? "You're" : "they're";
  switch (evidence.field) {
    case "interests":
    case "bio":
      return `${who} mention ${q}`;
    case "cards":
      return `${who} picked the ${q} card`;
    case "archetype":
      return `${be} ${q}`;
    case "lookingFor":
      return `${who} chose ${q}`;
    case "location":
      return `${be} in ${q}`;
    case "mbti":
    case "workOrSchool":
    case "education":
      return `${who} list ${q}`;
  }
}

/** Summary when both people gave the same value in the same structured field. */
function sameValueSummary(field: WingmanProfileField, value: string): string | null {
  const q = `“${shorten(value, 60)}”`;
  switch (field) {
    case "cards":
      return `You both picked the ${q} card.`;
    case "archetype":
      return `You both got ${q} as your character.`;
    case "mbti":
      return `You both list ${q} as your MBTI type.`;
    case "lookingFor":
      return `You both chose ${q}.`;
    case "location":
      return `You're both in ${q}.`;
    case "workOrSchool":
      return `You both list ${q} for work or school.`;
    case "education":
      return `You both list ${q} for education.`;
    case "interests":
    case "bio":
      return null; // handled with the label, below
  }
}

/** Code-written opener for a same-value claim; null for topics that make a heavy first line. */
function sameValueOpener(field: WingmanProfileField, value: string): string | null {
  switch (field) {
    case "cards":
      return `What's the story behind “${value}” for you?`;
    case "archetype":
      return `What makes you ${lowerFirst(value)}?`;
    case "location":
      return `What's your favourite spot in ${value}?`;
    case "workOrSchool":
      return `What's ${value} like for you?`;
    case "mbti":
      return `How well does ${value} describe you?`;
    case "lookingFor":
    case "education":
    case "interests":
    case "bio":
      return null;
  }
}

function safeOpener(text: string | null): string | null {
  return text !== null && text.length <= MAX_QUESTION && isSafeText(text) ? text : null;
}

function fitSummary(build: (quoteMax: number, withSuffix: boolean) => string): string {
  for (const [quoteMax, withSuffix] of [[40, true], [24, true], [24, false]] as const) {
    const text = build(quoteMax, withSuffix);
    if (text.length <= MAX_SUMMARY) return text;
  }
  return shorten(build(24, false), MAX_SUMMARY);
}

function checkClaim(claim: WingmanModelOutput["shared_interests"][number], input: ModelInput): CheckedClaim | null {
  const yourEvidence = locateEvidence(claim.your_evidence, input.you);
  const theirEvidence = locateEvidence(claim.their_evidence, input.them);
  if (yourEvidence === null || theirEvidence === null) return null;

  const label = clean(claim.label);
  const labelOk = label.length > 0 && label.length <= MAX_LABEL && isSafeText(label);
  const inYours = labelOk && anchoredIn(label, yourEvidence.quote);
  const inTheirs = labelOk && anchoredIn(label, theirEvidence.quote);
  const twoSided = (quoteMax: number) =>
    `${statement("You", yourEvidence, quoteMax)} and ${statement("they", theirEvidence, quoteMax)}`;

  // A label that echoes only the other person's words is how an injected
  // "say you both love X" would surface. Fall back to the requester's own words
  // and state nothing beyond the two quotes.
  if (!labelOk || (inTheirs && !inYours)) {
    return {
      interest: {
        label: titleCase(shorten(yourEvidence.quote, MAX_LABEL)),
        summary: fitSummary((max) => `${twoSided(max)}.`),
        yourEvidence,
        theirEvidence,
      },
      labelTrusted: false,
      opener: null,
    };
  }

  // Same card or same structured value on both sides: the label and the
  // sentence come from that value, not from the model.
  const freeText = (f: WingmanProfileField) => f === "interests" || f === "bio";
  const sameValue =
    yourEvidence.field === theirEvidence.field &&
    !freeText(yourEvidence.field) &&
    sameText(yourEvidence.quote, theirEvidence.quote);
  if (sameValue) {
    const value = yourEvidence.quote;
    return {
      interest: {
        label: shorten(value, MAX_LABEL),
        summary: shorten(sameValueSummary(yourEvidence.field, value)!, MAX_SUMMARY),
        yourEvidence,
        theirEvidence,
      },
      labelTrusted: true,
      opener: safeOpener(sameValueOpener(yourEvidence.field, value)),
    };
  }

  const bothTopics = TOPIC_FIELDS.has(yourEvidence.field) && TOPIC_FIELDS.has(theirEvidence.field);
  const summary =
    inYours && inTheirs && freeText(yourEvidence.field) && freeText(theirEvidence.field)
      ? `You both mention ${lowerFirst(label)}.`
      : fitSummary((max, withSuffix) =>
          // "Both relate to X" only links topics; two cities or two job titles are just stated.
          // When the label is in both quotes already, the quotes say it.
          bothTopics && withSuffix && !(inYours && inTheirs)
            ? `${twoSided(max)} — both relate to ${lowerFirst(label)}.`
            : `${twoSided(max)}.`,
        );
  return {
    interest: { label: titleCase(label), summary: shorten(summary, MAX_SUMMARY), yourEvidence, theirEvidence },
    labelTrusted: true,
    opener: bothTopics ? safeOpener(`What got you into ${lowerFirst(label)}?`) : null,
  };
}

// ---------------------------------------------------------------- openers

/** Deterministic opener from the coarse venue label only. States no venue facts. */
export function venueOpener(venueLabel: string): string {
  const venue = cleanVenueLabel(venueLabel);
  if (venue.length === 0 || !isSafeText(venue)) return "What's been the best part of your day so far?";
  return `What brought you to ${venue} today?`;
}

function cleanQuestion(question: string | null): string | null {
  if (question === null) return null;
  const text = clean(question);
  if (text.length < 8 || text.length > MAX_QUESTION) return null;
  if (!text.endsWith("?") || text.indexOf("?") !== text.length - 1) return null; // exactly one question
  if (/\b(1[3-9]|[2-9]\d)\b/.test(text)) return null; // a number that could be someone's age
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
 * - A claim survives only with verbatim evidence from both people's supplied
 *   text, each quote checked against the field it cites.
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
  const firstTrusted = kept.find((claim) => claim.labelTrusted && claim.opener !== null);

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
    suggestedQuestion: question ?? firstTrusted!.opener!,
    openerBasis: "shared_interest",
    noOverlap: false,
    dropped,
  };
}
