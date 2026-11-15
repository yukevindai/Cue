import { ARCHETYPES, computeArchetype, type WingmanModelOutput } from "@cue/contracts";
import { must } from "./helpers/api";
import { expect, test } from "./helpers/fixtures";
import type { RecordedRequest } from "./helpers/fake-anthropic";
import { matchedPair, type Person, type ProfileOverrides, type World } from "./helpers/scenario";

/**
 * The richer wingman input: card labels, character, MBTI, looking-for, city,
 * work/school and education go to the model when shared and AI assist is on.
 * Age, gender (and own words), ethnicity, drinking, smoking and drugs never do,
 * even when every one of them is shared with the match.
 */

const A_CARDS = ["weekend.trails", "music.indie", "energy.planner"];
const B_CARDS = ["weekend.trails", "music.jazz", "energy.listener"];
const A_AGE = 47;
const B_AGE = 61;

/** Distinctive values in every field that must never reach the model. */
const FORBIDDEN_TEXT = [
  "GENDERWORDS-A",
  "GENDERWORDS-B",
  "ETHNICITY-A",
  "ETHNICITY-B",
  "Non-binary",
  "non_binary",
  "prefer_not_to_say",
  "Prefer not to say",
];

const ALL_SHARED = {
  photo: true,
  bio: true,
  interests: true,
  age: true,
  gender: true,
  location: true,
  lookingFor: true,
  mbti: true,
  cards: true,
  workOrSchool: true,
  education: true,
  ethnicity: true,
  drinking: true,
  smoking: true,
  drugs: true,
  aiAssist: true,
} as const;

function rich(side: "A" | "B"): ProfileOverrides {
  const a = side === "A";
  return {
    bio: a ? "Weekend hiker who likes pour-over coffee." : "Trail runner who loves latte art.",
    interests: a ? ["Hiking", "Coffee"] : ["Hiking", "Latte art"],
    age: a ? A_AGE : B_AGE,
    gender: a ? "non_binary" : "man",
    genderSelfDescribed: `GENDERWORDS-${side}`,
    location: "Oakland",
    lookingFor: a ? "friendship" : "open",
    workOrSchool: a ? "Nurse at a children's hospital" : "Teaches high school chemistry",
    education: a ? "masters" : "bachelors",
    mbti: a ? "INFJ" : "ENFP",
    ethnicity: `ETHNICITY-${side}`,
    drinking: "often",
    smoking: "sometimes",
    drugs: "prefer_not_to_say",
    cards: a ? A_CARDS : B_CARDS,
    sharing: { ...ALL_SHARED },
  };
}

const MODEL_KEYS = ["interests", "bio", "cards", "archetype", "mbti", "lookingFor", "location", "workOrSchool", "education"];

const OUTPUT: WingmanModelOutput = {
  shared_interests: [
    {
      label: "Trails",
      summary: "You both like trails.",
      your_evidence: { field: "cards", quote: "On a trail" },
      their_evidence: { field: "cards", quote: "On a trail" },
    },
    {
      label: "Oakland",
      summary: "You are both in Oakland.",
      your_evidence: { field: "location", quote: "Oakland" },
      their_evidence: { field: "location", quote: "Oakland" },
    },
  ],
  suggested_question: "Which trail around Oakland would you take a friend on first?",
  opener_basis: "shared_interest",
};

interface ModelInput {
  venue_label: string;
  your_profile: Record<string, unknown>;
  their_profile: Record<string, unknown>;
}

