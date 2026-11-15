import {
  computeArchetype,
  DEFAULT_SHARING,
  getCard,
  MAX_AGE,
  MAX_CARDS_PER_DECK,
  MIN_AGE,
  NEVER_SENT_TO_AI,
  ProfileInput,
  type CardDeckId,
  type Education,
  type Gender,
  type HabitFrequency,
  type LookingFor,
  type Mbti,
  type OwnProfile,
  type SharedProfile,
  type SharingSettings,
} from "@cue/contracts";

/**
 * The profile editor's state and the pure rules around it: validation phrased
 * for people, a dirty-check key, and an exact mirror of what the server builds
 * for a match (`toSharedProfile`), so the preview never promises more or less
 * than a match will actually get.
 */

export interface FormState {
  displayName: string;
  photoUrl: string | null;
  bio: string;
  interests: string[];
  /** Kept as typed; parsed on validate. */
  age: string;
  gender: Gender | null;
  genderSelfDescribed: string;
  location: string;
  lookingFor: LookingFor | null;
  workOrSchool: string;
  education: Education | null;
  mbti: Mbti | null;
  ethnicity: string;
  drinking: HabitFrequency | null;
  smoking: HabitFrequency | null;
  drugs: HabitFrequency | null;
  cards: string[];
  sharing: SharingSettings;
}

export const LIMITS = {
  name: 40,
  bio: 280,
  interests: 12,
  interest: 40,
  genderWords: 40,
  location: 60,
  workOrSchool: 80,
  ethnicity: 60,
} as const;

export function emptyForm(): FormState {
  return {
    displayName: "",
    photoUrl: null,
    bio: "",
    interests: [],
    age: "",
    gender: null,
    genderSelfDescribed: "",
    location: "",
    lookingFor: null,
    workOrSchool: "",
    education: null,
    mbti: null,
    ethnicity: "",
    drinking: null,
    smoking: null,
    drugs: null,
    cards: [],
    sharing: { ...DEFAULT_SHARING },
  };
}

export function formFromProfile(p: OwnProfile): FormState {
  return {
    displayName: p.displayName,
    photoUrl: p.photoUrl,
    bio: p.bio,
    interests: [...p.interests],
    age: p.age === null ? "" : String(p.age),
    gender: p.gender,
    genderSelfDescribed: p.genderSelfDescribed ?? "",
    location: p.location ?? "",
    lookingFor: p.lookingFor,
    workOrSchool: p.workOrSchool ?? "",
    education: p.education,
    mbti: p.mbti,
    ethnicity: p.ethnicity ?? "",
    drinking: p.drinking,
    smoking: p.smoking,
    drugs: p.drugs,
    cards: [...p.cards],
    sharing: { ...DEFAULT_SHARING, ...p.sharing },
  };
}

const text = (v: string): string | null => {
  const t = v.trim();
  return t === "" ? null : t;
};

/** Age as typed: "" is not given, digits are a number, anything else is kept for an error. */
export function parseAge(raw: string): number | null | "invalid" {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,3}$/.test(t)) return "invalid";
  return Number(t);
}

/** The body a save would send, before schema validation. Never includes an archetype. */
export function toDraft(f: FormState) {
  const age = parseAge(f.age);
  return {
    displayName: f.displayName,
    photoUrl: f.photoUrl,
    bio: f.bio,
    interests: f.interests,
    age: typeof age === "number" ? age : null,
    gender: f.gender,
    genderSelfDescribed: text(f.genderSelfDescribed),
    location: text(f.location),
    lookingFor: f.lookingFor,
    workOrSchool: text(f.workOrSchool),
    education: f.education,
    mbti: f.mbti,
    ethnicity: text(f.ethnicity),
    drinking: f.drinking,
    smoking: f.smoking,
    drugs: f.drugs,
    cards: f.cards,
    sharing: f.sharing,
  };
}

