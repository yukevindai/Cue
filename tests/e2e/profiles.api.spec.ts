import { randomUUID } from "node:crypto";
import { ARCHETYPE_IDS, computeArchetype, type ProfileInput, type SharedProfile } from "@cue/contracts";
import type { z } from "zod";
import { must } from "./helpers/api";
import { expectNoLeak } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { matchedPair, type Person, type ProfileOverrides } from "./helpers/scenario";

type Body = z.input<typeof ProfileInput>;

const ALL_OFF = {
  photo: false,
  bio: false,
  interests: false,
  age: false,
  gender: false,
  location: false,
  lookingFor: false,
  mbti: false,
  cards: false,
  workOrSchool: false,
  education: false,
  ethnicity: false,
  drinking: false,
  smoking: false,
  drugs: false,
  aiAssist: true,
} as const;
type Toggle = Exclude<keyof typeof ALL_OFF, "aiAssist">;

/** Every optional field filled, with distinctive text where the field is free text. */
function fullProfile(marker: string): ProfileOverrides {
  return {
    photoUrl: `https://example.com/photo-${marker}.png`,
    bio: `BIO-${marker} loves long walks`,
    interests: [`Interest-${marker}`, "Chess"],
    age: 31,
    gender: "non_binary",
    genderSelfDescribed: `GENDERWORDS-${marker}`,
    location: `TOWN-${marker}`,
    lookingFor: "friendship",
    workOrSchool: `WORK-${marker}`,
    education: "masters",
    mbti: "INFJ",
    ethnicity: `ETHNITOWN-${marker}`,
    drinking: "sometimes",
    smoking: "never",
    drugs: "prefer_not_to_say",
    cards: ["music.indie", "weekend.trails", "energy.planner", "loves.dogs"],
  };
}

/** Field of SharedProfile (what the other person sees) -> the toggle that controls it. */
const SHARED_FIELD_TOGGLE: Record<Exclude<keyof SharedProfile, "userId" | "displayName">, Toggle> = {
  photoUrl: "photo",
  bio: "bio",
  interests: "interests",
  age: "age",
  gender: "gender",
  genderSelfDescribed: "gender",
  location: "location",
  lookingFor: "lookingFor",
  workOrSchool: "workOrSchool",
  education: "education",
  mbti: "mbti",
  ethnicity: "ethnicity",
  drinking: "drinking",
  smoking: "smoking",
  drugs: "drugs",
  cards: "cards",
  archetype: "cards",
};
const SHARED_FIELDS = Object.keys(SHARED_FIELD_TOGGLE) as Array<keyof typeof SHARED_FIELD_TOGGLE>;
const TOGGLES = [...new Set(Object.values(SHARED_FIELD_TOGGLE))];

