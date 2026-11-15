import { GuestDeviceInput, DeviceHypeInput, GuestDeviceResult, GuestHandoff, HypeLine, routes } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import { CueBridge, type BridgeHost } from "./bridge";
import { STORAGE_KEYS } from "./config";
import { recordingFeedback } from "./feedback";
import { GUEST_ATTEMPT_COOLDOWN_MS, GUEST_MAX_FAILURES, type TranscriptionSource } from "./guest-intro";
import { createLogger } from "./logger";
import { HYPE_SPEAK_DELAY_MS } from "./match-hype";
import { GUEST_FAILURE_LINE } from "./speech";
import type { BridgeStatus } from "./status";
import { DEVICE_ID } from "./testing";

const SERVER = "https://cue.example.test";
const GUEST_TOKEN = "GuestTokenSecret_".padEnd(48, "g");
const MATCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MATCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HANDOFF_PATH = "/g/one-time-handoff-secret-value";
const T0 = 1_800_000_000_000;
const INTRO = "Hi, my name is Sam";

interface Recorded {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(initialStorage: Record<string, string> = {}, options: { transcription?: boolean } = {}) {
  const storage = new Map<string, string>(Object.entries(initialStorage));
  const world = {
    now: T0,
    guestStatus: 200,
    guestDown: false,
    latestMatchId: null as string | null,
    hypeStatus: 200,
    hypeDown: false,
    handoffStatus: 200,
    displayName: "Sam",
  };
  const requests: Recorded[] = [];
  const logs: string[] = [];
  const statuses: BridgeStatus[] = [];
  const spoken: string[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const feedback = recordingFeedback();

  const reply = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ path: url.pathname, headers, body });
    if (url.pathname === routes.deviceClaim) return reply({ deviceId: DEVICE_ID, deviceToken: GUEST_TOKEN });
    if (url.pathname === routes.guestDevice) {
      if (world.guestDown) throw new TypeError("fetch failed");
      if (world.guestStatus !== 200) return reply({ error: "x" }, world.guestStatus);
      return reply({ displayName: world.displayName, deviceId: DEVICE_ID, deviceToken: GUEST_TOKEN });
    }
    if (headers.Authorization !== `Bearer ${GUEST_TOKEN}`) return reply({ error: "unauthorized" }, 401);
    if (url.pathname === routes.deviceMe) {
      return reply({
        deviceId: DEVICE_ID,
        encounterMode: true,
        ready: true,
        latestMatchId: world.latestMatchId,
        serverTime: new Date(world.now).toISOString(),
      });
    }
    if (url.pathname === routes.deviceHype) {
      if (world.hypeDown) throw new TypeError("fetch failed");
      if (world.hypeStatus !== 200) return reply({ error: "x" }, world.hypeStatus);
      const { matchId } = body as { matchId: string };
      return reply({ matchId, text: `Ask them about ${matchId.slice(0, 4)}.`, source: "fallback" });
    }
    if (url.pathname === routes.guestHandoff) {
      if (world.handoffStatus !== 200) return reply({ error: "x" }, world.handoffStatus);
      return reply({ path: HANDOFF_PATH, expiresAt: new Date(world.now + 60000).toISOString() });
    }
    return reply({ error: "not_found" }, 404);
  }) as typeof fetch;

  // Fake transcription source: one active listener at a time.
  const mic = {
    handler: null as null | ((d: { text: string; isFinal: boolean }) => void),
    starts: 0,
    stops: 0,
  };
  const transcription: TranscriptionSource = {
    start(onTranscript) {
      mic.starts++;
      mic.handler = onTranscript;
      return () => {
        mic.stops++;
        mic.handler = null;
      };
    },
  };
  const say = async (text: string, isFinal = true) => {
    mic.handler?.({ text, isFinal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const host: BridgeHost = {
    storage: {
      get: async (k) => storage.get(k) ?? null,
      set: async (k, v) => void storage.set(k, v),
      delete: async (k) => void storage.delete(k),
    },
    feedback,
    logger: createLogger((level, line) => logs.push(`${level} ${line}`)),
    mentraUserId: () => "mentra-user-1",
    onStatus: (s) => statuses.push(s),
    fetch: fakeFetch,
    now: () => world.now,
    speak: (text) => void spoken.push(text),
    transcription: options.transcription === false ? undefined : transcription,
    openUrl: (url) => void opened.push(url),
    sleep: async (ms) => void sleeps.push(ms),
  };
  const bridge = new CueBridge(host);
  const posts = (path: string) => requests.filter((r) => r.path === path);
  return { bridge, host, storage, world, requests, logs, statuses, spoken, sleeps, opened, mic, say, posts };
}
type Setup = ReturnType<typeof setup>;

async function started(h: Setup) {
  await h.bridge.start({ poll: false });
  await h.bridge.setServerUrl(SERVER);
}
/** Signed in as a guest (token stored the way a guest creation stores it). */
async function guestLinked(h: Setup) {
  await started(h);
  await h.say(INTRO);
  expect(h.bridge.status().linked).toBe(true);
}

describe("guest account by voice", () => {
  it("an introduction creates a guest, stores the token, speaks, and stops listening", async () => {
    const h = setup();
    await started(h);
    expect(h.mic.handler).not.toBeNull();
    expect(h.bridge.status().listening).toBe(true);

    await h.say(INTRO);

    const posts = h.posts(routes.guestDevice);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ intro: INTRO, deviceLabel: "Mentra Live", mentraUserId: "mentra-user-1" });
    expect(GuestDeviceInput.safeParse(posts[0]!.body).success).toBe(true);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(["deviceLabel", "intro", "mentraUserId"]);
    expect(posts[0]!.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(posts[0]!.body)).not.toContain(GUEST_TOKEN);

    expect(h.storage.get(STORAGE_KEYS.deviceToken)).toBe(GUEST_TOKEN);
    expect(h.storage.get(STORAGE_KEYS.guestName)).toBe("Sam");
    expect(h.spoken).toEqual(["Yo Sam, you're in. Open Cue on your phone."]);
    expect(h.mic.stops).toBe(1);
    expect(h.mic.handler).toBeNull();
    expect(h.bridge.status()).toMatchObject({ linked: true, listening: false, guestName: "Sam", context: "ready" });
    // the context was refreshed with the new token
    expect(h.posts(routes.deviceMe).length).toBeGreaterThan(0);
  });

  it("the contract result shape the fake returns parses", () => {
    expect(GuestDeviceResult.safeParse({ displayName: "Sam", deviceId: DEVICE_ID, deviceToken: GUEST_TOKEN }).success).toBe(true);
  });

  it.each(["Sam", "hello there", "what a lovely day today", "the weather is nice", "my name is"])(
    "bare name or chatter %j does nothing",
    async (text) => {
      const h = setup();
      await started(h);
      await h.say(text);
      expect(h.posts(routes.guestDevice)).toHaveLength(0);
      expect(h.spoken).toEqual([]);
      expect(h.bridge.status().listening).toBe(true);
    },
  );

  it("interim results do nothing", async () => {
    const h = setup();
    await started(h);
    await h.say(INTRO, false);
    expect(h.posts(routes.guestDevice)).toHaveLength(0);
    expect(h.spoken).toEqual([]);
  });

  it("server 400 is silent and keeps listening", async () => {
    const h = setup();
    await started(h);
    h.world.guestStatus = 400;
    await h.say(INTRO);
    expect(h.posts(routes.guestDevice)).toHaveLength(1);
    expect(h.spoken).toEqual([]);
    expect(h.bridge.status().listening).toBe(true);
    expect(h.storage.has(STORAGE_KEYS.deviceToken)).toBe(false);
  });

  it.each([429, 404])("server %i speaks the failure line once and keeps listening", async (status) => {
    const h = setup();
    await started(h);
    h.world.guestStatus = status;
    await h.say(INTRO);
    expect(h.spoken).toEqual([GUEST_FAILURE_LINE]);
    expect(h.bridge.status().listening).toBe(true);
    expect(h.storage.has(STORAGE_KEYS.deviceToken)).toBe(false);
  });

  it("a network failure speaks the failure line once", async () => {
    const h = setup();
    await started(h);
    h.world.guestDown = true;
    await h.say(INTRO);
    expect(h.spoken).toEqual([GUEST_FAILURE_LINE]);
  });

  it("allows one attempt per 5 s and stops after 5 failures until the screen is reopened", async () => {
    const h = setup();
    await started(h);
    h.world.guestStatus = 429;
    await h.say(INTRO);
    h.world.now += GUEST_ATTEMPT_COOLDOWN_MS - 1;
    await h.say(INTRO); // inside the cooldown: no request
    expect(h.posts(routes.guestDevice)).toHaveLength(1);
    expect(h.spoken).toHaveLength(1);

    for (let i = 1; i < GUEST_MAX_FAILURES; i++) {
      h.world.now += GUEST_ATTEMPT_COOLDOWN_MS;
      await h.say(INTRO);
    }
    expect(h.posts(routes.guestDevice)).toHaveLength(GUEST_MAX_FAILURES);
    expect(h.spoken).toHaveLength(GUEST_MAX_FAILURES);

    h.world.now += GUEST_ATTEMPT_COOLDOWN_MS * 10;
    await h.say(INTRO); // capped
    expect(h.posts(routes.guestDevice)).toHaveLength(GUEST_MAX_FAILURES);

    h.bridge.screenOpened();
    h.world.guestStatus = 200;
    await h.say(INTRO);
    expect(h.posts(routes.guestDevice)).toHaveLength(GUEST_MAX_FAILURES + 1);
    expect(h.bridge.status().linked).toBe(true);
  });

  it("starts linked: not listening; unlink: listening again", async () => {
    const h = setup({ [STORAGE_KEYS.deviceToken]: GUEST_TOKEN, [STORAGE_KEYS.serverUrl]: SERVER });
    await h.bridge.start({ poll: false });
    expect(h.mic.starts).toBe(0);
    expect(h.bridge.status().listening).toBe(false);
    await h.bridge.unlink();
    expect(h.mic.starts).toBe(1);
    expect(h.bridge.status().listening).toBe(true);
  });

  it("does not listen without a server address", async () => {
    const h = setup();
    await h.bridge.start({ poll: false });
    expect(h.mic.starts).toBe(0);
    await h.bridge.setServerUrl(SERVER);
    expect(h.mic.starts).toBe(1);
  });

  it("without transcription the bridge works and never listens", async () => {
    const h = setup({}, { transcription: false });
    await started(h);
    expect(h.bridge.status().listening).toBe(false);
    expect(h.mic.starts).toBe(0);
  });

  it("pairing with a code stops listening and clears the guest name", async () => {
    const h = setup({ [STORAGE_KEYS.guestName]: "Old" });
    await started(h);
    expect(h.mic.handler).not.toBeNull();
    expect(await h.bridge.linkWithCode("abc123")).toEqual({ ok: true });
    expect(h.mic.handler).toBeNull();
    expect(h.bridge.status()).toMatchObject({ linked: true, listening: false, guestName: null });
    expect(h.storage.has(STORAGE_KEYS.guestName)).toBe(false);
  });

  it("transcripts are never logged above debug and the token never appears in logs, status or statuses", async () => {
    const h = setup();
    await started(h);
    await h.say("some private chatter about my day");
    h.world.guestStatus = 429;
    await h.say(INTRO);
    h.world.now += GUEST_ATTEMPT_COOLDOWN_MS;
    h.world.guestStatus = 200;
    await h.say(INTRO);
    h.world.latestMatchId = MATCH_A;
    await h.bridge.refresh();
    await h.bridge.settled();
    await h.bridge.openGuestHandoff();

    const nonDebug = h.logs.filter((l) => !l.startsWith("debug "));
    expect(nonDebug.join("\n")).not.toContain("private chatter");
    expect(nonDebug.join("\n")).not.toContain(INTRO);
    for (const text of [h.logs.join("\n"), JSON.stringify(h.statuses), JSON.stringify(h.bridge.status())]) {
      expect(text).not.toContain(GUEST_TOKEN);
      expect(text).not.toContain(HANDOFF_PATH);
    }
  });
});