/** Stable string of what would be saved; used for the dirty check. */
export function draftKey(f: FormState): string {
  const d = toDraft(f);
  return JSON.stringify({
    ...d,
    displayName: d.displayName.trim(),
    bio: d.bio.trim(),
    age: f.age.trim(),
    cards: [...d.cards].sort(),
  });
}

export type FieldErrors = Record<string, string>;

/** Validate with the contract schema and phrase every issue for a person. */
export function validateForm(f: FormState): { input: ProfileInput | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const put = (key: string, msg: string) => {
    errors[key] ??= msg;
  };

  const age = parseAge(f.age);
  if (age === "invalid") put("age", "Enter your age as a number, like 27.");
  else if (age !== null && age < MIN_AGE)
    put("age", `Cue is only for adults, ${MIN_AGE} and over. Leave this empty if you'd rather not say.`);
  else if (age !== null && age > MAX_AGE) put("age", `Enter an age from ${MIN_AGE} to ${MAX_AGE}.`);

  const parsed = ProfileInput.safeParse(toDraft(f));
  if (parsed.success && Object.keys(errors).length === 0) return { input: parsed.data, errors: {} };

  for (const issue of parsed.success ? [] : parsed.error.issues) {
    const [head, second] = issue.path;
    const tooBig = issue.code === "too_big";
    switch (head) {
      case "displayName":
        put("displayName", tooBig ? `Keep your name to ${LIMITS.name} characters or fewer.` : "Add a name for a match to see.");
        break;
      case "bio":
        put("bio", `Keep your bio to ${LIMITS.bio} characters or fewer.`);
        break;
      case "photoUrl":
        put("photoUrl", "That photo can't be used. Remove it and add it again.");
        break;
      case "interests":
        put(
          "interests",
          typeof second === "number"
            ? `Interests are 1 to ${LIMITS.interest} characters each.`
            : `A profile holds up to ${LIMITS.interests} interests.`,
        );
        break;
      case "age":
        put("age", `Enter an age from ${MIN_AGE} to ${MAX_AGE}.`);
        break;
      case "genderSelfDescribed":
        put("genderSelfDescribed", `Keep this to ${LIMITS.genderWords} characters or fewer.`);
        break;
      case "location":
        put("location", `Keep your city to ${LIMITS.location} characters or fewer.`);
        break;
      case "workOrSchool":
        put("workOrSchool", `Keep this to ${LIMITS.workOrSchool} characters or fewer.`);
        break;
      case "ethnicity":
        put("ethnicity", `Keep this to ${LIMITS.ethnicity} characters or fewer.`);
        break;
      case "cards":
        put("cards", `Pick up to ${MAX_CARDS_PER_DECK} cards from each deck.`);
        break;
      default:
        break;
    }
  }
  if (Object.keys(errors).length === 0) errors.form = "Some of that didn't look right. Check the fields and try again.";
  return { input: null, errors };
}

/** The character the current picks give, exactly as the server will compute it on save. */
export function liveArchetype(f: FormState) {
  return computeArchetype(f.cards, f.mbti);
}

export function cardsInDeck(cards: readonly string[], deck: CardDeckId): string[] {
  return cards.filter((id) => getCard(id)?.deck === deck);
}

/** Toggle one card, refusing a pick that would exceed the per-deck limit. */
export function toggleCard(cards: readonly string[], id: string): string[] {
  if (cards.includes(id)) return cards.filter((c) => c !== id);
  const deck = getCard(id)?.deck;
  if (!deck || cardsInDeck(cards, deck).length >= MAX_CARDS_PER_DECK) return [...cards];
  return [...cards, id];
}

/**
 * Mirror of the server's `toSharedProfile`: display name always, everything
 * else only when its switch is on. `gender` covers the own-words text, and
 * `cards` covers the character.
 */