/** The raw string markers that must never appear when their toggle is off. */
function markersFor(toggle: Toggle, marker: string): string[] {
  switch (toggle) {
    case "photo":
      return [`photo-${marker}`];
    case "bio":
      return [`BIO-${marker}`];
    case "interests":
      return [`Interest-${marker}`];
    case "gender":
      return [`GENDERWORDS-${marker}`];
    case "location":
      return [`TOWN-${marker}`];
    case "workOrSchool":
      return [`WORK-${marker}`];
    case "ethnicity":
      return [`ETHNITOWN-${marker}`];
    default:
      return [];
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || (Array.isArray(v) && v.length === 0);
}

/** What B (the owner) has set, and what A (the matched viewer) sees, field by field. */
function expectOnlyShown(
  other: SharedProfile,
  stored: Record<string, unknown>,
  shown: ReadonlySet<Toggle>,
  what: string,
): void {
  for (const field of SHARED_FIELDS) {
    const visible = shown.has(SHARED_FIELD_TOGGLE[field]);
    if (visible) expect(other[field], `${what}: ${field} is visible`).toEqual(stored[field]);
    else expect(isEmpty(other[field]), `${what}: ${field} is hidden (got ${JSON.stringify(other[field])})`).toBe(true);
  }
}

async function matchViews(a: Person, matchId: string): Promise<{ list: SharedProfile; one: SharedProfile; raw: string[] }> {
  const list = await a.api.listMatches();
  const one = await a.api.getMatch(matchId);
  const fromList = must(list, "listMatches").matches.find((m) => m.id === matchId);
  if (!fromList) throw new Error("match missing from list");
  return { list: fromList.other, one: must(one, "getMatch").other, raw: [list.text, one.text] };
}

test.describe("profile round trip and character", () => {
  test("a full profile round-trips; the character is computed by the server", async ({ world }) => {
    const p = await world.person();
    const marker = p.user.marker;
    const body: Body = { ...p.profile, ...fullProfile(marker), sharing: { ...ALL_OFF, bio: true } };
    const saved = must(await p.api.putProfile(body), "putProfile");

    for (const key of Object.keys(fullProfile(marker)) as Array<keyof Body>) {
      expect(saved[key as keyof typeof saved], `PUT echoes ${key}`).toEqual(body[key]);
    }
    expect(saved.sharing.bio).toBe(true);
    expect(saved.sharing.ethnicity).toBe(false);
    expect(saved.archetype).toBe(computeArchetype(body.cards ?? [], body.mbti ?? null));
    expect(saved.archetype).not.toBeNull();

    const got = must(await p.api.getProfile(), "getProfile");
    expect(got).toEqual(saved);
  });

  test("a client-sent archetype is ignored", async ({ world }) => {
    const p = await world.person();
    const cards = ["energy.night-owl", "music.electronic"];
    const real = computeArchetype(cards, null);
    expect(real).toBe("night_owl");
    const forged = ARCHETYPE_IDS.find((id) => id !== real)!;

    const saved = must(await p.api.putProfile({ ...p.profile, cards, archetype: forged } as Body), "putProfile");
    expect(saved.archetype).toBe(real);
    expect(must(await p.api.getProfile()).archetype).toBe(real);

    // Changing the cards changes the character; clearing them clears it.
    const next = must(await p.api.putProfile({ ...p.profile, cards: ["energy.big-groups"], archetype: forged } as Body));
    expect(next.archetype).toBe(computeArchetype(["energy.big-groups"], null));
    const none = must(await p.api.putProfile({ ...p.profile, cards: [], archetype: forged } as Body));
    expect(none.archetype).toBeNull();
  });

  test("MBTI influences the computed character the same way the contract does", async ({ world }) => {
    const p = await world.person();
    const cards = ["weekend.cafes"];
    const saved = must(await p.api.putProfile({ ...p.profile, cards, mbti: "ESFP" }));
    expect(saved.archetype).toBe(computeArchetype(cards, "ESFP"));
  });
});

test.describe("sharing: every field, both directions", () => {
  for (const toggle of TOGGLES) {
    test(`only "${toggle}" on: the match sees exactly its fields; off again hides them`, async ({ world }) => {
      const { pair, matchId } = await matchedPair(world);
      const marker = pair.b.user.marker;
      const filled = fullProfile(marker);
      const baseSharing = { ...ALL_OFF };
      // B fills every field and shares nothing.
      const stored = must(
        await pair.b.api.putProfile({ ...pair.b.profile, ...filled, sharing: baseSharing }),
        "B putProfile (all off)",
      );
      const storedRecord: Record<string, unknown> = {
        ...stored,
        photoUrl: filled.photoUrl,
        archetype: stored.archetype,
      };
      expect(stored.archetype).not.toBeNull();

      const allOff = await matchViews(pair.a, matchId);
      for (const v of [allOff.list, allOff.one]) expectOnlyShown(v, storedRecord, new Set(), "all off");
      expectNoLeak(allOff.raw, Object.fromEntries(TOGGLES.flatMap((t) => markersFor(t, marker)).map((m) => [m, m])));
      expect(allOff.list.displayName, "display name is always shared").toBe(pair.b.displayName);

      // Turn on just this toggle.
      must(await pair.b.api.putProfile({ ...pair.b.profile, ...filled, sharing: { ...baseSharing, [toggle]: true } }));
      const on = await matchViews(pair.a, matchId);
      for (const v of [on.list, on.one]) expectOnlyShown(v, storedRecord, new Set([toggle]), `only ${toggle}`);
      const hiddenMarkers = TOGGLES.filter((t) => t !== toggle).flatMap((t) => markersFor(t, marker));
      expectNoLeak(on.raw, Object.fromEntries(hiddenMarkers.map((m) => [m, m])));
      for (const m of markersFor(toggle, marker)) expect(on.raw.join("\n")).toContain(m);

      // And back off on the very next fetch.
      must(await pair.b.api.putProfile({ ...pair.b.profile, ...filled, sharing: baseSharing }));
      const off = await matchViews(pair.a, matchId);
      for (const v of [off.list, off.one]) expectOnlyShown(v, storedRecord, new Set(), `${toggle} off again`);
    });
  }

  test("brand-new profile with sensitive fields filled and default sharing: the match sees none of them", async ({ world }) => {
    const marker = "sens";
    const { pair, matchId } = await matchedPair(world, {
      b: {
        age: 40,
        ethnicity: `ETHNITOWN-${marker}`,
        drinking: "often",
        smoking: "sometimes",
        drugs: "never",
        workOrSchool: `WORK-${marker}`,
        education: "doctorate",
        // sharing left at its defaults
        sharing: {},
      },
    });
    const own = must(await pair.b.api.getProfile());
    expect(own.sharing).toMatchObject({
      ethnicity: false,
      drinking: false,
      smoking: false,
      drugs: false,
      workOrSchool: false,
      education: false,
      age: true,
      aiAssist: true,
    });

    const v = await matchViews(pair.a, matchId);
    for (const other of [v.list, v.one]) {
      expect(other.ethnicity).toBeNull();
      expect(other.drinking).toBeNull();
      expect(other.smoking).toBeNull();
      expect(other.drugs).toBeNull();
      expect(other.workOrSchool, "work is off by default").toBeNull();
      expect(other.education, "education is off by default").toBeNull();
      expect(other.age, "age is on by default").toBe(40);
    }
    expectNoLeak(v.raw, { ethnicity: `ETHNITOWN-${marker}`, work: `WORK-${marker}`, "doctorate": "doctorate" });
  });

  test("changing a toggle after matching changes what the other person sees, both ways, for both people", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world, {
      a: { location: "Alameda", sharing: { location: true } },
      b: { location: "Berkeley", sharing: { location: true } },
    });
    const seeBsCity = async () => (await matchViews(pair.a, matchId)).one.location;
    const seeAsCity = async () => (await matchViews(pair.b, matchId)).one.location;
    expect(await seeBsCity()).toBe("Berkeley");
    expect(await seeAsCity()).toBe("Alameda");

    must(await pair.b.api.putProfile({ ...pair.b.profile, location: "Berkeley", sharing: { location: false } }));
    expect(await seeBsCity(), "hidden on the very next fetch").toBeNull();
    expect(await seeAsCity(), "A's own sharing is untouched").toBe("Alameda");

    must(await pair.b.api.putProfile({ ...pair.b.profile, location: "Berkeley", sharing: { location: true } }));
    expect(await seeBsCity(), "shown again").toBe("Berkeley");

    must(await pair.a.api.putProfile({ ...pair.a.profile, location: "Alameda", sharing: { location: false } }));
    expect(await seeAsCity()).toBeNull();
    expect(await seeBsCity()).toBe("Berkeley");

    // Editing the text while shared shows the new text.
    must(await pair.b.api.putProfile({ ...pair.b.profile, location: "Richmond", sharing: { location: true } }));
    expect(await seeBsCity()).toBe("Richmond");
  });

  test("a person never sees their own hidden fields reflected anywhere but their own profile", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world, {
      a: { ethnicity: "ETHNITOWN-self", sharing: { ethnicity: false } },
    });
    const own = must(await pair.a.api.getProfile());
    expect(own.ethnicity).toBe("ETHNITOWN-self");
    const v = await matchViews(pair.b, matchId);
    expectNoLeak(v.raw, { ethnicity: "ETHNITOWN-self" });
  });
});

