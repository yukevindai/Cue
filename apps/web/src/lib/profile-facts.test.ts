import type { SharedProfile } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import { ageAndCity, sharedFacts } from "./profile-facts";

const bare: SharedProfile = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Sam",
  photoUrl: null,
  bio: null,
  interests: [],
  age: null,
  gender: null,
  genderSelfDescribed: null,
  location: null,
  lookingFor: null,
  workOrSchool: null,
  education: null,
  mbti: null,
  ethnicity: null,
  drinking: null,
  smoking: null,
  drugs: null,
  cards: [],
  archetype: null,
};

describe("sharedFacts", () => {
  it("produces nothing for a profile that shares nothing", () => {
    expect(sharedFacts(bare)).toEqual({ character: null, basics: [], about: [], cards: [], personal: [] });
    expect(ageAndCity(bare)).toBe("");
  });

  it("labels what is shared, groups cards by deck, and prefers own words for gender", () => {
    const f = sharedFacts({
      ...bare,
      age: 31,
      gender: "other",
      genderSelfDescribed: "Genderfluid",
      location: "Oakland",
      lookingFor: "long_term",
      mbti: "ENFJ",
      drinking: "sometimes",
      cards: ["music.jazz", "weekend.trails", "music.indie"],
      archetype: "sage",
    });
    expect(f.character?.name).toBe("The Sage");
    expect(f.basics.map((x) => [x.label, x.value])).toEqual([
      ["Age", "31"],
      ["Gender", "Genderfluid"],
      ["City", "Oakland"],
      ["Looking for", "Something long-term"],
    ]);
    expect(f.about).toEqual([{ key: "mbti", label: "MBTI", value: "ENFJ" }]);
    expect(f.cards.map((g) => [g.deck, g.labels])).toEqual([
      ["music", ["Jazz", "Indie"]],
      ["weekend", ["On a trail"]],
    ]);
    expect(f.personal).toEqual([{ key: "drinking", label: "Drinking", value: "Sometimes" }]);
    expect(ageAndCity({ age: 31, location: "Oakland" })).toBe("31, Oakland");
  });
});
