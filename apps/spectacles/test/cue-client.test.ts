import { describe, expect, it } from "vitest";
import { memoryStore } from "../lens/Assets/Scripts/Cue/Core/account-link";
import { STORAGE_KEYS } from "../lens/Assets/Scripts/Cue/Core/config";
import { CueClient, type CueHost } from "../lens/Assets/Scripts/Cue/Core/cue-client";
import { recordingFeedback } from "../lens/Assets/Scripts/Cue/Core/feedback";
import { createLogger } from "../lens/Assets/Scripts/Cue/Core/logger";
import type { HttpRequest } from "../lens/Assets/Scripts/Cue/Core/http";
import { ack, deviceContext, DEVICE, fakeClock, fakeTransport, json, TOKEN } from "./fakes";

interface ServerState {
  linked: boolean;
  encounterMode: boolean;
  /** What POST /api/interest answers, given the posted body. */
  interest: (body: { eventId: string }) => ReturnType<typeof json>;
}

function setup(opts: { token?: string | null; code?: string | null } = {}) {
  const clock = fakeClock();
  const server: ServerState = { linked: true, encounterMode: true, interest: (b) => json(200, ack(b.eventId)) };
  const transport = fakeTransport((req: HttpRequest) => {
    const path = new URL(req.url).pathname;
    if (path === "/api/devices/claim") {
      const { code } = JSON.parse(req.body ?? "{}") as { code: string };
      return code === "ABC123" ? json(200, { deviceId: DEVICE, deviceToken: TOKEN }) : json(400, { error: { code: "invalid_request", message: "bad code" } });
    }
    if (req.headers.Authorization !== `Bearer ${TOKEN}` || !server.linked) return json(401, {});
    if (path === "/api/devices/me") {
      return json(200, deviceContext(server.encounterMode ? {} : { encounterMode: false, encounterSessionId: null }));
    }
    if (path === "/api/interest") return server.interest(JSON.parse(req.body ?? "{}") as { eventId: string });
    return json(404, {});
  });
  const store = memoryStore(opts.token ? { [STORAGE_KEYS.deviceToken]: opts.token } : {});
  const feedback = recordingFeedback();
  const lines: string[] = [];
  let codeRequests = 0;
  const host: CueHost = {
    serverUrl: "https://cue.example",
    transport,
    sleep: clock.sleep,
    now: clock.now,
    store,
    feedback,
    requestPairingCode: async () => {
      codeRequests++;
      return opts.code === undefined ? "abc123" : opts.code;
    },
    logger: createLogger((_l, line) => lines.push(line), "debug"),
  };
  const client = new CueClient(host);
  let t = 0;
  const doublePinch = async () => {
    t += 2000; // well outside debounce
    clock.advance(2000);
    await client.onPinchDown({ hand: "right", timestampMs: t, confidence: 1 });
    return client.onPinchDown({ hand: "right", timestampMs: t + 200, confidence: 1 });
  };
  return { client, server, transport, store, feedback, lines, clock, doublePinch, codeRequests: () => codeRequests };
}

const interestPosts = (t: { requests: HttpRequest[] }) => t.requests.filter((r) => r.url.endsWith("/api/interest"));

describe("CueClient: pairing", () => {
  it("starts unlinked without a stored token, and a double pinch opens the keyboard and links", async () => {
    const s = setup();
    s.client.start();
    expect(s.feedback.statuses.at(-1)).toMatch(/Not linked/);
    const out = await s.doublePinch();
    expect(out).toEqual({ kind: "pairing", linked: true });
    expect(s.codeRequests()).toBe(1);
    expect(s.store.data[STORAGE_KEYS.deviceToken]).toBe(TOKEN);
    expect(s.client.getLinkState()).toBe("linked");
    expect(s.feedback.statuses.at(-1)).toBe("Encounter on. Double pinch to signal");
    expect(interestPosts(s.transport)).toHaveLength(0); // pairing gesture is never a signal
  });

  it("a wrong code plays not_sent and stays unlinked", async () => {
    const s = setup({ code: "ZZZ999" });
    s.client.start();
    expect(await s.doublePinch()).toEqual({ kind: "pairing", linked: false });
    expect(s.feedback.cues).toEqual(["not_sent"]);
    expect(s.client.getLinkState()).toBe("unlinked");
    expect(s.store.data[STORAGE_KEYS.deviceToken]).toBeUndefined();
  });

  it("dismissing the keyboard does nothing", async () => {
    const s = setup({ code: null });
    s.client.start();
    expect(await s.doublePinch()).toEqual({ kind: "pairing", linked: false });
    expect(s.transport.requests).toHaveLength(0);
  });

  it("a stored token is reused and the pairing code is never logged", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    expect(s.client.getLinkState()).toBe("linked");
    await s.client.refreshOnce();
    expect(s.lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("CueClient: signalling", () => {
  it("a single pinch sends nothing", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    expect(await s.client.onPinchDown({ hand: "left", timestampMs: 0, confidence: 1 })).toEqual({ kind: "not_double" });
    expect(interestPosts(s.transport)).toHaveLength(0);
  });

  it("double pinch with encounter mode on sends one spectacles_hand event and plays signal_sent", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    const out = await s.doublePinch();
    expect(out.kind).toBe("submitted");
    const posts = interestPosts(s.transport);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "")).toMatchObject({ source: "spectacles_hand", gesture: "double_pinch" });
    expect(s.feedback.cues).toEqual(["signal_sent"]);
  });

  it("a completed match plays match; a rejection plays the same not_sent for every reason", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    s.server.interest = (b) => json(200, ack(b.eventId, { matched: true, expiresAt: null }));
    await s.doublePinch();
    s.server.interest = (b) => json(200, ack(b.eventId, { status: "rejected", reason: "blocked", expiresAt: null }));
    await s.client.refreshOnce();
    await s.doublePinch();
    expect(s.feedback.cues).toEqual(["match", "not_sent"]);
  });

  it("encounter mode off: the gesture is dropped silently and never replayed", async () => {
    const s = setup({ token: TOKEN });
    s.server.encounterMode = false;
    s.client.start();
    await s.client.refreshOnce();
    expect(await s.doublePinch()).toEqual({ kind: "ignored", reason: "encounter_mode_off" });
    s.server.encounterMode = true;
    await s.client.refreshOnce();
    expect(interestPosts(s.transport)).toHaveLength(0);
    expect(s.feedback.cues).toEqual([]);
  });

  it("a stale context (no recent poll) drops the gesture", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    s.clock.advance(10_000);
    expect(await s.doublePinch()).toEqual({ kind: "ignored", reason: "context_stale" });
  });

  it("unlinking in the web app (401) clears the token and returns to pairing", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    s.server.linked = false;
    await s.client.refreshOnce();
    expect(s.client.getLinkState()).toBe("unlinked");
    expect(s.store.data[STORAGE_KEYS.deviceToken]).toBeUndefined();
    expect(s.feedback.statuses.at(-1)).toMatch(/Not linked/);
  });

  it("a 401 on submit also unlinks", async () => {
    const s = setup({ token: TOKEN });
    s.client.start();
    await s.client.refreshOnce();
    s.server.interest = () => json(401, {});
    const out = await s.doublePinch();
    expect(out).toMatchObject({ kind: "failed", error: "unauthorized" });
    expect(s.client.getLinkState()).toBe("unlinked");
  });
});