test.describe("validation: rejected with 400 and nothing stored", () => {
  const bad: Array<[string, ProfileOverrides | Record<string, unknown>]> = [
    ["age 17 (under 18)", { age: 17 }],
    ["age 0", { age: 0 }],
    ["age 100", { age: 100 }],
    ["age 30.5", { age: 30.5 }],
    ["age as text", { age: "thirty" }],
    ["an unknown card id", { cards: ["music.indie", "music.not-a-card"] }],
    ["4 cards in one deck", { cards: ["music.indie", "music.jazz", "music.pop", "music.rock"] }],
    ["a duplicate card", { cards: ["music.indie", "music.indie"] }],
    ["an invalid MBTI", { mbti: "ABCD" }],
    ["a lower-case MBTI", { mbti: "infj" }],
    ["an unknown gender option", { gender: "robot" }],
    ["an unknown looking-for option", { lookingFor: "marriage-tomorrow" }],
    ["an unknown habit value", { drinking: "constantly" }],
    ["too long a city", { location: "x".repeat(61) }],
  ];
  for (const [name, patch] of bad) {
    test(name, async ({ world }) => {
      const p = await world.person({ bio: "ORIGINAL-BIO", age: 25, cards: ["music.indie"] });
      const before = must(await p.api.getProfile());
      const res = await p.api.putProfile({
        ...p.profile,
        displayName: "Changed Name",
        bio: "CHANGED-BIO",
        ...patch,
      } as Body);
      expect(res.status).toBe(400);
      expect(res.error?.code).toBe("invalid_request");
      const after = must(await p.api.getProfile());
      expect(after, "nothing was stored (not even the valid fields)").toEqual(before);
      expect(after.bio).toBe("ORIGINAL-BIO");
    });
  }

  test("the edges that are allowed are stored: age 18 and 99, three cards from each of four decks", async ({ world }) => {
    const p = await world.person();
    const twelve = [
      "music.indie", "music.jazz", "music.pop",
      "weekend.trails", "weekend.cafes", "weekend.gym",
      "energy.planner", "energy.listener", "energy.talker",
      "loves.dogs", "loves.art", "loves.books",
    ];
    for (const age of [18, 99]) {
      const saved = must(await p.api.putProfile({ ...p.profile, age, cards: twelve }));
      expect(saved.age).toBe(age);
      expect(saved.cards).toEqual(twelve);
      expect(saved.archetype).toBe(computeArchetype(twelve, null));
    }
  });
});

