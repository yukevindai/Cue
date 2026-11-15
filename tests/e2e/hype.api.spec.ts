// The spoken wingman line: POST /api/matches/{id}/hype (session) and POST /api/devices/hype (device token).
// The model is the suite's fake server, so this proves what SocialEyes sends and how it handles the answer,
// not what a real Claude writes. It also proves nothing about audio: speaking is the browser's or the
// glasses' job (see guest-voice.ui.spec.ts for the page side, with a fake speech synthesiser).
import { randomUUID } from "node:crypto";
import type { WingmanModelOutput } from "@cue/contracts";
import { deviceApi, addressedApi } from "./helpers/auth";
import { must, rawCall, parseApiError } from "./helpers/api";
import { linkDevice } from "./helpers/device";
import type { RecordedRequest } from "./helpers/fake-anthropic";
import { expect, test } from "./helpers/fixtures";
import { signal, matchedPair, type ProfileOverrides, type World } from "./helpers/scenario";

const A_NAME = "Avery Stone";
const B_NAME = "Riley Vale";
const VENUE = "E2E Hype Cafe";
const A_AGE = 47;
const B_AGE = 61;

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

/** Values that must appear in no hype request: never-sent fields, unshared fields, the people's own bios. */
const FORBIDDEN_TEXT = [
  "GENDERWORDS-A",
  "GENDERWORDS-B",
  "ETHNICITY-A",
  "ETHNICITY-B",
  "UNSHARED-BIO-B",
  "UNSHARED-WORK-B",
  "UNSHARED-WORK-A",
  "OWN-BIO-A",
  "Non-binary",
  "non_binary",
  "prefer_not_to_say",
  "Prefer not to say",
  "Oakland",
  "INFJ",
  "ENFP",
];

function profileFor(side: "A" | "B"): ProfileOverrides {
  const a = side === "A";
  return {
    displayName: a ? A_NAME : B_NAME,
    bio: a ? "OWN-BIO-A weekend hiker who likes pour-over coffee." : "UNSHARED-BIO-B trail runner who loves latte art.",
    interests: a ? ["Hiking", "Coffee"] : ["Hiking", "Latte art"],
    age: a ? A_AGE : B_AGE,
    gender: a ? "non_binary" : "man",
    genderSelfDescribed: `GENDERWORDS-${side}`,
    location: "Oakland",
    lookingFor: a ? "friendship" : "open",
    workOrSchool: `UNSHARED-WORK-${side}`,
    education: a ? "masters" : "bachelors",
    mbti: a ? "INFJ" : "ENFP",
    ethnicity: `ETHNICITY-${side}`,
    drinking: "often",
    smoking: "sometimes",
    drugs: "prefer_not_to_say",
    cards: a ? ["weekend.trails", "music.indie"] : ["weekend.trails", "music.jazz"],
    // Their bio and work stay private; everything else is shared with matches and with the model.
    sharing: { ...ALL_SHARED, bio: a, workOrSchool: false },
  };
}

const GOOD_WINGMAN: WingmanModelOutput = {
  shared_interests: [
    {
      label: "Hiking",
      summary: "You both enjoy hiking.",
      your_evidence: { field: "interests", quote: "Hiking" },
      their_evidence: { field: "interests", quote: "Hiking" },
    },
  ],
  suggested_question: "What's a trail you would happily walk again?",
  opener_basis: "shared_interest",
};

const GOOD_LINE = "Yo, Riley is into hiking too, so ask which trail you would happily walk again.";

const FALLBACK_HAS_NAME_AND_PLACE = (name: string, place: string | null) => (text: string) => {
  expect(text).toContain(name);
  if (place) expect(text).toContain(place);
  expect(text).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
};

/** A matched pair with rich profiles at a named venue; A is the listener unless a test says otherwise. */
async function hypePair(world: World, a: ProfileOverrides = {}, b: ProfileOverrides = {}) {
  return matchedPair(world, { venue: VENUE, a: { ...profileFor("A"), ...a }, b: { ...profileFor("B"), ...b } });
}

