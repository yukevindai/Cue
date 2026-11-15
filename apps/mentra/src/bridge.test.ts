import { DeviceClaimInput, InterestEvent, routes } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import { CueBridge, type BridgeHost } from "./bridge";
import { STORAGE_KEYS } from "./config";
import { recordingFeedback } from "./feedback";
import { createLogger } from "./logger";
import type { BridgeStatus } from "./status";
import { DEVICE_ID, ack } from "./testing";

const SERVER = "https://cue.example.test";
const TOKEN = "T0kenSecretValue_".padEnd(48, "x");
const MENTRA_USER = "mentra-user-1";
const T0 = 1_800_000_000_000;

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(initial: Record<string, string> = {}) {
  const storage = new Map<string, string>(Object.entries(initial));
  const world = { encounterMode: true, hasPlace: true, down: false, revoked: false, now: T0 };
  const requests: Recorded[] = [];
  const logs: string[] = [];
  const statuses: BridgeStatus[] = [];
  const feedback = recordingFeedback();

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (world.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method: init?.method ?? "GET", path: url.pathname, headers, body });
    const reply = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === routes.deviceClaim) return reply({ deviceId: DEVICE_ID, deviceToken: TOKEN });
    if (world.revoked || headers.Authorization !== `Bearer ${TOKEN}`) return reply({ error: "unauthorized" }, 401);
    if (url.pathname === routes.deviceMe) {
      return reply({
        deviceId: DEVICE_ID,
        encounterMode: world.encounterMode,
        ready: world.encounterMode && world.hasPlace,
        serverTime: new Date(world.now).toISOString(),
      });
    }
    if (url.pathname === routes.interest) {
      const event = body as { eventId: string };
      return reply(ack({ eventId: event.eventId }));
    }
    return reply({ error: "not_found" }, 404);
  }) as typeof fetch;

  const host: BridgeHost = {
    storage: {
      get: async (k) => storage.get(k) ?? null,
      set: async (k, v) => void storage.set(k, v),
      delete: async (k) => void storage.delete(k),
    },
    feedback,
    logger: createLogger((level, line) => logs.push(`${level} ${line}`)),
    mentraUserId: () => MENTRA_USER,
    onStatus: (s) => statuses.push(s),
    fetch: fakeFetch,
    now: () => world.now,
  };
  const bridge = new CueBridge(host);
  const interestPosts = () => requests.filter((r) => r.method === "POST" && r.path === routes.interest);
  return { bridge, host, storage, world, requests, logs, statuses, feedback, interestPosts };
}

type Setup = ReturnType<typeof setup>;

const touch = (gestureName: string, at = T0) => ({ type: "touch_event", gestureName, timestamp: at });

/** Linked, server set, encounter mode on, context refreshed. */
async function ready(h: Setup) {
  await h.bridge.start({ poll: false });
  expect(await h.bridge.setServerUrl(SERVER)).toEqual({ ok: true });
  expect(await h.bridge.linkWithCode("abc123")).toEqual({ ok: true });
  await h.bridge.refresh();
  expect(h.bridge.status().context).toBe("ready");
}