test.describe("social links no longer exist", () => {
  test("no profile or match response contains socialLinks, even if the client sends it", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const links = [{ label: "Site", url: `https://example.com/${pair.b.user.marker}` }];
    const put = await pair.b.api.putProfile({
      ...pair.b.profile,
      socialLinks: links,
      sharing: { socialLinks: true },
    } as Body);
    expect(put.ok, `an unknown key is ignored, not an error: ${put.text}`).toBe(true);

    const texts = [
      put.text,
      (await pair.b.api.getProfile()).text,
      (await pair.a.api.listMatches()).text,
      (await pair.a.api.getMatch(matchId)).text,
      (await pair.b.api.listMatches()).text,
      (await pair.b.api.getMatch(matchId)).text,
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/social_?links/i);
      expect(t).not.toContain(`example.com/${pair.b.user.marker}`);
    }
    expect(JSON.parse(put.text).sharing).not.toHaveProperty("socialLinks");
  });
});

test.describe("a non-matched account cannot see a profile", () => {
  test("a third account sees none of it through any route", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const marker = pair.b.user.marker;
    must(
      await pair.b.api.putProfile({
        ...pair.b.profile,
        ...fullProfile(marker),
        sharing: { ...ALL_OFF, photo: true, bio: true, location: true, ethnicity: true, cards: true },
      }),
    );
    const third = await world.person({ bio: "THIRD-BIO" });

    const rGetMatch = await third.api.getMatch(matchId);
    const rList = await third.api.listMatches();
    const rProfile = await third.api.getProfile();
    const rSuggest = await third.api.suggestions(matchId);
    const rMessages = await third.api.listMessages(matchId);
    const rSend = await third.api.sendMessage(matchId, { clientId: randomUUID(), body: "hi" });
    const results = [rGetMatch, rList, rProfile, rSuggest, rMessages, rSend];
    expect(rGetMatch.status).toBe(404);
    expect(rList.data?.matches).toEqual([]);
    expect(rProfile.data?.userId).toBe(third.user.id);
    for (const r of [rSuggest, rMessages, rSend]) expect(r.status).toBe(404);

    expectNoLeak(
      results.map((r) => r.text),
      {
        "B's marker": marker,
        "B's name": pair.b.displayName,
        "A's name": pair.a.displayName,
        "B's id": pair.b.user.id,
        "A's id": pair.a.user.id,
        "B's city": `TOWN-${marker}`,
        "B's ethnicity": `ETHNITOWN-${marker}`,
      },
    );
  });
});