describe("guest handoff", () => {
  it("is authorized with the token, opens <origin><path> and returns only the URL", async () => {
    const h = setup();
    await guestLinked(h);
    const out = await h.bridge.openGuestHandoff();
    expect(out).toEqual({ ok: true, url: `${SERVER}${HANDOFF_PATH}` });
    const post = h.posts(routes.guestHandoff)[0]!;
    expect(post.headers.Authorization).toBe(`Bearer ${GUEST_TOKEN}`);
    expect(GuestHandoff.safeParse({ path: HANDOFF_PATH, expiresAt: new Date(T0).toISOString() }).success).toBe(true);
    expect(h.opened).toEqual([`${SERVER}${HANDOFF_PATH}`]);
    expect(JSON.stringify(out)).not.toContain(GUEST_TOKEN);
    expect(h.logs.join("\n")).not.toContain(HANDOFF_PATH);
  });

  it("403 (not a guest) hides the guest button and opens nothing", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.handoffStatus = 403;
    const out = await h.bridge.openGuestHandoff();
    expect(out.ok).toBe(false);
    expect(h.opened).toEqual([]);
    expect(h.bridge.status().guestName).toBeNull();
    expect(h.bridge.status().linked).toBe(true);
    expect(h.storage.has(STORAGE_KEYS.guestName)).toBe(false);
  });

  it("other errors give a plain message", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.handoffStatus = 500;
    const out = await h.bridge.openGuestHandoff();
    expect(out).toEqual({ ok: false, error: "Could not open Cue. Try again." });
    expect(h.opened).toEqual([]);
    expect(h.bridge.status().guestName).toBe("Sam");
  });

  it("refuses a path that is not site-relative", async () => {
    const h = setup();
    await guestLinked(h);
    const base = h.host.fetch!;
    const odd = new CueBridge({
      ...h.host,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith(routes.guestHandoff)
          ? new Response(JSON.stringify({ path: "//evil.example/x", expiresAt: new Date(T0).toISOString() }), { status: 200 })
          : base(input, init)) as typeof fetch,
    });
    await odd.start({ poll: false });
    expect((await odd.openGuestHandoff()).ok).toBe(false);
    expect(h.opened).toEqual([]);
  });
});