export function buildShared(f: FormState, userId: string): SharedProfile {
  const s = f.sharing;
  const age = parseAge(f.age);
  const show = <T>(on: boolean, v: T | null): T | null => (on ? v : null);
  return {
    userId,
    displayName: f.displayName.trim(),
    photoUrl: show(s.photo, f.photoUrl),
    bio: show(s.bio, f.bio.trim()),
    interests: s.interests ? f.interests : [],
    age: show(s.age, typeof age === "number" ? age : null),
    gender: show(s.gender, f.gender),
    genderSelfDescribed: show(s.gender, text(f.genderSelfDescribed)),
    location: show(s.location, text(f.location)),
    lookingFor: show(s.lookingFor, f.lookingFor),
    workOrSchool: show(s.workOrSchool, text(f.workOrSchool)),
    education: show(s.education, f.education),
    mbti: show(s.mbti, f.mbti),
    ethnicity: show(s.ethnicity, text(f.ethnicity)),
    drinking: show(s.drinking, f.drinking),
    smoking: show(s.smoking, f.smoking),
    drugs: show(s.drugs, f.drugs),
    cards: s.cards ? f.cards : [],
    archetype: show(s.cards, liveArchetype(f)),
  };
}

export type ShareKey = Exclude<keyof SharingSettings, "aiAssist">;

/** How each shareable field is named in plain sentences ("They will see: ..."). */
export const SHARE_FIELD_NAMES: Record<ShareKey, string> = {
  photo: "photo",
  bio: "bio",
  interests: "interests",
  age: "age",
  gender: "gender",
  location: "city",
  lookingFor: "what you're looking for",
  mbti: "MBTI",
  cards: "cards and character",
  workOrSchool: "work or school",
  education: "education",
  ethnicity: "ethnicity",
  drinking: "drinking",
  smoking: "smoking",
  drugs: "drug use",
};

/** Order used everywhere fields are listed. */
export const SHARE_ORDER: readonly ShareKey[] = [
  "photo",
  "bio",
  "age",
  "gender",
  "location",
  "lookingFor",
  "cards",
  "interests",
  "mbti",
  "workOrSchool",
  "education",
  "ethnicity",
  "drinking",
  "smoking",
  "drugs",
];

export const SENSITIVE_KEYS: readonly ShareKey[] = ["ethnicity", "drinking", "smoking", "drugs"];

/** Whether the person has filled the field in at all. */
export function hasValue(f: FormState, key: ShareKey): boolean {
  switch (key) {
    case "photo":
      return f.photoUrl !== null;
    case "bio":
      return f.bio.trim() !== "";
    case "interests":
      return f.interests.length > 0;
    case "age":
      return typeof parseAge(f.age) === "number";
    case "gender":
      return f.gender !== null || text(f.genderSelfDescribed) !== null;
    case "cards":
      return f.cards.length > 0;
    case "location":
    case "workOrSchool":
    case "ethnicity":
      return text(f[key]) !== null;
    default:
      return f[key] !== null;
  }
}

/**
 * "They will see / They won't see", for every field. A field counts as seen
 * only when it is both shared and filled in, which is exactly when the server
 * returns something for it.
 */
export function shareSummary(f: FormState): { will: string[]; wont: string[] } {
  const will = ["name"];
  const wont: string[] = [];
  for (const key of SHARE_ORDER) {
    const name = SHARE_FIELD_NAMES[key];
    const on = f.sharing[key];
    const has = hasValue(f, key);
    if (on && has) will.push(name);
    else if (on) wont.push(`${name} (not added)`);
    else if (has || !SENSITIVE_KEYS.includes(key)) wont.push(name);
    // A sensitive field that is both hidden and empty is not mentioned at all.
  }
  return { will, wont };
}

const NEVER_AI = new Set<string>(NEVER_SENT_TO_AI);

/**
 * Field names that may be sent to Claude when someone taps "Find common
 * ground": shared, filled in, AI assist on, and never one of the excluded
 * fields. The photo is not model input either.
 */
export function aiSendable(f: FormState): string[] {
  if (!f.sharing.aiAssist) return [];
  return SHARE_ORDER.filter(
    (key) => key !== "photo" && !NEVER_AI.has(key) && f.sharing[key] && hasValue(f, key),
  ).map((key) => SHARE_FIELD_NAMES[key]);
}

/** "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