/** The JSON document in the user turn of a recorded model request. */
function modelInput(req: RecordedRequest): ModelInput {
  const messages = (req.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  const user = messages.find((m) => m.role === "user");
  if (!user) throw new Error("no user turn in the recorded request");
  const text = Array.isArray(user.content)
    ? user.content.map((b: { text?: string }) => b.text ?? "").join("")
    : String(user.content);
  return JSON.parse(text) as ModelInput;
}

async function richPair(world: World, a: ProfileOverrides = {}, b: ProfileOverrides = {}) {
  return matchedPair(world, { venue: "E2E Test Cafe", a: { ...rich("A"), ...a }, b: { ...rich("B"), ...b } });
}

const edit = (p: Person, patch: ProfileOverrides) =>
  p.api.putProfile({ ...p.profile, ...patch } as Parameters<Person["api"]["putProfile"]>[0]);

function expectNeverSent(req: RecordedRequest): void {
  const input = modelInput(req);
  for (const [who, profile] of [["your_profile", input.your_profile], ["their_profile", input.their_profile]] as const) {
    for (const key of Object.keys(profile)) {
      expect(MODEL_KEYS, `${who} has an unexpected key ${key}`).toContain(key);
    }
  }
  const sent = JSON.stringify(input);
  for (const text of FORBIDDEN_TEXT) expect(req.rawBody, `request must not contain ${text}`).not.toContain(text);
  for (const age of [String(A_AGE), String(B_AGE)]) expect(sent, `age ${age} never goes to the model`).not.toContain(age);
  for (const key of ["age", "gender", "genderSelfDescribed", "ethnicity", "drinking", "smoking", "drugs", "socialLinks"]) {
    expect(req.rawBody, `no "${key}" key`).not.toContain(`"${key}"`);
  }
  // Habit values (A and B both fill them with the same three) are not in the model input either.
  for (const v of ["often", "sometimes"]) expect(sent.toLowerCase()).not.toContain(`"${v}"`);
}

test.describe("wingman: richer input, and what never goes to the model", () => {
  test("the model sees card labels, city, character, MBTI, looking-for, work and education; never age, gender, ethnicity or habits, even when shared", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world);
    await fake.respondWith(OUTPUT);

    const s = must(await pair.a.api.suggestions(matchId), "suggestions");
    expect(s.cached).toBe(false);
    // The label shown is written by code from the quotes, not taken from the model.
    expect(s.sharedInterests.map((x) => x.label)).toEqual(["On a trail", "Oakland"]);

    const calls = await fake.requests();
    expect(calls).toHaveLength(1);
    expectNeverSent(calls[0]);
    const input = modelInput(calls[0]);

    // Both profiles carry the allowed fields, as labels a person would read.
    const aArch = ARCHETYPES[computeArchetype(A_CARDS, "INFJ")!].name;
    const bArch = ARCHETYPES[computeArchetype(B_CARDS, "ENFP")!].name;
    expect(input.your_profile).toMatchObject({
      cards: expect.arrayContaining(["On a trail", "Indie", "Planner"]),
      archetype: aArch,
      mbti: "INFJ",
      lookingFor: "Friendship first",
      location: "Oakland",
      workOrSchool: "Nurse at a children's hospital",
      education: "Master's degree",
      interests: ["Hiking", "Coffee"],
    });
    expect(input.their_profile).toMatchObject({
      cards: expect.arrayContaining(["On a trail", "Jazz", "Good listener"]),
      archetype: bArch,
      mbti: "ENFP",
      lookingFor: "Open to exploring",
      location: "Oakland",
      workOrSchool: "Teaches high school chemistry",
      education: "Bachelor's degree",
    });
    expect(calls[0].rawBody).toContain("On a trail");
    expect(calls[0].rawBody).toContain("Oakland");
    // Ids and card ids are not model input.
    for (const secret of [pair.a.user.id, pair.b.user.id, pair.a.user.email, "weekend.trails", pair.a.displayName, pair.b.displayName]) {
      expect(calls[0].rawBody).not.toContain(secret);
    }
  });

  test("grounded claims about a shared card and a shared city survive validation", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world);
    await fake.respondWith(OUTPUT);
    const s = must(await pair.a.api.suggestions(matchId));
    const labels = s.sharedInterests.map((x) => x.label);
    expect(labels).toEqual(["On a trail", "Oakland"]);
    expect(s.sharedInterests[0].yourEvidence).toMatchObject({ field: "cards", quote: "On a trail" });
    const city = s.sharedInterests.find((x) => x.label === "Oakland")!;
    expect(city.yourEvidence).toMatchObject({ field: "location", quote: "Oakland" });
    expect(city.theirEvidence).toMatchObject({ field: "location", quote: "Oakland" });
  });

  test("the other direction (B asks) holds the same rules", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world);
    await fake.respondWith(OUTPUT);
    must(await pair.b.api.suggestions(matchId));
    const calls = await fake.requests();
    expect(calls).toHaveLength(1);
    expectNeverSent(calls[0]);
    const input = modelInput(calls[0]);
    expect(input.your_profile).toMatchObject({ mbti: "ENFP", location: "Oakland" });
    expect(input.their_profile).toMatchObject({ mbti: "INFJ", location: "Oakland" });
  });
});

