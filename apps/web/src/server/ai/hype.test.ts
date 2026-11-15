import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import Anthropic from "@anthropic-ai/sdk";
import { HYPE_MAX_LENGTH, HypeLine, type SharedProfile, type WingmanModelOutput } from "@cue/contracts";
import type { SuggestionCache } from "./cache";
import {
  fallbackLine,
  getHypeLine,
  HYPE_SYSTEM_PROMPT,
  HypeCache,
  HypeError,
  validateHypeLine,
  type HypeDeps,
  type HypeModelInput,
} from "./hype";
import type { ModelConfig, WingmanModelClient } from "./model";
import { RateLimiter } from "./rate-limit";
import type { StoredSuggestion, WingmanMatchContext } from "./types";

const MATCH = "7b0c6a3e-3c55-4a8e-9d3b-1f0a5f4f7c01";
const ALEX = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";

/** Values that must never reach the hype model call. */
const MARK = {
  age: 47,
  ethnicity: "MARKER-ETHNICITY",
  genderSelf: "MARKER-GENDER-WORDS",
  theirBioSecret: "MARKERBIOSECRET",
  theirWork: "MARKER-WORKPLACE",
  yourInterest: "MARKER-YOUR-ONLY-INTEREST",
  location: "MARKER-CITY",
};

function profile(userId: string, fields: Partial<SharedProfile>): SharedProfile {
  return {
    userId,
    displayName: "Synthetic Person",
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
    ...fields,
  };
}

function context(over: {
  youAi?: boolean;
  themAi?: boolean;
  cacheKey?: string;
  venueLabel?: string;
  venueLabelSource?: WingmanMatchContext["venueLabelSource"];
  theirName?: string;
} = {}): WingmanMatchContext {
  return {
    matchId: MATCH,
    venueLabel: over.venueLabel ?? "Demo Hall",
    venueLabelSource: over.venueLabelSource ?? "venue_checkin",
    requester: {
      userId: ALEX,
      profile: profile(ALEX, {
        displayName: "Alex",
        interests: ["Hiking", MARK.yourInterest],
        age: MARK.age,
        drinking: "often",
        smoking: "sometimes",
      }),
      aiAssist: over.youAi ?? true,
      version: 1,
    },
    other: {
      userId: SAM,
      profile: profile(SAM, {
        displayName: over.theirName ?? "Sam",
        interests: ["hiking"],
        bio: `I bake on Sundays. ${MARK.theirBioSecret}`,
        workOrSchool: MARK.theirWork,
        location: MARK.location,
        age: MARK.age,
        gender: "non_binary",
        genderSelfDescribed: MARK.genderSelf,
        ethnicity: MARK.ethnicity,
        drinking: "often",
        smoking: "often",
        drugs: "sometimes",
      }),
      aiAssist: over.themAi ?? true,
      version: 1,
    },
    cacheKey: over.cacheKey ?? "v1:v1",
  };
}

function memoryCache(): SuggestionCache {
  const rows = new Map<string, { key: string; payload: StoredSuggestion }>();
  return {
    async get(matchId, requesterId, cacheKey) {
      const row = rows.get(`${matchId}:${requesterId}`);
      return row && row.key === cacheKey ? row.payload : null;
    },
    async put(matchId, requesterId, cacheKey, payload) {
      rows.set(`${matchId}:${requesterId}`, { key: cacheKey, payload });
    },
  };
}

type Parse = WingmanModelClient["beta"]["messages"]["parse"];

function fakeClient(respond: (...args: Parameters<Parse>) => unknown, stopReason = "end_turn") {
  const parse = vi.fn(async (...args: Parameters<Parse>) => {
    const out = await respond(...args);
    return { stop_reason: stopReason, parsed_output: out } as Awaited<ReturnType<Parse>>;
  });
  return { client: { beta: { messages: { parse } } } satisfies WingmanModelClient, parse };
}

const hikingOverlap: WingmanModelOutput = {
  shared_interests: [
    {
      label: "Hiking",
      summary: "You both enjoy hiking.",
      your_evidence: { field: "interests", quote: "Hiking" },
      their_evidence: { field: "interests", quote: "hiking" },
    },
  ],
  suggested_question: "What's a trail you'd happily do again?",
  opener_basis: "shared_interest",
};

const config: ModelConfig = { model: "claude-opus-5-5", timeoutMs: 200, fallbacks: true };