/** The JSON document in the user turn of a recorded hype request. */
function hypeInput(req: RecordedRequest): { name: string; place: string | null; shared: { topic: string; their_words: string }[]; opener: string | null } {
  const messages = (req.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  const user = messages.find((m) => m.role === "user");
  if (!user) throw new Error("no user turn in the recorded hype request");
  const text = Array.isArray(user.content) ? user.content.map((b: { text?: string }) => b.text ?? "").join("") : String(user.content);
  return JSON.parse(text);
}

test.describe("hype: participants, credentials, ended matches", () => {
  test("both participants get a line on the session route; the device route returns the wearer's same line", async ({ world, fake }) => {
    const { pair, matchId } = await hypePair(world);
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(GOOD_LINE);
    const device = await linkDevice(pair.a);
    try {
      const web = must(await pair.a.api.hype(matchId), "hype A");
      expect(web.matchId).toBe(matchId);
      expect(web.source).toBe("model");
      const viaDevice = must(await device.api.deviceHype({ matchId }), "device hype");
      expect(viaDevice).toEqual(web);

      // The other person gets their own line, about the wearer.
      await fake.hypeSays("Okay, Avery noticed you too, so ask which trail you would happily walk again.");
      const theirs = must(await pair.b.api.hype(matchId), "hype B");
      expect(theirs.matchId).toBe(matchId);
      expect(theirs.text).toContain("Avery");
      expect(theirs.text).not.toBe(web.text);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("a non-participant, an unknown match and an ended match are 404 on both routes", async ({ world }) => {
    const { pair, matchId } = await hypePair(world);
    const third = await world.person();
    const thirdDevice = await linkDevice(third);
    const ownerDevice = await linkDevice(pair.a);
    try {
      expect((await third.api.hype(matchId)).status).toBe(404);
      expect((await thirdDevice.api.deviceHype({ matchId })).status).toBe(404);
      expect((await pair.a.api.hype(randomUUID())).status).toBe(404);
      expect((await ownerDevice.api.deviceHype({ matchId: randomUUID() })).status).toBe(404);
      const bad = await rawCall(pair.a.ctx, "POST", "/api/matches/not-a-uuid/hype", {});
      expect(bad.status).toBe(404);
      expect(parseApiError(bad).code).toBe("not_found");

      // The participants are fine until it ends.
      expect((await pair.a.api.hype(matchId)).status).toBe(200);
      expect((await pair.b.api.unmatch(matchId)).status).toBe(204);
      expect((await pair.a.api.hype(matchId)).status).toBe(404);
      expect((await pair.b.api.hype(matchId)).status).toBe(404);
      expect((await ownerDevice.api.deviceHype({ matchId })).status).toBe(404);
    } finally {
      await thirdDevice.ctx.dispose();
      await ownerDevice.ctx.dispose();
    }
  });

  test("the wrong kind of credential is 401 on both routes; bad device bodies are 400", async ({ world }) => {
    const { pair, matchId } = await hypePair(world);
    const device = await linkDevice(pair.a);
    try {
      const anon = await addressedApi();
      try {
        expect((await rawCall(anon, "POST", `/api/matches/${matchId}/hype`, {})).status).toBe(401);
        expect((await rawCall(anon, "POST", "/api/devices/hype", { matchId })).status).toBe(401);
      } finally {
        await anon.dispose();
      }
      // A device token is no session; a session is no device token.
      expect((await rawCall(device.ctx, "POST", `/api/matches/${matchId}/hype`, {})).status).toBe(401);
      expect((await rawCall(pair.a.ctx, "POST", "/api/devices/hype", { matchId })).status).toBe(401);
      const stranger = await deviceApi("z".repeat(48));
      try {
        expect((await rawCall(stranger, "POST", "/api/devices/hype", { matchId })).status).toBe(401);
      } finally {
        await stranger.dispose();
      }
      expect((await device.api.deviceHype({ matchId: "nope" })).status).toBe(400);
      expect((await device.api.deviceHype({ matchId, extra: 1 })).status).toBe(400);
      expect((await device.api.deviceHype({})).status).toBe(400);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("latestMatchId on /api/devices/me is the new match, then null after it ends", async ({ world }) => {
    const pair = await world.pair({ venue: VENUE });
    const device = await linkDevice(pair.a);
    try {
      expect(must(await device.api.deviceMe()).latestMatchId).toBeNull();
      must(await signal(pair, pair.a));
      must(await signal(pair, pair.b));
      const matchId = must(await pair.a.api.listMatches()).matches[0].id;
      expect(must(await device.api.deviceMe()).latestMatchId).toBe(matchId);
      expect((await pair.b.api.unmatch(matchId)).status).toBe(204);
      expect(must(await device.api.deviceMe()).latestMatchId).toBeNull();
    } finally {
      await device.ctx.dispose();
    }
  });
});

test.describe("hype: what the model is sent", () => {
  test("with common ground and AI assist on, the line is the model's; the request holds only the shared item, the name and the venue", async ({ world, fake }) => {
    const { pair, matchId } = await hypePair(world);
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(GOOD_LINE);

    const line = must(await pair.a.api.hype(matchId), "hype");
    expect(line).toEqual({ matchId, text: GOOD_LINE, source: "model" });

    const calls = await fake.requests("hype");
    expect(calls).toHaveLength(1);
    const input = hypeInput(calls[0]);
    expect(Object.keys(input).sort()).toEqual(["name", "opener", "place", "shared"]);
    expect(input.name).toBe(B_NAME);
    expect(input.place).toBe(VENUE);
    expect(input.shared).toEqual([{ topic: "Hiking", their_words: "Hiking" }]);
    expect(input.opener).toBe(GOOD_WINGMAN.suggested_question);

    // Nothing else about either person: scan the whole request, system prompt included.
    const all = calls[0].rawBody;
    for (const text of FORBIDDEN_TEXT) expect(all, `hype request must not contain ${text}`).not.toContain(text);
    for (const secret of [pair.a.user.id, pair.b.user.id, pair.a.user.email, pair.b.user.email, pair.a.user.marker, pair.b.user.marker, matchId, A_NAME]) {
      expect(all, "ids, emails and the listener's own name never go to the model").not.toContain(secret);
    }
    // The user turn is the whole of what is said about the people: no age, no habits.
    const userTurn = JSON.stringify(input);
    for (const age of [String(A_AGE), String(B_AGE)]) expect(userTurn).not.toContain(age);
    for (const word of ["often", "sometimes", "friendship", "Master", "Bachelor", "Latte", "Coffee", "man", "gender", "ethnicity"]) {
      expect(userTurn.toLowerCase(), `user turn must not contain ${word}`).not.toContain(word.toLowerCase());
    }
    // And none of those reached the grounded wingman call either (its own rules, unchanged).
    for (const wingman of await fake.requests("wingman")) {
      for (const text of ["GENDERWORDS-A", "ETHNICITY-B", "UNSHARED-BIO-B", "UNSHARED-WORK-B"]) expect(wingman.rawBody).not.toContain(text);
    }
  });

  test("a phone-location match is 'Nearby': no place is sent and none is spoken", async ({ world, fake }) => {
    const near = await world.nearbyPair({ a: profileFor("A"), b: profileFor("B"), metres: 10 });
    must(await signal(null, near.a));
    must(await signal(null, near.b));
    const matchId = must(await near.a.api.listMatches()).matches[0].id;
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(GOOD_LINE);

    expect(must(await near.a.api.hype(matchId)).source).toBe("model");
    const calls = await fake.requests("hype");
    expect(calls).toHaveLength(1);
    expect(hypeInput(calls[0]).place).toBeNull();
    expect(calls[0].rawBody).not.toContain("Nearby");

    // The fallback line for the same kind of match names no place either.
    const other = await world.nearbyPair({ a: profileFor("A"), b: profileFor("B"), metres: 10 });
    must(await signal(null, other.a));
    must(await signal(null, other.b));
    const otherId = must(await other.a.api.listMatches()).matches[0].id;
    await fake.setMode("error");
    const fb = must(await other.a.api.hype(otherId));
    expect(fb.source).toBe("fallback");
    expect(fb.text).toContain(B_NAME);
    expect(fb.text).not.toContain("Nearby");
    expect(fb.text).not.toMatch(/ at /);
  });

  test("a second call (either route) is served without asking the model again", async ({ world, fake }) => {
    const { pair, matchId } = await hypePair(world);
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(GOOD_LINE);
    const device = await linkDevice(pair.a);
    try {
      const first = must(await pair.a.api.hype(matchId));
      expect(await fake.requests("hype")).toHaveLength(1);
      expect(await fake.requests("wingman")).toHaveLength(1);
      // Even with the model gone, the same line comes back.
      await fake.setMode("error");
      expect(must(await pair.a.api.hype(matchId))).toEqual(first);
      expect(must(await device.api.deviceHype({ matchId }))).toEqual(first);
      expect(await fake.requests("hype"), "no further hype call").toHaveLength(1);
      expect(await fake.requests("wingman"), "no further wingman call").toHaveLength(1);
    } finally {
      await device.ctx.dispose();
    }
  });
});

test.describe("hype: when the model cannot be used", () => {
  test("Claude erroring gives the fixed line (name and place), and matching still works", async ({ world, fake }) => {
    await fake.setMode("error");
    const { pair, matchId } = await hypePair(world);
    const line = must(await pair.a.api.hype(matchId));
    expect(line.source).toBe("fallback");
    FALLBACK_HAS_NAME_AND_PLACE(B_NAME, VENUE)(line.text);
    // Both people have the one match; the failure took nothing else with it.
    expect(must(await pair.b.api.listMatches()).matches.map((m) => m.id)).toEqual([matchId]);
    expect(must(await pair.b.api.hype(matchId)).text).toContain(A_NAME);
  });

  test("Claude hanging on the line gives the fixed line within a bounded time", async ({ world, fake }) => {
    const { pair, matchId } = await hypePair(world);
    await fake.respondWith(GOOD_WINGMAN);
    await fake.setMode("hang", undefined, "hype");
    const started = Date.now();
    const line = must(await pair.a.api.hype(matchId));
    const elapsed = Date.now() - started;
    expect(line.source).toBe("fallback");
    FALLBACK_HAS_NAME_AND_PLACE(B_NAME, VENUE)(line.text);
    expect(elapsed, "the e2e server gives the model 3 s").toBeLessThan(6_500);
    expect(await fake.requests("hype")).toHaveLength(1);
  });

  test("Claude hanging on everything: a match still forms, and the line still arrives in bounded time", async ({ world, fake }) => {
    await fake.setMode("hang");
    const pair = await world.pair({ venue: VENUE, a: profileFor("A"), b: profileFor("B") });
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const matchId = must(await pair.a.api.listMatches()).matches[0].id;
    const started = Date.now();
    const line = must(await pair.a.api.hype(matchId));
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(line.source).toBe("fallback");
    expect(line.text).toContain(B_NAME);
  });

  test("AI assist off for the listener or for the other person: the fixed line and no request reaches the model", async ({ world, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(GOOD_LINE);
    const offB = await hypePair(world, {}, { sharing: { ...ALL_SHARED, bio: false, workOrSchool: false, aiAssist: false } });
    const first = must(await offB.pair.a.api.hype(offB.matchId));
    expect(first.source).toBe("fallback");
    expect(first.text).toContain(B_NAME);
    expect(first.text).toContain(VENUE);

    const offA = await hypePair(world, { sharing: { ...ALL_SHARED, aiAssist: false } }, {});
    const second = must(await offA.pair.a.api.hype(offA.matchId));
    expect(second.source).toBe("fallback");
    // The person who has it off still hears a line about someone with it on; theirs is the fixed one too.
    expect(must(await offA.pair.b.api.hype(offA.matchId)).source).toBe("fallback");

    expect(await fake.requests(), "nothing was sent to the model, of either kind").toHaveLength(0);
  });

  const BAD_LINES: Array<[string, string]> = [
    ["a gendered pronoun", "She is into hiking too, so go say hi to Riley."],
    ["a gendered word", "Riley is a hiking dude, go say hi."],
    ["an emoji", "Yo Riley is into hiking too, go say hi \u{1F97E}"],
    ["a line break", "Yo Riley is into hiking too.\nGo say hi."],
    ["more than 280 characters", `Yo Riley is into hiking too ${"marathoning ".repeat(30)}go say hi.`],
    ["more than 40 words", `Yo Riley is into hiking too, ${"so ".repeat(40)}go say hi.`],
    ["no name", "You two both love hiking, so go say hi and ask about a trail."],
    ["an invented number", "Yo Riley has hiked 12 trails, go say hi."],
    ["crude wording", "Yo Riley is a hottie who hikes, go say hi."],
    ["markdown", "Yo **Riley** is into hiking too, go say hi."],
  ];
  for (const [what, line] of BAD_LINES) {
    test(`a model line with ${what} is rejected: the fixed line is used`, async ({ world, fake }) => {
      const { pair, matchId } = await hypePair(world);
      await fake.respondWith(GOOD_WINGMAN);
      await fake.hypeSays(line);
      const got = must(await pair.a.api.hype(matchId));
      expect(await fake.requests("hype"), "the model was asked").toHaveLength(1);
      expect(got.source).toBe("fallback");
      expect(got.text).not.toBe(line);
      FALLBACK_HAS_NAME_AND_PLACE(B_NAME, VENUE)(got.text);
    });
  }

  test("a model answer that is not the expected shape is rejected too", async ({ world, fake }) => {
    const { pair, matchId } = await hypePair(world);
    await fake.respondWith(GOOD_WINGMAN);
    await fake.setMode("ok", JSON.stringify({ text: GOOD_LINE }), "hype");
    expect(must(await pair.a.api.hype(matchId)).source).toBe("fallback");
    expect(must(await pair.b.api.listMatches()).matches.map((m) => m.id), "the match is untouched").toEqual([matchId]);
  });
});
