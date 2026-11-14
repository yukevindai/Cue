import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountLink, keyValueTokenStore, memoryTokenStore, type ClaimFn } from "./account-link";
import { CueApiClient } from "./api-client";
import { createLogger } from "./logger";
import { GesturePipeline } from "./pipeline";
import { recordingFeedback } from "./feedback";
import { fileTokenStore } from "./token-store-node";
import { DEVICE_ID, SESSION_ID, ack, fakeFetch, json } from "./testing";

const NEW_TOKEN = "n".repeat(40);
const OLD_TOKEN = "o".repeat(40);

describe("AccountLink", () => {
  it("link success persists the token and exposes it", async () => {
    const store = memoryTokenStore();
    const claim = vi.fn<ClaimFn>(async () => ({ ok: true, result: { deviceId: DEVICE_ID, deviceToken: NEW_TOKEN } }));
    const link = new AccountLink({ store, claim, mentraUserId: () => "mentra-user-1", deviceLabel: "Demo glasses" });
    await link.init();
    expect(link.isLinked()).toBe(false);
    expect(await link.link("ab12cd")).toEqual({ ok: true, deviceId: DEVICE_ID });
    expect(link.getToken()).toBe(NEW_TOKEN);
    expect(link.isLinked()).toBe(true);
    expect(await store.load()).toBe(NEW_TOKEN);
    expect(claim).toHaveBeenCalledWith({ code: "ab12cd", deviceLabel: "Demo glasses", mentraUserId: "mentra-user-1" });
  });

  it("passes null when there is no mentra user", async () => {
    const claim = vi.fn<ClaimFn>(async () => ({ ok: false, error: "invalid_code" }));
    await new AccountLink({ store: memoryTokenStore(), claim }).link("AB12CD");
    expect(claim.mock.calls[0]![0].mentraUserId).toBeNull();
  });

  it("init loads a stored token", async () => {
    const link = new AccountLink({ store: memoryTokenStore(OLD_TOKEN), claim: async () => ({ ok: false, error: "network" }) });
    await link.init();
    expect(link.getToken()).toBe(OLD_TOKEN);
  });

  it("failed link keeps the existing token", async () => {
    const store = memoryTokenStore(OLD_TOKEN);
    const link = new AccountLink({ store, claim: async () => ({ ok: false, error: "invalid_code" }) });
    await link.init();
    expect(await link.link("ZZZZZZ")).toEqual({ ok: false, error: "invalid_code" });
    expect(link.getToken()).toBe(OLD_TOKEN);
    expect(await store.load()).toBe(OLD_TOKEN);
  });

  it("unlink clears memory and store", async () => {
    const store = memoryTokenStore(OLD_TOKEN);
    const link = new AccountLink({ store, claim: async () => ({ ok: false, error: "network" }) });
    await link.init();
    await link.unlink();
    expect(link.isLinked()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("a malformed code makes no network call when wired to the api client", async () => {
    const fetch = fakeFetch([json({})]);
    const client = new CueApiClient({ baseUrl: "https://x", getToken: () => null, fetch });
    const link = new AccountLink({ store: memoryTokenStore(), claim: (i) => client.claimDevice(i) });
    expect(await link.link("12")).toEqual({ ok: false, error: "invalid_code" });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("token stores", () => {
  it("keyValueTokenStore works with sync and async storage", async () => {
    const map = new Map<string, string>();
    const sync = keyValueTokenStore({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    });
    expect(await sync.load()).toBeNull();
    await sync.save("abc");
    expect(map.get("cue.deviceToken")).toBe("abc");
    expect(await sync.load()).toBe("abc");
    await sync.clear();
    expect(await sync.load()).toBeNull();

    const asyncStore = keyValueTokenStore(
      {
        getItem: async (k) => map.get(k) ?? null,
        setItem: async (k, v) => void map.set(k, v),
        removeItem: async (k) => void map.delete(k),
      },
      "custom",
    );
    await asyncStore.save("xyz");
    expect(map.get("custom")).toBe("xyz");
    expect(await asyncStore.load()).toBe("xyz");
  });

  it("fileTokenStore round-trips with mode 0600 and creates the parent dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cue-token-"));
    try {
      const path = join(dir, "nested", "dir", "token");
      const store = fileTokenStore(path);
      expect(await store.load()).toBeNull();
      await store.save(NEW_TOKEN);
      expect(await store.load()).toBe(NEW_TOKEN);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // overwriting an existing, more permissive file tightens it
      await writeFile(path, "x", { mode: 0o644 });
      await store.save(OLD_TOKEN);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await store.load()).toBe(OLD_TOKEN);
      await store.clear();
      expect(await store.load()).toBeNull();
      await store.clear(); // idempotent
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("token and pairing code never reach logs", () => {
  it("across link, context, submit, pipeline and direct logger calls", async () => {
    const TOKEN = "SECRET-tok-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const CODE = "QZ7K4M";
    const lines: string[] = [];
    const logger = createLogger((_l, line) => lines.push(line));

    // A server that fails in every interesting way, echoing nothing secret.
    const fetchSteps = [
      json({ deviceId: DEVICE_ID, deviceToken: TOKEN }), // claim ok
      json({ deviceId: DEVICE_ID, encounterMode: true, encounterSessionId: SESSION_ID, serverTime: "2026-11-14T10:00:00.000Z" }),
      new TypeError(`connect failed Bearer ${TOKEN}`), // submit attempt 1 fails
      json({}, 503),
      json(ack({ matched: true, expiresAt: null })),
      json({}, 401), // context after revocation
      new TypeError("down"),
      json({}, 401), // submit unauthorized
    ];
    const fetch = fakeFetch(fetchSteps);
    const ref: { link: AccountLink | null } = { link: null };
    const client = new CueApiClient({
      baseUrl: "https://x",
      getToken: () => ref.link?.getToken() ?? null,
      fetch,
      logger,
      sleep: async () => {},
    });
    const link = new AccountLink({ store: memoryTokenStore(), claim: (i) => client.claimDevice(i), logger });
    ref.link = link;

    expect(await link.link(CODE.toLowerCase())).toMatchObject({ ok: true });
    const ctx = await client.getDeviceContext();
    expect(ctx.ok).toBe(true);

    const feedback = recordingFeedback();
    let now = 1_800_000_000_000;
    const pipeline = new GesturePipeline({
      mapping: { backwardSwipeGestureName: "swipe_backward" },
      calibration: false,
      context: () => ({ state: "ready", encounterSessionId: SESSION_ID }),
      submit: (e) => client.submitInterest(e),
      feedback,
      now: () => now,
      logger,
    });
    await pipeline.handleRawEvent({ gestureName: "swipe_backward" });
    expect(feedback.cues).toEqual(["match"]);
    now += 2000;
    await client.getDeviceContext(); // 401
    await client.getDeviceContext(); // network
    await pipeline.handleRawEvent({ gestureName: "swipe_backward" }); // 401 -> failed
    expect(feedback.cues).toEqual(["match", "not_sent"]);

    logger.error("oops", { token: TOKEN, authorization: `Bearer ${TOKEN}`, nested: { text: `Bearer ${TOKEN}`, code: CODE } });
    logger.info(`pairing with ${CODE} using ${TOKEN}`);

    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(CODE.toLowerCase());
    }
  });
});
