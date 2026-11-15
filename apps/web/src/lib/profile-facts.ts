import {
  ARCHETYPES,
  CARD_DECK_IDS,
  CARD_DECK_TITLES_ABOUT_OTHERS,
  EDUCATION_LABELS,
  GENDER_LABELS,
  getCard,
  HABIT_FREQUENCY_LABELS,
  LOOKING_FOR_LABELS,
  type Archetype,
  type CardDeckId,
  type SharedProfile,
} from "@cue/contracts";

export interface Fact {
  key: string;
  label: string;
  value: string;
}

export interface CardGroup {
  deck: CardDeckId;
  title: string;
  labels: string[];
}

export interface SharedFacts {
  character: Archetype | null;
  /** Age, gender, city, what they're looking for. */
  basics: Fact[];
  /** MBTI, work or school, education. */
  about: Fact[];
  cards: CardGroup[];
  /** Ethnicity and habits, only when the person chose to share them. */
  personal: Fact[];
}

/** The text shown for gender: their own words when given, else the option label. */
export function genderText(p: Pick<SharedProfile, "gender" | "genderSelfDescribed">): string | null {
  return p.genderSelfDescribed?.trim() || (p.gender ? GENDER_LABELS[p.gender] : null);
}

/**
 * Turn a SharedProfile into what a person reads. Only present fields produce
 * an entry, so the UI never shows an empty label.
 */
export function sharedFacts(p: SharedProfile): SharedFacts {
  const facts = (entries: [string, string, string | null | undefined][]): Fact[] =>
    entries.flatMap(([key, label, value]) => (value ? [{ key, label, value }] : []));

  const cards: CardGroup[] = CARD_DECK_IDS.flatMap((deck) => {
    const labels = p.cards.flatMap((id) => {
      const c = getCard(id);
      return c && c.deck === deck ? [c.label] : [];
    });
    return labels.length ? [{ deck, title: CARD_DECK_TITLES_ABOUT_OTHERS[deck], labels }] : [];
  });

  return {
    character: p.archetype ? ARCHETYPES[p.archetype] : null,
    basics: facts([
      ["age", "Age", p.age === null ? null : String(p.age)],
      ["gender", "Gender", genderText(p)],
      ["location", "City", p.location],
      ["lookingFor", "Looking for", p.lookingFor ? LOOKING_FOR_LABELS[p.lookingFor] : null],
    ]),
    about: facts([
      ["mbti", "MBTI", p.mbti],
      ["workOrSchool", "Work or school", p.workOrSchool],
      ["education", "Education", p.education ? EDUCATION_LABELS[p.education] : null],
    ]),
    cards,
    personal: facts([
      ["ethnicity", "Ethnicity", p.ethnicity],
      ["drinking", "Drinking", p.drinking ? HABIT_FREQUENCY_LABELS[p.drinking] : null],
      ["smoking", "Smoking", p.smoking ? HABIT_FREQUENCY_LABELS[p.smoking] : null],
      ["drugs", "Drugs", p.drugs ? HABIT_FREQUENCY_LABELS[p.drugs] : null],
    ]),
  };
}

/** A short line for a match card: "29, Oakland". Empty when neither is shared. */
export function ageAndCity(p: Pick<SharedProfile, "age" | "location">): string {
  return [p.age === null ? null : String(p.age), p.location].filter(Boolean).join(", ");
}
