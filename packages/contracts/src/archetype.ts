import { z } from "zod";

/**
 * Personality cards and the character ("archetype") derived from them.
 *
 * The character is chosen by fixed rules, never by a model: every card (and,
 * lightly, each MBTI letter) carries weights toward characters, the highest
 * total wins, and ties go to the earlier entry in ARCHETYPE_IDS. The same picks
 * therefore always give the same character.
 */

export const ARCHETYPE_IDS = [
  "night_owl",
  "guardian",
  "wanderer",
  "spark",
  "dreamer",
  "anchor",
  "storyteller",
  "explorer",
  "homebody",
  "maverick",
  "muse",
  "sage",
] as const;
export const ArchetypeId = z.enum(ARCHETYPE_IDS);
export type ArchetypeId = z.infer<typeof ArchetypeId>;

export interface Archetype {
  id: ArchetypeId;
  /** Shown as written, e.g. "The Night Owl". */
  name: string;
  /** One line about the character, written to the person. */
  tagline: string;
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  night_owl: { id: "night_owl", name: "The Night Owl", tagline: "You come alive when the city goes quiet." },
  guardian: { id: "guardian", name: "The Guardian", tagline: "You look after your people, and they know it." },
  wanderer: { id: "wanderer", name: "The Wanderer", tagline: "You'd rather take the long way and see what's there." },
  spark: { id: "spark", name: "The Spark", tagline: "You walk in and the room gets warmer." },
  dreamer: { id: "dreamer", name: "The Dreamer", tagline: "You notice what could be, not only what is." },
  anchor: { id: "anchor", name: "The Anchor", tagline: "You're steady, and people find their footing around you." },
  storyteller: { id: "storyteller", name: "The Storyteller", tagline: "You turn an ordinary day into something worth retelling." },
  explorer: { id: "explorer", name: "The Explorer", tagline: "You collect trails, summits and first tries." },
  homebody: { id: "homebody", name: "The Homebody", tagline: "Your favourite place is one you've made your own." },
  maverick: { id: "maverick", name: "The Maverick", tagline: "You'd rather find your own way than follow the map." },
  muse: { id: "muse", name: "The Muse", tagline: "You have an eye for beauty and it rubs off on people." },
  sage: { id: "sage", name: "The Sage", tagline: "You listen first, and what you say tends to land." },
};

export const CARD_DECK_IDS = ["music", "weekend", "energy", "loves"] as const;
export const CardDeckId = z.enum(CARD_DECK_IDS);
export type CardDeckId = z.infer<typeof CardDeckId>;

export const CARD_DECK_TITLES: Record<CardDeckId, string> = {
  music: "What you listen to",
  weekend: "Your kind of weekend",
  energy: "Your energy",
  loves: "Things you love",
};

/** A person may pick at most this many cards from each deck. */
export const MAX_CARDS_PER_DECK = 3;

type Weights = Partial<Record<ArchetypeId, number>>;

export interface PersonalityCard {
  /** Stable id stored on the profile, `<deck>.<slug>`. */
  id: string;
  deck: CardDeckId;
  /** Shown on the card and sent to the wingman as evidence text. */
  label: string;
  weights: Weights;
}

const card = (deck: CardDeckId, slug: string, label: string, weights: Weights): PersonalityCard => ({
  id: `${deck}.${slug}`,
  deck,
  label,
  weights,
});

