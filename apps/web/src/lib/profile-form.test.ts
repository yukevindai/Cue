import { computeArchetype, DEFAULT_SHARING, MAX_CARDS_PER_DECK, PERSONALITY_CARDS, type OwnProfile } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import {
  aiNeverSent,
  aiSendable,
  buildShared,
  draftKey,
  emptyForm,
  formFromProfile,
  joinAnd,
  shareSummary,
  toDraft,
  toggleCard,
  validateForm,
  type FormState,
} from "./profile-form";

const USER = "11111111-1111-4111-8111-111111111111";

function filled(): FormState {
  return {
    ...emptyForm(),
    displayName: "Alex",
    bio: "Trail runner.",
    interests: ["Hiking"],
    age: "29",
    gender: "non_binary",
    genderSelfDescribed: "",
    location: " Oakland ",
    lookingFor: "open",
    workOrSchool: "Library",
    education: "masters",
    mbti: "INFP",
    ethnicity: "Synthetic",
    drinking: "sometimes",
    smoking: "never",
    drugs: "never",
    cards: ["weekend.trails", "energy.night-owl"],
  };
}

describe("validateForm", () => {
  it("accepts a full profile and never sends an archetype", () => {
    const { input, errors } = validateForm(filled());
    expect(errors).toEqual({});
    expect(input?.age).toBe(29);
    expect(input?.location).toBe("Oakland");
    expect(input).not.toHaveProperty("archetype");
  });

  it("turns empty text fields into null and an empty age into null", () => {
    const { input } = validateForm({ ...emptyForm(), displayName: "Sam" });
    expect(input?.age).toBeNull();
    expect(input?.location).toBeNull();
    expect(input?.workOrSchool).toBeNull();
  });

  it("explains under-18 kindly and rejects odd ages", () => {
    expect(validateForm({ ...filled(), age: "17" }).errors.age).toMatch(/only for adults, 18 and over/);
    expect(validateForm({ ...filled(), age: "120" }).errors.age).toMatch(/18 to 99/);
    expect(validateForm({ ...filled(), age: "twenty" }).errors.age).toMatch(/as a number/);
  });

  it("phrases length problems per field", () => {
    const e = validateForm({ ...filled(), location: "x".repeat(61), workOrSchool: "y".repeat(81) }).errors;
    expect(e.location).toMatch(/60 characters/);
    expect(e.workOrSchool).toMatch(/80 characters/);
  });
});

describe("toggleCard", () => {
  it("adds, removes, and stops at the per-deck limit", () => {
    const music = PERSONALITY_CARDS.filter((c) => c.deck === "music").map((c) => c.id);
    let picks: string[] = [];
    for (const id of music) picks = toggleCard(picks, id);
    expect(picks).toHaveLength(MAX_CARDS_PER_DECK);
    expect(toggleCard(picks, picks[0])).toHaveLength(MAX_CARDS_PER_DECK - 1);
    expect(toggleCard(picks, "weekend.trails")).toHaveLength(MAX_CARDS_PER_DECK + 1);
  });
});

describe("buildShared mirrors the server", () => {
  it("shares the defaults and hides sensitive fields", () => {
    const s = buildShared(filled(), USER);
    expect(s.age).toBe(29);
    expect(s.gender).toBe("non_binary");
    expect(s.location).toBe("Oakland");
    expect(s.archetype).toBe(computeArchetype(filled().cards, "INFP"));
    // Off by default
    expect(s.workOrSchool).toBeNull();
    expect(s.education).toBeNull();
    expect(s.ethnicity).toBeNull();
    expect(s.drinking).toBeNull();
    expect(s.smoking).toBeNull();
    expect(s.drugs).toBeNull();
  });

  it("hides cards and character together, and own words with gender", () => {
    const f = { ...filled(), genderSelfDescribed: "Fluid", sharing: { ...DEFAULT_SHARING, cards: false, gender: false } };
    const s = buildShared(f, USER);
    expect(s.cards).toEqual([]);
    expect(s.archetype).toBeNull();
    expect(s.gender).toBeNull();
    expect(s.genderSelfDescribed).toBeNull();
  });
});

describe("shareSummary", () => {
  it("lists every field on one side, with not-added fields called out", () => {
    const f = { ...filled(), photoUrl: null };
    const { will, wont } = shareSummary(f);
    expect(will).toEqual([
      "name",
      "bio",
      "age",
      "gender",
      "city",
      "what you're looking for",
      "cards and character",
      "interests",
      "MBTI",
    ]);
    expect(wont).toEqual([
      "photo (not added)",
      "work or school",
      "education",
      "ethnicity",
      "drinking",
      "smoking",
      "drug use",
    ]);
  });

  it("does not mention a sensitive field that is hidden and empty", () => {
    const { wont } = shareSummary({ ...emptyForm(), displayName: "Sam" });
    expect(wont).not.toContain("ethnicity");
    expect(wont).toContain("age (not added)");
  });

  it("agrees with buildShared for every field", () => {
    const f = { ...filled(), sharing: { ...DEFAULT_SHARING, ethnicity: true, bio: false } };
    const s = buildShared(f, USER);
    const { will } = shareSummary(f);
    expect(will).toContain("ethnicity");
    expect(s.ethnicity).toBe("Synthetic");
    expect(will).not.toContain("bio");
    expect(s.bio).toBeNull();
  });
});

describe("aiSendable", () => {
  it("never includes gender or sensitive fields, even when shared", () => {
    const f = {
      ...filled(),
      sharing: { ...DEFAULT_SHARING, ethnicity: true, drinking: true, smoking: true, drugs: true, workOrSchool: true },
    };
    const sent = aiSendable(f);
    expect(sent).toContain("work or school");
    for (const never of [...aiNeverSent(), "photo"]) {
      expect(sent).not.toContain(never);
    }
  });

  it("names every excluded field once", () => {
    expect(aiNeverSent()).toEqual(expect.arrayContaining(["gender", "ethnicity", "drinking", "smoking", "drug use"]));
    expect(aiSendable(filled())).not.toContain("age");
  });

  it("is empty when AI assist is off", () => {
    expect(aiSendable({ ...filled(), sharing: { ...DEFAULT_SHARING, aiAssist: false } })).toEqual([]);
  });
});

describe("round trip", () => {
  it("a saved profile loads back as a clean form", () => {
    const f = filled();
    const { input } = validateForm(f);
    const own: OwnProfile = {
      ...input!,
      userId: USER,
      archetype: computeArchetype(f.cards, f.mbti),
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    expect(draftKey(formFromProfile(own))).toBe(draftKey(f));
    expect(toDraft(formFromProfile(own)).cards).toEqual(f.cards);
  });
});

describe("joinAnd", () => {
  it("joins lists in plain English", () => {
    expect(joinAnd([])).toBe("");
    expect(joinAnd(["a"])).toBe("a");
    expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
  });
});