function setup(
  ctx: WingmanMatchContext,
  hype: ReturnType<typeof fakeClient>,
  wingmanOutput: WingmanModelOutput = hikingOverlap,
  extra: Partial<HypeDeps> = {},
) {
  const wingman = fakeClient(() => wingmanOutput);
  const getContext = vi.fn(async () => ctx);
  const deps: HypeDeps = {
    getContext,
    wingman: {
      cache: memoryCache(),
      requestLimiter: new RateLimiter(100, 60_000),
      modelLimiter: new RateLimiter(100, 60_000),
      getClient: () => wingman.client,
      config,
    },
    cache: new HypeCache(),
    requestLimiter: new RateLimiter(100, 60_000),
    modelLimiter: new RateLimiter(100, 60_000),
    getClient: () => hype.client,
    config: { ...config, hypeTimeoutMs: 100 },
    ...extra,
  };
  return { deps, wingman, getContext };
}

const GENDERED = /\b(he|she|him|her|hers|his|himself|herself)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getHypeLine", () => {
  it("uses a valid model line built from the verified items", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too. Ask what trail they'd do again." }));
    const { deps } = setup(context(), hype);
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(HypeLine.parse(line)).toEqual({
      matchId: MATCH,
      text: "Yo, Sam's into hiking too. Ask what trail they'd do again.",
      source: "model",
    });
    expect(hype.parse).toHaveBeenCalledTimes(1);
  });

  it("sends only the verified items, the opener, the name and the place", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too. Go ask about trails." }));
    const { deps } = setup(context(), hype);
    await getHypeLine(MATCH, ALEX, deps);

    const [params, options] = hype.parse.mock.calls[0]!;
    expect(params.system).toBe(HYPE_SYSTEM_PROMPT);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config?.effort).toBe("low");
    expect(options?.maxRetries).toBe(0);
    expect(options?.timeout).toBe(100);
    expect(params.messages).toHaveLength(1);
    expect(JSON.parse(params.messages[0]!.content as string)).toEqual({
      name: "Sam",
      place: "Demo Hall",
      shared: [{ topic: "Hiking", their_words: "hiking" }],
      opener: "What's a trail you'd happily do again?",
    });
    const sent = JSON.stringify(params);
    for (const marker of [
      ...Object.values(MARK).map(String),
      "non_binary",
      "often",
      "sometimes",
      "drinking",
      "smoking",
      "drugs",
      "ethnicity",
      "gender",
      "age",
      "Alex",
      ALEX,
      SAM,
      MATCH,
      "I bake on Sundays",
    ]) {
      expect(JSON.stringify(JSON.parse(params.messages[0]!.content as string))).not.toContain(marker);
      if (!["age", "gender"].includes(marker)) expect(sent).not.toContain(marker);
    }
  });

  it("sends no place for a phone-location match", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too. Go say hi." }));
    const { deps } = setup(context({ venueLabel: "Nearby", venueLabelSource: "phone_location" }), hype);
    await getHypeLine(MATCH, ALEX, deps);
    expect(JSON.parse(hype.parse.mock.calls[0]![0].messages[0]!.content as string).place).toBeNull();
  });

  it.each([
    ["the model throws", () => fakeClient(() => { throw new Anthropic.APIError(500, undefined, "boom", new Headers()); })],
    ["the model times out", () => fakeClient(() => new Promise((r) => setTimeout(() => r({ line: "Yo, Sam is cool." }), 500)))],
    ["the output is garbage", () => fakeClient(() => ({ nope: 1 }))],
    ["the line is empty", () => fakeClient(() => ({ line: "   " }))],
    ["the line is too long", () => fakeClient(() => ({ line: `Yo, Sam ${"really ".repeat(60)}likes hiking.` }))],
    ["the line has an emoji", () => fakeClient(() => ({ line: "Yo, Sam's into hiking too 🔥 go say hi." }))],
    ["the line has a line break", () => fakeClient(() => ({ line: "Yo, Sam's into hiking.\nGo say hi." }))],
    ["the line uses a gendered pronoun", () => fakeClient(() => ({ line: "Yo, Sam's into hiking too. Ask her about it." }))],
    ["the line is about looks", () => fakeClient(() => ({ line: "Yo, Sam is cute and into hiking." }))],
    ["the line forgets the name", () => fakeClient(() => ({ line: "Yo, they're into hiking too. Go say hi." }))],
    ["the line invents a number", () => fakeClient(() => ({ line: "Yo, Sam hiked 12 trails. Go say hi." }))],
    ["the model refuses", () => fakeClient(() => ({ line: "Yo, Sam's into hiking." }), "refusal")],
  ])("falls back when %s", async (_why, make) => {
    const hype = make();
    const { deps } = setup(context(), hype);
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(line.text).toBe(fallbackLine(MATCH, "Sam", "Demo Hall"));
    expect(HypeLine.safeParse(line).success).toBe(true);
  });

  it("falls back without an API key", async () => {
    const hype = fakeClient(() => ({ line: "unused" }));
    const { deps } = setup(context(), hype, hikingOverlap, {
      getClient: () => {
        throw new Error("ANTHROPIC_API_KEY is not set");
      },
    });
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(hype.parse).not.toHaveBeenCalled();
  });

  it.each([
    ["the requester", { youAi: false }],
    ["the other person", { themAi: false }],
  ])("falls back with no model call at all when %s has AI assist off", async (_who, over) => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too." }));
    const { deps, wingman } = setup(context(over), hype);
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(hype.parse).not.toHaveBeenCalled();
    expect(wingman.parse).not.toHaveBeenCalled();
  });

  it("falls back with no hype call when the grounded pipeline finds nothing", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too." }));
    const { deps } = setup(context(), hype, { shared_interests: [], suggested_question: null, opener_basis: "encounter_context" });
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(hype.parse).not.toHaveBeenCalled();
  });

  it("falls back when the grounded pipeline fails", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too." }));
    const { deps } = setup(context(), hype);
    deps.wingman.getClient = () => {
      throw new Error("no key");
    };
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(hype.parse).not.toHaveBeenCalled();
  });

  it("serves a repeat call from the cache, still checking access", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too. Go say hi." }));
    const { deps, wingman, getContext } = setup(context(), hype);
    const first = await getHypeLine(MATCH, ALEX, deps);
    const second = await getHypeLine(MATCH, ALEX, deps);
    expect(second).toEqual(first);
    expect(hype.parse).toHaveBeenCalledTimes(1);
    expect(wingman.parse).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledTimes(2);
  });

  it("misses the cache when a profile or sharing change moves the context key", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too. Go say hi." }));
    const { deps } = setup(context(), hype);
    await getHypeLine(MATCH, ALEX, deps);
    deps.getContext = async () => context({ cacheKey: "v1:v2" });
    await getHypeLine(MATCH, ALEX, deps);
    expect(hype.parse).toHaveBeenCalledTimes(2);
  });

  it("propagates the access check (not a participant)", async () => {
    const hype = fakeClient(() => ({ line: "x" }));
    const notFound = new Error("not_found");
    const { deps } = setup(context(), hype, hikingOverlap, { getContext: async () => Promise.reject(notFound) });
    await expect(getHypeLine(MATCH, ALEX, deps)).rejects.toBe(notFound);
    expect(hype.parse).not.toHaveBeenCalled();
  });

  it("rate-limits requests", async () => {
    const hype = fakeClient(() => ({ line: "Yo, Sam's into hiking too." }));
    const { deps } = setup(context(), hype, hikingOverlap, { requestLimiter: new RateLimiter(1, 60_000) });
    await getHypeLine(MATCH, ALEX, deps);
    await expect(getHypeLine(MATCH, ALEX, deps)).rejects.toBeInstanceOf(HypeError);
  });
});

