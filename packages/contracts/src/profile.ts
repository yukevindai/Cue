import { z } from "zod";
import { ArchetypeId, CardIds } from "./archetype";
import { IsoDateTime, Uuid } from "./common";

// ---------------------------------------------------------------------------
// Fixed option lists. The same values are enforced by CHECK constraints in SQL.
// ---------------------------------------------------------------------------

export const GENDERS = ["woman", "man", "non_binary", "other"] as const;
export const Gender = z.enum(GENDERS);
export type Gender = z.infer<typeof Gender>;
export const GENDER_LABELS: Record<Gender, string> = {
  woman: "Woman",
  man: "Man",
  non_binary: "Non-binary",
  other: "Other",
};

export const LOOKING_FOR = ["long_term", "short_term", "casual", "friendship", "open", "unsure"] as const;
export const LookingFor = z.enum(LOOKING_FOR);
export type LookingFor = z.infer<typeof LookingFor>;
export const LOOKING_FOR_LABELS: Record<LookingFor, string> = {
  long_term: "Something long-term",
  short_term: "Something short-term",
  casual: "Something casual",
  friendship: "Friendship first",
  open: "Open to exploring",
  unsure: "Not sure yet",
};

export const EDUCATION_LEVELS = [
  "high_school",
  "some_college",
  "bachelors",
  "masters",
  "doctorate",
  "trade_school",
  "other",
] as const;
export const Education = z.enum(EDUCATION_LEVELS);
export type Education = z.infer<typeof Education>;
export const EDUCATION_LABELS: Record<Education, string> = {
  high_school: "High school",
  some_college: "Some college",
  bachelors: "Bachelor's degree",
  masters: "Master's degree",
  doctorate: "Doctorate",
  trade_school: "Trade school",
  other: "Other",
};

export const MBTI_TYPES = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
] as const;
export const Mbti = z.enum(MBTI_TYPES);
export type Mbti = z.infer<typeof Mbti>;

/** Drinking, smoking, drugs. */
export const HABIT_FREQUENCIES = ["never", "sometimes", "often", "prefer_not_to_say"] as const;
export const HabitFrequency = z.enum(HABIT_FREQUENCIES);
export type HabitFrequency = z.infer<typeof HabitFrequency>;
export const HABIT_FREQUENCY_LABELS: Record<HabitFrequency, string> = {
  never: "Never",
  sometimes: "Sometimes",
  often: "Often",
  prefer_not_to_say: "Prefer not to say",
};

export const MIN_AGE = 18;
export const MAX_AGE = 99;

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * Which optional fields a mutual match may see. Display name is always shared.
 * Every key has a default so rows saved before a key existed still parse; the
 * defaults for sensitive fields are `false`.
 */
export const SharingSettings = z.object({
  photo: z.boolean().default(true),
  bio: z.boolean().default(true),
  interests: z.boolean().default(true),
  age: z.boolean().default(true),
  gender: z.boolean().default(true),
  location: z.boolean().default(true),
  lookingFor: z.boolean().default(true),
  mbti: z.boolean().default(true),
  /** Personality cards and the character derived from them. */
  cards: z.boolean().default(true),
  workOrSchool: z.boolean().default(false),
  education: z.boolean().default(false),
  /** Sensitive. Off unless the person turns it on. Never sent to Claude. */
  ethnicity: z.boolean().default(false),
  /** Sensitive. Off unless the person turns it on. Never sent to Claude. */
  drinking: z.boolean().default(false),
  /** Sensitive. Off unless the person turns it on. Never sent to Claude. */
  smoking: z.boolean().default(false),
  /** Sensitive. Off unless the person turns it on. Never sent to Claude. */
  drugs: z.boolean().default(false),
  /** Allow shared fields, except those in NEVER_SENT_TO_AI, to be sent to Claude for the wingman card. */
  aiAssist: z.boolean().default(true),
});
export type SharingSettings = z.infer<typeof SharingSettings>;

export const DEFAULT_SHARING: SharingSettings = SharingSettings.parse({});

/**
 * Fields that are never sent to Claude, whatever the sharing settings say.
 * The wingman input builder must not read them, and a test asserts it.
 */
export const NEVER_SENT_TO_AI = [
  "age",
  "gender",
  "genderSelfDescribed",
  "ethnicity",
  "drinking",
  "smoking",
  "drugs",
] as const;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v === "" ? null : v));

/**
 * Body of PUT /api/profile. Everything beyond the display name is optional;
 * omitted keys mean "not provided". External social links are not collected:
 * people talk inside Cue.
 */
export const ProfileInput = z.object({
  displayName: z.string().trim().min(1).max(40),
  /** Public URL (Supabase Storage `avatars` bucket) or null. */
  photoUrl: z.url().max(500).nullable(),
  bio: z.string().trim().max(280),
  interests: z.array(z.string().trim().min(1).max(40)).max(12),

  /** Self-declared. Under 18 is rejected. */
  age: z.number().int().min(MIN_AGE).max(MAX_AGE).nullable().default(null),
  gender: Gender.nullable().default(null),
  /** Optional own words, shown instead of the option label when present. */
  genderSelfDescribed: optionalText(40),
  /** City-level, typed in by the person. Never GPS. */
  location: optionalText(60),
  lookingFor: LookingFor.nullable().default(null),
  workOrSchool: optionalText(80),
  education: Education.nullable().default(null),
  mbti: Mbti.nullable().default(null),
  ethnicity: optionalText(60),
  drinking: HabitFrequency.nullable().default(null),
  smoking: HabitFrequency.nullable().default(null),
  drugs: HabitFrequency.nullable().default(null),
  /** Personality card ids (see archetype.ts). */
  cards: CardIds.default([]),

  sharing: SharingSettings,
});
export type ProfileInput = z.infer<typeof ProfileInput>;

/** The signed-in user's own profile (GET/PUT /api/profile). */
export const OwnProfile = ProfileInput.extend({
  userId: Uuid,
  /** Derived from `cards` and `mbti` by the server; null until cards are picked. */
  archetype: ArchetypeId.nullable(),
  /** Increments on every content or sharing change; used for wingman cache keys. */
  version: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
});
export type OwnProfile = z.infer<typeof OwnProfile>;

/**
 * What a matched account may see. Fields the owner did not approve are null /
 * empty and are never sent to the client. Built on the server only.
 */
export const SharedProfile = z.object({
  userId: Uuid,
  displayName: z.string(),
  photoUrl: z.string().nullable(),
  bio: z.string().nullable(),
  interests: z.array(z.string()),
  age: z.number().int().nullable(),
  gender: Gender.nullable(),
  genderSelfDescribed: z.string().nullable(),
  location: z.string().nullable(),
  lookingFor: LookingFor.nullable(),
  workOrSchool: z.string().nullable(),
  education: Education.nullable(),
  mbti: Mbti.nullable(),
  ethnicity: z.string().nullable(),
  drinking: HabitFrequency.nullable(),
  smoking: HabitFrequency.nullable(),
  drugs: HabitFrequency.nullable(),
  /** Personality card ids; empty unless `cards` is shared. */
  cards: z.array(z.string()),
  /** Shared together with the cards. */
  archetype: ArchetypeId.nullable(),
});
export type SharedProfile = z.infer<typeof SharedProfile>;