describe("spoken wingman line", () => {
  it("a new latestMatchId triggers exactly one hype request and one spoken line, after the delay", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.latestMatchId = MATCH_A;
    await h.bridge.refresh();
    await h.bridge.refresh();
    await h.bridge.refresh();
    await h.bridge.settled();
    const posts = h.posts(routes.deviceHype);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ matchId: MATCH_A });
    expect(DeviceHypeInput.safeParse(posts[0]!.body).success).toBe(true);
    expect(posts[0]!.headers.Authorization).toBe(`Bearer ${GUEST_TOKEN}`);
    expect(h.spoken.filter((s) => s.startsWith("Ask them"))).toEqual(["Ask them about aaaa."]);
    expect(h.sleeps).toEqual([HYPE_SPEAK_DELAY_MS]);
    expect(h.storage.get(STORAGE_KEYS.lastHypeMatch)).toBe(MATCH_A);
    expect(HypeLine.safeParse({ matchId: MATCH_A, text: "x", source: "fallback" }).success).toBe(true);
  });

  it("a second, different match is announced too", async () => {
    const h = setup();
    await guestLinked(h);
    for (const id of [MATCH_A, MATCH_B]) {
      h.world.latestMatchId = id;
      await h.bridge.refresh();
      await h.bridge.settled();
    }
    expect(h.posts(routes.deviceHype)).toHaveLength(2);
    expect(h.spoken.filter((s) => s.startsWith("Ask them"))).toEqual(["Ask them about aaaa.", "Ask them about bbbb."]);
  });

  it("null triggers nothing", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.latestMatchId = null;
    await h.bridge.refresh();
    await h.bridge.settled();
    expect(h.posts(routes.deviceHype)).toHaveLength(0);
  });

  it("a restart with the stored id triggers nothing", async () => {
    const h = setup({
      [STORAGE_KEYS.deviceToken]: GUEST_TOKEN,
      [STORAGE_KEYS.serverUrl]: SERVER,
      [STORAGE_KEYS.lastHypeMatch]: MATCH_A,
    });
    h.world.latestMatchId = MATCH_A;
    await h.bridge.start({ poll: false });
    await h.bridge.refresh();
    await h.bridge.settled();
    expect(h.posts(routes.deviceHype)).toHaveLength(0);
    expect(h.spoken).toEqual([]);
  });

  it("a restart after announcing does not repeat it (same storage, new bridge)", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.latestMatchId = MATCH_A;
    await h.bridge.refresh();
    await h.bridge.settled();
    const again = new CueBridge({ ...h.host });
    await again.start({ poll: false });
    await again.settled();
    expect(h.posts(routes.deviceHype)).toHaveLength(1);
  });

  it("a failed hype request speaks nothing, retries at most once, and is not repeated on later polls", async () => {
    const h = setup();
    await guestLinked(h);
    h.world.hypeStatus = 500;
    h.world.latestMatchId = MATCH_A;
    await h.bridge.refresh();
    await h.bridge.settled();
    expect(h.posts(routes.deviceHype)).toHaveLength(2);
    expect(h.spoken.filter((s) => s.startsWith("Ask them"))).toEqual([]);
    await h.bridge.refresh();
    await h.bridge.settled();
    expect(h.posts(routes.deviceHype)).toHaveLength(2);
  });

  it("a hype request that fails once and then succeeds speaks the line once", async () => {
    const h = setup();
    await guestLinked(h);
    let calls = 0;
    const base = h.host.fetch!;
    const flaky = new CueBridge({
      ...h.host,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith(routes.deviceHype) && calls++ === 0) throw new TypeError("fetch failed");
        return base(input, init);
      }) as typeof fetch,
    });
    await flaky.start({ poll: false });
    h.world.latestMatchId = MATCH_B;
    await flaky.refresh();
    await flaky.settled();
    expect(h.spoken.filter((s) => s.startsWith("Ask them"))).toEqual(["Ask them about bbbb."]);
  });
});