describe("fallbackLine", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `${i.toString(16).padStart(8, "0")}-3c55-4a8e-9d3b-1f0a5f4f7c01`);

  it("never uses a gendered pronoun or emoji, names the person, and fits", () => {
    const seen = new Set<string>();
    for (const id of ids) {
      for (const place of [null, "Demo Hall"]) {
        const line = fallbackLine(id, "Sam", place);
        seen.add(line);
        expect(line).not.toMatch(GENDERED);
        expect(line).not.toMatch(EMOJI);
        expect(line).toContain("Sam");
        if (place) expect(line).toContain(place);
        expect(line.length).toBeLessThanOrEqual(HYPE_MAX_LENGTH);
      }
    }
    expect(seen.size).toBeGreaterThan(2); // several variants are in use
  });

  it("is deterministic per match", () => {
    expect(fallbackLine(MATCH, "Sam", null)).toBe(fallbackLine(MATCH, "Sam", null));
  });

  it("uses a neutral stand-in when the name cannot be spoken", async () => {
    const hype = fakeClient(() => ({ line: "x" }));
    const { deps } = setup(context({ theirName: "📞 5551234567" }), hype);
    const line = await getHypeLine(MATCH, ALEX, deps);
    expect(line.source).toBe("fallback");
    expect(line.text).toContain("your match");
    expect(hype.parse).not.toHaveBeenCalled();
  });
});

describe("validateHypeLine", () => {
  const input: HypeModelInput = { name: "Sam Lee", place: null, shared: [{ topic: "Hiking", their_words: "hiking" }], opener: null };
  it("accepts a short casual line and strips wrapping quotes", () => {
    expect(validateHypeLine("“Yo, Sam's into hiking too. Go ask about trails.”", input)).toBe(
      "Yo, Sam's into hiking too. Go ask about trails.",
    );
  });
  it.each(["", "Yo #hiking Sam", "Sam, bro, go say hi.", "Sam is hot.", "Yo Sam\u2028go", "Yo, he likes hiking, Sam."])(
    "rejects %j",
    (text) => expect(validateHypeLine(text, input)).toBeNull(),
  );
});