describe("CueBridge", () => {
  it("(a) unpaired with no server URL ignores a backward swipe and makes no request", async () => {
    const h = setup();
    await h.bridge.start({ poll: false });
    const out = await h.bridge.handleTouch(touch("backward_swipe"));
    expect(out.kind).toBe("ignored");
    expect(h.requests).toHaveLength(0);
    expect(h.feedback.cues).toEqual([]);
    expect(h.bridge.status()).toMatchObject({ linked: false, serverUrl: null });
  });

  it("(b) linking claims with the uppercased code and persists the token", async () => {
    const h = setup();
    await h.bridge.start({ poll: false });
    await h.bridge.setServerUrl(SERVER);
    expect(await h.bridge.linkWithCode("abc123")).toEqual({ ok: true });
    const claim = h.requests.find((r) => r.path === routes.deviceClaim)!;
    expect(claim.method).toBe("POST");
    expect(claim.body).toEqual({ code: "ABC123", deviceLabel: "Mentra Live", mentraUserId: MENTRA_USER });
    expect(DeviceClaimInput.safeParse(claim.body).success).toBe(true);
    expect(h.storage.get(STORAGE_KEYS.deviceToken)).toBe(TOKEN);
    expect(h.bridge.status().linked).toBe(true);
  });

  it("(c) a backward swipe posts exactly one authorized, contract-valid interest event", async () => {
    const h = setup();
    await ready(h);
    const out = await h.bridge.handleTouch(touch("backward_swipe"));
    expect(out.kind).toBe("submitted");
    const posts = h.interestPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const parsed = InterestEvent.parse(posts[0]!.body);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(["eventId", "gesture", "occurredAt", "source"]);
    expect(parsed).toMatchObject({ source: "mentra_touch", gesture: "backward_swipe" });
    expect(h.feedback.cues).toEqual(["signal_sent"]);
  });

  it.each(["forward_swipe", "single_tap", "double_tap", "triple_tap", "long_press", "up_swipe", "down_swipe"])(
    "(d) %s never submits but is listed in recentGestures",
    async (gesture) => {
      const h = setup();
      await ready(h);
      await h.bridge.handleTouch(touch(gesture));
      expect(h.interestPosts()).toHaveLength(0);
      expect(h.bridge.status().recentGestures.map((g) => g.gestureName)).toEqual([gesture]);
      expect(h.feedback.cues).toEqual([]);
    },
  );

  it("(e) calibration mode records the gesture, submits nothing and persists", async () => {
    const h = setup();
    await ready(h);
    await h.bridge.setCalibration(true);
    expect(h.storage.get(STORAGE_KEYS.calibration)).toBe("1");
    const out = await h.bridge.handleTouch(touch("backward_swipe"));
    expect(out).toMatchObject({ kind: "ignored", reason: "calibration_mode" });
    expect(h.interestPosts()).toHaveLength(0);
    expect(h.bridge.status().recentGestures[0]?.gestureName).toBe("backward_swipe");
    expect(h.bridge.status().calibration).toBe(true);
    await h.bridge.setCalibration(false);
    expect(h.storage.get(STORAGE_KEYS.calibration)).toBe("0");
  });

  describe("(f) backward gesture override", () => {
    it("remaps to forward_swipe: only it submits", async () => {
      const h = setup();
      await ready(h);
      await h.bridge.setBackwardGesture("forward_swipe");
      await h.bridge.handleTouch(touch("backward_swipe", T0));
      expect(h.interestPosts()).toHaveLength(0);
      await h.bridge.handleTouch(touch("forward_swipe", T0 + 5000));
      expect(h.interestPosts()).toHaveLength(1);
      expect(h.bridge.status().backwardGestureName).toBe("forward_swipe");
    });

    it("null disables submission entirely", async () => {
      const h = setup();
      await ready(h);
      await h.bridge.setBackwardGesture(null);
      for (const g of ["backward_swipe", "forward_swipe"]) await h.bridge.handleTouch(touch(g));
      expect(h.interestPosts()).toHaveLength(0);
      expect(h.bridge.status().backwardGestureName).toBeNull();
    });

    it("is persisted and restored by a new bridge over the same storage", async () => {
      const h = setup();
      await ready(h);
      await h.bridge.setBackwardGesture("forward_swipe");
      expect(h.storage.get(STORAGE_KEYS.backwardGesture)).toBe("forward_swipe");

      const again = new CueBridge({ ...h.host });
      await again.start({ poll: false });
      expect(again.status().backwardGestureName).toBe("forward_swipe");
      expect(again.status()).toMatchObject({ linked: true, context: "ready" });
      await again.handleTouch(touch("backward_swipe"));
      expect(h.interestPosts()).toHaveLength(0);
      await again.handleTouch(touch("forward_swipe"));
      expect(h.interestPosts()).toHaveLength(1);

      await h.bridge.setBackwardGesture(null);
      const disabled = new CueBridge({ ...h.host });
      await disabled.start({ poll: false });
      expect(disabled.status().backwardGestureName).toBeNull();
    });
  });

  describe("(g) context gating", () => {
    it("encounter mode off: no POST", async () => {
      const h = setup();
      await ready(h);
      h.world.encounterMode = false;
      await h.bridge.refresh();
      expect(h.bridge.status().context).toBe("encounter_mode_off");
      const out = await h.bridge.handleTouch(touch("backward_swipe"));
      expect(out).toMatchObject({ kind: "ignored", reason: "encounter_mode_off" });
      expect(h.interestPosts()).toHaveLength(0);
    });

    it("mode on but no place: no POST, no_place cue", async () => {
      const h = setup();
      await ready(h);
      h.world.hasPlace = false;
      await h.bridge.refresh();
      expect(h.bridge.status().context).toBe("no_place");
      const out = await h.bridge.handleTouch(touch("backward_swipe"));
      expect(out).toMatchObject({ kind: "ignored", reason: "no_place" });
      expect(h.interestPosts()).toHaveLength(0);
      expect(h.feedback.cues).toEqual(["no_place"]);
    });

    it("server unreachable: offline, swipe dropped, and never replayed after recovery", async () => {
      const h = setup();
      await ready(h);
      h.world.down = true;
      await h.bridge.refresh();
      expect(h.bridge.status().context).toBe("offline");
      const out = await h.bridge.handleTouch(touch("backward_swipe", T0));
      expect(out).toMatchObject({ kind: "ignored", reason: "offline" });
      expect(h.interestPosts()).toHaveLength(0);

      h.world.down = false;
      await h.bridge.refresh();
      expect(h.bridge.status().context).toBe("ready");
      expect(h.interestPosts()).toHaveLength(0); // nothing replayed

      h.world.now = T0 + 5000;
      await h.bridge.handleTouch(touch("backward_swipe", h.world.now));
      expect(h.interestPosts()).toHaveLength(1);
    });
  });

  it("(h) the token never appears in status, onStatus payloads or logs", async () => {
    const h = setup();
    await ready(h);
    await h.bridge.handleTouch(touch("backward_swipe"));
    await h.bridge.setCalibration(true);
    await h.bridge.handleTouch(touch("single_tap"));
    await h.bridge.setBackwardGesture("forward_swipe");
    h.world.down = true;
    await h.bridge.refresh();
    await h.bridge.handleTouch(touch("forward_swipe", T0 + 9000));
    await h.bridge.unlink();

    expect(h.statuses.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.bridge.status())).not.toContain(TOKEN);
    expect(JSON.stringify(h.statuses)).not.toContain(TOKEN);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("(i) unlink clears the stored token and later swipes are ignored", async () => {
    const h = setup();
    await ready(h);
    await h.bridge.unlink();
    expect(h.storage.has(STORAGE_KEYS.deviceToken)).toBe(false);
    expect(h.bridge.status()).toMatchObject({ linked: false, context: "unlinked" });
    const out = await h.bridge.handleTouch(touch("backward_swipe", T0 + 5000));
    expect(out.kind).toBe("ignored");
    expect(h.interestPosts()).toHaveLength(0);
  });

  it("(k) a token revoked on the server (401) drops to unlinked and forgets the token", async () => {
    const h = setup();
    await ready(h);
    h.world.revoked = true;
    await h.bridge.refresh();
    expect(h.storage.has(STORAGE_KEYS.deviceToken)).toBe(false);
    expect(h.bridge.status()).toMatchObject({ linked: false, context: "unlinked" });
    const out = await h.bridge.handleTouch(touch("backward_swipe", T0 + 5000));
    expect(out.kind).toBe("ignored");
    expect(h.interestPosts()).toHaveLength(0);
  });

  it("(l) a 401 on the interest POST itself also unlinks; the swipe is not kept", async () => {
    const h = setup();
    await ready(h);
    h.world.revoked = true;
    const out = await h.bridge.handleTouch(touch("backward_swipe", T0 + 5000));
    expect(out).toMatchObject({ kind: "failed", error: "unauthorized" });
    expect(h.feedback.cues).toEqual(["not_sent"]);
    expect(h.bridge.status().linked).toBe(false);
    h.world.revoked = false;
    await h.bridge.refresh();
    expect(h.interestPosts()).toHaveLength(1);
  });

  it("(j) setServerUrl rejects non-http(s) URLs and URLs with paths", async () => {
    const h = setup();
    await h.bridge.start({ poll: false });
    for (const bad of ["ftp://cue.example.test", "javascript:alert(1)", "cue.example.test", "https://cue.example.test/app", "https://cue.example.test?x=1", ""]) {
      expect((await h.bridge.setServerUrl(bad)).ok).toBe(false);
    }
    expect(h.storage.has(STORAGE_KEYS.serverUrl)).toBe(false);
    expect(h.bridge.status().serverUrl).toBeNull();
    expect(await h.bridge.setServerUrl(`${SERVER}/`)).toEqual({ ok: true });
    expect(h.bridge.status().serverUrl).toBe(SERVER);
  });
});