export const PERSONALITY_CARDS: readonly PersonalityCard[] = [
  // Music
  card("music", "indie", "Indie", { dreamer: 2, muse: 1, wanderer: 1 }),
  card("music", "hip-hop", "Hip-hop", { spark: 2, maverick: 2 }),
  card("music", "rnb", "R&B and soul", { muse: 2, night_owl: 1 }),
  card("music", "pop", "Pop", { spark: 2, storyteller: 1 }),
  card("music", "electronic", "Electronic", { night_owl: 3, maverick: 1 }),
  card("music", "jazz", "Jazz", { sage: 2, night_owl: 1, muse: 1 }),
  card("music", "classical", "Classical", { sage: 2, dreamer: 1 }),
  card("music", "rock", "Rock", { maverick: 2, explorer: 1 }),
  card("music", "k-pop", "K-pop", { spark: 2, muse: 1 }),
  card("music", "country", "Country and folk", { storyteller: 2, anchor: 1 }),
  card("music", "latin", "Latin", { spark: 2, wanderer: 1 }),
  card("music", "lo-fi", "Lo-fi", { homebody: 2, dreamer: 1 }),
  // Weekend
  card("weekend", "trails", "On a trail", { explorer: 3, wanderer: 1 }),
  card("weekend", "cafes", "Café hopping", { muse: 1, storyteller: 1, wanderer: 1 }),
  card("weekend", "live-shows", "At a live show", { spark: 1, night_owl: 2 }),
  card("weekend", "staying-in", "Staying in", { homebody: 3 }),
  card("weekend", "road-trip", "Road trip", { wanderer: 3, explorer: 1 }),
  card("weekend", "cooking", "Cooking for people", { guardian: 2, homebody: 1 }),
  card("weekend", "gaming", "Gaming", { homebody: 1, night_owl: 1, maverick: 1 }),
  card("weekend", "museums", "Museums and galleries", { muse: 2, sage: 1 }),
  card("weekend", "gym", "Training", { anchor: 2, explorer: 1 }),
  card("weekend", "night-out", "A night out", { night_owl: 2, spark: 2 }),
  card("weekend", "markets", "Farmers' market", { anchor: 1, guardian: 1, homebody: 1 }),
  card("weekend", "reading", "With a book", { sage: 2, dreamer: 1, homebody: 1 }),
  // Energy
  card("energy", "early-bird", "Early bird", { anchor: 2, explorer: 1 }),
  card("energy", "night-owl", "Night owl", { night_owl: 4 }),
  card("energy", "planner", "Planner", { guardian: 2, anchor: 2 }),
  card("energy", "spontaneous", "Spontaneous", { maverick: 2, wanderer: 2 }),
  card("energy", "deep-talks", "Deep conversations", { sage: 2, dreamer: 1 }),
  card("energy", "big-groups", "The more the merrier", { spark: 3 }),
  card("energy", "one-on-one", "One-on-one", { guardian: 1, sage: 1, homebody: 1 }),
  card("energy", "listener", "Good listener", { sage: 2, guardian: 2 }),
  card("energy", "talker", "Never short of a story", { storyteller: 3, spark: 1 }),
  // Loves
  card("loves", "dogs", "Dogs", { guardian: 2, explorer: 1 }),
  card("loves", "cats", "Cats", { homebody: 2, night_owl: 1 }),
  card("loves", "travel", "Travel", { wanderer: 3 }),
  card("loves", "food", "Good food", { storyteller: 1, guardian: 1, muse: 1 }),
  card("loves", "film", "Film", { storyteller: 2, dreamer: 1 }),
  card("loves", "art", "Art and design", { muse: 3 }),
  card("loves", "books", "Books", { sage: 2, storyteller: 1 }),
  card("loves", "tech", "Building things", { maverick: 2, sage: 1 }),
  card("loves", "outdoors", "The outdoors", { explorer: 3 }),
  card("loves", "fashion", "Style", { muse: 2, spark: 1 }),
  card("loves", "volunteering", "Giving back", { guardian: 3 }),
  card("loves", "sports", "Sport", { anchor: 2, spark: 1 }),
];

const CARDS_BY_ID: ReadonlyMap<string, PersonalityCard> = new Map(PERSONALITY_CARDS.map((c) => [c.id, c]));

export function getCard(id: string): PersonalityCard | undefined {
  return CARDS_BY_ID.get(id);
}

/** Labels for the given card ids, unknown ids dropped, in the order given. */
export function cardLabels(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const c = CARDS_BY_ID.get(id);
    return c ? [c.label] : [];
  });
}

/** Card ids: known, no duplicates, at most MAX_CARDS_PER_DECK per deck. */
export const CardIds = z
  .array(z.string())
  .max(CARD_DECK_IDS.length * MAX_CARDS_PER_DECK)
  .refine((ids) => ids.every((id) => CARDS_BY_ID.has(id)), { message: "unknown personality card" })
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate personality card" })
  .refine(
    (ids) => {
      const perDeck = new Map<string, number>();
      for (const id of ids) {
        const deck = CARDS_BY_ID.get(id)?.deck ?? "";
        perDeck.set(deck, (perDeck.get(deck) ?? 0) + 1);
      }
      return [...perDeck.values()].every((n) => n <= MAX_CARDS_PER_DECK);
    },
    { message: `at most ${MAX_CARDS_PER_DECK} cards per deck` },
  );

/** Light nudges from MBTI letters; cards always dominate. */
const MBTI_WEIGHTS: Record<string, Weights> = {
  E: { spark: 1 },
  I: { sage: 1 },
  N: { dreamer: 1 },
  S: { anchor: 1 },
  T: { maverick: 1 },
  F: { guardian: 1 },
  J: { anchor: 1 },
  P: { wanderer: 1 },
};

/**
 * The character for a set of picks, or null when there are no cards (MBTI
 * alone does not assign one). Deterministic: highest total, ties to the
 * earlier entry in ARCHETYPE_IDS.
 */
export function computeArchetype(cardIds: readonly string[], mbti: string | null = null): ArchetypeId | null {
  const cards = cardIds.flatMap((id) => {
    const c = CARDS_BY_ID.get(id);
    return c ? [c] : [];
  });
  if (cards.length === 0) return null;

  const totals = new Map<ArchetypeId, number>();
  const add = (weights: Weights) => {
    for (const [id, w] of Object.entries(weights) as [ArchetypeId, number][]) {
      totals.set(id, (totals.get(id) ?? 0) + w);
    }
  };
  for (const c of cards) add(c.weights);
  if (mbti) for (const letter of mbti.toUpperCase()) add(MBTI_WEIGHTS[letter] ?? {});

  let best: ArchetypeId | null = null;
  let bestScore = 0;
  for (const id of ARCHETYPE_IDS) {
    const score = totals.get(id) ?? 0;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}
