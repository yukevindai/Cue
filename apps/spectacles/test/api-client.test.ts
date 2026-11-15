import { describe, expect, it } from "vitest";
import { CueApiClient } from "../lens/Assets/Scripts/Cue/Core/api-client";
import { GESTURE, SOURCE } from "../lens/Assets/Scripts/Cue/Core/config";
import { createLogger } from "../lens/Assets/Scripts/Cue/Core/logger";
import type { InterestEvent } from "../lens/Assets/Scripts/Cue/Core/wire";
import { ack, deviceContext, DEVICE, fakeClock, fakeTransport, json, SESSION, TOKEN, type Handler } from "./fakes";

const EVENT: InterestEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  encounterSessionId: SESSION,
  source: SOURCE,
  gesture: GESTURE,
  occurredAt: "2026-11-15T12:00:00.000Z",
};

function client(handler: Handler, token: string | null = TOKEN, lines: string[] = []) {
  const clock = fakeClock();
  const transport = fakeTransport(handler);
  const api = new CueApiClient({
    baseUrl: "https://cue.example/",
    getToken: () => token,
    transport,
    sleep: clock.sleep,
    now: clock.now,
    logger: createLogger((_l, line) => lines.push(line), "debug"),
  });
  return { api, transport, clock, lines };
}

describe("claimDevice", () => {
  it("posts the normalized code with the Spectacles label and no token", async () => {
    const { api, transport } = client(() => json(200, { deviceId: DEVICE, deviceToken: TOKEN }), null);
    const res = await api.claimDevice(" abc-123 ");
    expect(res).toEqual({ ok: true, result: { deviceId: DEVICE, deviceToken: TOKEN } });
    const [req] = transport.requests;
    expect(req?.url).toBe("https://cue.example/api/devices/claim");
    expect(req?.method).toBe("POST");
    expect(req?.headers.Authorization).toBeUndefined();
    expect(JSON.parse(req?.body ?? "")).toEqual({ code: "ABC123", deviceLabel: "Snap Spectacles", mentraUserId: null });
  });

  it("rejects a malformed code locally without a request", async () => {
    const { api, transport } = client(() => json(200, {}));
    expect(await api.claimDevice("12")).toEqual({ ok: false, error: "invalid_code" });
    expect(transport.requests).toHaveLength(0);
  });

  it("maps 4xx, 5xx, network errors and bad bodies", async () => {
    expect(await client(() => json(400, {})).api.claimDevice("ABC123")).toEqual({ ok: false, error: "invalid_code" });
    expect(await client(() => json(503, {})).api.claimDevice("ABC123")).toEqual({ ok: false, error: "server" });
    expect(await client(() => Promise.reject(new Error("down"))).api.claimDevice("ABC123")).toEqual({ ok: false, error: "network" });
    expect(await client(() => json(200, { deviceId: DEVICE })).api.claimDevice("ABC123")).toEqual({ ok: false, error: "invalid_response" });
  });
});

describe("getDeviceContext", () => {
  it("sends the bearer token and parses the context", async () => {
    const { api, transport } = client(() => json(200, deviceContext()));
    expect(await api.getDeviceContext()).toEqual({ ok: true, context: deviceContext() });
    expect(transport.requests[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(transport.requests[0]?.method).toBe("GET");
  });

  it("401/403 means unlinked, anything else offline", async () => {
    expect(await client(() => json(401, {})).api.getDeviceContext()).toEqual({ ok: false, reason: "unlinked" });
    expect(await client(() => json(403, {})).api.getDeviceContext()).toEqual({ ok: false, reason: "unlinked" });
    expect(await client(() => json(500, {})).api.getDeviceContext()).toEqual({ ok: false, reason: "offline" });
    expect(await client(() => Promise.reject(new Error("x"))).api.getDeviceContext()).toEqual({ ok: false, reason: "offline" });
  });

  it("without a token makes no request", async () => {
    const { api, transport } = client(() => json(200, deviceContext()), null);
    expect(await api.getDeviceContext()).toEqual({ ok: false, reason: "unlinked" });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("submitInterest", () => {
  it("returns the ack on 200", async () => {
    const { api } = client(() => json(200, ack(EVENT.eventId)));
    const res = await api.submitInterest(EVENT);
    expect(res.ok && res.ack.status).toBe("accepted");
  });

  it("retries 5xx and network failures with the byte-identical body, at most 3 attempts", async () => {
    let n = 0;
    const { api, transport } = client(() => (++n < 3 ? (n === 1 ? Promise.reject(new Error("x")) : json(502, {})) : json(200, ack(EVENT.eventId))));
    const res = await api.submitInterest(EVENT);
    expect(res.ok).toBe(true);
    expect(transport.requests).toHaveLength(3);
    expect(new Set(transport.requests.map((r) => r.body)).size).toBe(1);
  });

  it("gives up after 3 failed attempts", async () => {
    const { api, transport } = client(() => json(500, {}));
    expect(await api.submitInterest(EVENT)).toEqual({ ok: false, error: "server" });
    expect(transport.requests).toHaveLength(3);
  });

  it("does not retry 4xx; 401 is unauthorized", async () => {
    const a = client(() => json(401, {}));
    expect(await a.api.submitInterest(EVENT)).toEqual({ ok: false, error: "unauthorized" });
    expect(a.transport.requests).toHaveLength(1);
    const b = client(() => json(400, {}));
    expect(await b.api.submitInterest(EVENT)).toEqual({ ok: false, error: "server" });
    expect(b.transport.requests).toHaveLength(1);
  });

  it("a request that never answers times out and is retried", async () => {
    let n = 0;
    const { api, transport } = client(() => (++n === 1 ? new Promise(() => {}) : json(200, ack(EVENT.eventId))));
    const res = await api.submitInterest(EVENT);
    expect(res.ok).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it("never logs the token", async () => {
    const lines: string[] = [];
    const { api } = client(() => json(500, {}), TOKEN, lines);
    await api.submitInterest(EVENT);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