test.describe("wingman: sharing changes reach the next request (the cache misses)", () => {
  test("hiding the other person's city, then their cards, removes them from the next model request", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world);
    await fake.respondWith(OUTPUT);

    must(await pair.a.api.suggestions(matchId));
    expect(await fake.requests()).toHaveLength(1);
    expect(must(await pair.a.api.suggestions(matchId)).cached, "same profiles: served from cache").toBe(true);
    expect(await fake.requests()).toHaveLength(1);

    // B hides their city.
    must(await edit(pair.b, { sharing: { ...ALL_SHARED, location: false } }));
    const second = must(await pair.a.api.suggestions(matchId));
    expect(second.cached, "a sharing change must not be served from cache").toBe(false);
    const calls2 = await fake.requests();
    expect(calls2).toHaveLength(2);
    const in2 = modelInput(calls2[1]);
    expect(in2.their_profile).not.toHaveProperty("location");
    expect(in2.your_profile).toHaveProperty("location", "Oakland");
    expect(in2.their_profile).toHaveProperty("cards");
    expectNeverSent(calls2[1]);

    // B also hides their cards and character.
    must(await edit(pair.b, { sharing: { ...ALL_SHARED, location: false, cards: false } }));
    must(await pair.a.api.suggestions(matchId));
    const calls3 = await fake.requests();
    expect(calls3).toHaveLength(3);
    const in3 = modelInput(calls3[2]);
    expect(in3.their_profile).not.toHaveProperty("cards");
    expect(in3.their_profile).not.toHaveProperty("archetype");
    expect(in3.their_profile).toHaveProperty("mbti", "ENFP");

    // And A's own cards: A's side of the input shrinks too.
    must(await edit(pair.a, { sharing: { ...ALL_SHARED, cards: false } }));
    must(await pair.a.api.suggestions(matchId));
    const calls4 = await fake.requests();
    expect(calls4).toHaveLength(4);
    const in4 = modelInput(calls4[3]);
    expect(in4.your_profile).not.toHaveProperty("cards");
    expect(in4.your_profile).not.toHaveProperty("archetype");
    expect(calls4[3].rawBody).not.toContain("Planner");
    expect(calls4[3].rawBody).not.toContain("Good listener");

    // Sharing it again puts it back (one more miss).
    must(await edit(pair.b, { sharing: { ...ALL_SHARED } }));
    must(await pair.a.api.suggestions(matchId));
    const calls5 = await fake.requests();
    expect(calls5).toHaveLength(5);
    expect(modelInput(calls5[4]).their_profile).toHaveProperty("location", "Oakland");
    for (const c of calls5) expectNeverSent(c);
  });

  test("sharing age, gender, ethnicity and habits changes nothing the model sees (and sharing them on or off does not matter)", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world);
    await fake.respondWith(OUTPUT);
    must(await pair.a.api.suggestions(matchId));
    const first = modelInput((await fake.requests())[0]);

    // Turning the never-sent fields off yields the same model input.
    must(await edit(pair.b, { sharing: { ...ALL_SHARED, age: false, gender: false, ethnicity: false, drinking: false, smoking: false, drugs: false } }));
    must(await pair.a.api.suggestions(matchId));
    const calls = await fake.requests();
    for (const c of calls) expectNeverSent(c);
    expect(modelInput(calls[calls.length - 1])).toEqual(first);
  });
});

test.describe("wingman: AI assist off means no model call and nothing sent", () => {
  test("the other person's AI assist off: no call; turning it on sends their fields again", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world, {}, { sharing: { ...ALL_SHARED, aiAssist: false } });
    await fake.respondWith(OUTPUT);

    const s = must(await pair.a.api.suggestions(matchId));
    expect(s.noOverlap).toBe(true);
    expect(s.sharedInterests).toEqual([]);
    expect(await fake.requests(), "no model call").toHaveLength(0);

    must(await edit(pair.b, { sharing: { ...ALL_SHARED, aiAssist: true } }));
    const again = must(await pair.a.api.suggestions(matchId));
    expect(again.cached).toBe(false);
    const calls = await fake.requests();
    expect(calls).toHaveLength(1);
    expect(modelInput(calls[0]).their_profile).toHaveProperty("location", "Oakland");
    expectNeverSent(calls[0]);
  });

  test("the requester's AI assist off: no call, and flipping it on and off keeps working", async ({ world, fake }) => {
    const { pair, matchId } = await richPair(world, { sharing: { ...ALL_SHARED, aiAssist: false } });
    await fake.respondWith(OUTPUT);
    const s = must(await pair.a.api.suggestions(matchId));
    expect(s.sharedInterests).toEqual([]);
    expect(await fake.requests()).toHaveLength(0);

    must(await edit(pair.a, { sharing: { ...ALL_SHARED, aiAssist: true } }));
    must(await pair.a.api.suggestions(matchId));
    expect(await fake.requests()).toHaveLength(1);

    must(await edit(pair.a, { sharing: { ...ALL_SHARED, aiAssist: false } }));
    const off = must(await pair.a.api.suggestions(matchId));
    expect(off.sharedInterests, "off again: nothing from the earlier card is served").toEqual([]);
    expect(await fake.requests(), "and no further model call").toHaveLength(1);
  });
});
