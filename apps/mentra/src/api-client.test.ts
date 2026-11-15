import { InterestEvent, routes } from "@cue/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CueApiClient } from "./api-client";
import { DEVICE_ID, EVENT_ID, ack, fakeFetch, json } from "./testing";

const TOKEN = "t".repeat(40);
const event = InterestEvent.parse({
  eventId: EVENT_ID,
  source: "mentra_touch",
  gesture: "backward_swipe",
  occurredAt: "2026-11-14T10:00:00.000Z",
});

function make(steps: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof CueApiClient>[0]> = {}) {
  const fetch = fakeFetch(steps);
  const sleeps: number[] = [];
  const clock = { t: 0 };
  const client = new CueApiClient({
    baseUrl: "https://cue.example/",
    getToken: () => TOKEN,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    ...extra,
  });
  return { client, fetch, sleeps, clock };
}

afterEach(() => vi.useRealTimers());

describe("submitInterest", () => {
  it("sends the expected request and returns the ack", async () => {
    const { client, fetch } = make([json(ack())]);
    const res = await client.submitInterest(event);
    expect(res).toEqual({ ok: true, ack: ack() });
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`https://cue.example${routes.interest}`);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual(event);
  });

  it("no token: unauthorized without a network call", async () => {
    const fetch = fakeFetch([json(ack())]);
    const client = new CueApiClient({ baseUrl: "https://x", getToken: () => null, fetch });
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "unauthorized" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("network failure then success keeps the identical body and eventId", async () => {
    const { client, fetch, sleeps } = make([new TypeError("down"), json(ack())]);
    const res = await client.submitInterest(event);
    expect(res.ok).toBe(true);
    expect(fetch.calls).toHaveLength(2);
    expect(sleeps).toEqual([300]);
    expect(fetch.calls[1]!.init.body).toBe(fetch.calls[0]!.init.body);
    expect(JSON.parse(fetch.calls[1]!.init.body as string).eventId).toBe(EVENT_ID);
  });

  it("5xx is retried with 300 then 700 ms backoff, at most 3 attempts, then server", async () => {
    const { client, fetch, sleeps } = make([json({}, 503)]);
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "server" });
    expect(fetch.calls).toHaveLength(3);
    expect(sleeps).toEqual([300, 700]);
    const bodies = new Set(fetch.calls.map((c) => c.init.body));
    expect(bodies.size).toBe(1);
  });

  it("stops after 3 network failures with network", async () => {
    const { client, fetch } = make([new TypeError("down")]);
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "network" });
    expect(fetch.calls).toHaveLength(3);
  });

  it("respects the 4000 ms budget", async () => {
    const clock = { t: 0 };
    const fetch = fakeFetch([
      () => {
        clock.t += 2000; // each attempt takes 2 s
        throw new TypeError("slow failure");
      },
    ]);
    const sleeps: number[] = [];
    const client = new CueApiClient({
      baseUrl: "https://x",
      getToken: () => TOKEN,
      fetch,
      now: () => clock.t,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.t += ms;
      },
    });
    // attempt 1: 0-2000; +300 -> attempt 2 starts 2300 (ok), ends 4300; +700 would start at 5000 -> give up
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "network" });
    expect(fetch.calls).toHaveLength(2);
    expect(sleeps).toEqual([300]);
  });

  it("gives up if the clock passed the budget during the sleep", async () => {
    const { client, fetch, clock } = make([new TypeError("x")], {
      sleep: async () => {
        clock.t += 9000;
      },
    });
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "network" });
    expect(fetch.calls).toHaveLength(1);
  });

  it.each([
    [400, "server"],
    [404, "server"],
    [422, "server"],
    [429, "server"],
    [401, "unauthorized"],
    [403, "unauthorized"],
  ] as const)("status %i is not retried and maps to %s", async (status, error) => {
    const { client, fetch, sleeps } = make([json({ error: { code: "x", message: "y" } }, status)]);
    expect(await client.submitInterest(event)).toEqual({ ok: false, error });
    expect(fetch.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("invalid 200 body is invalid_response with no retry", async () => {
    const { client, fetch } = make([json({ nope: true })]);
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "invalid_response" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("non-JSON 200 body is invalid_response", async () => {
    const { client } = make([new Response("<html>", { status: 200 })]);
    expect(await client.submitInterest(event)).toEqual({ ok: false, error: "invalid_response" });
  });

  it("returns rejected and duplicate acks as ok with their status", async () => {
    const rejected = ack({ status: "rejected", reason: "no_place", expiresAt: null });
    const dup = ack({ status: "duplicate" });
    expect(await make([json(rejected)]).client.submitInterest(event)).toEqual({ ok: true, ack: rejected });
    expect(await make([json(dup)]).client.submitInterest(event)).toEqual({ ok: true, ack: dup });
  });

  it("aborts an attempt that exceeds the timeout", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = fakeFetch([
      (call) =>
        new Promise<Response>((_, reject) => {
          const signal = call.init.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ]);
    const client = new CueApiClient({
      baseUrl: "https://x",
      getToken: () => TOKEN,
      fetch,
      timeoutMs: 2000,
      now: () => 0,
      sleep: async () => {},
    });
    const pending = client.submitInterest(event);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ ok: false, error: "network" });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

describe("getDeviceContext", () => {
  const context = {
    deviceId: DEVICE_ID,
    encounterMode: true,
    ready: true,
    serverTime: "2026-11-14T10:00:00.000Z",
  };

  it("GETs deviceMe with the bearer token", async () => {
    const { client, fetch } = make([json(context)]);
    expect(await client.getDeviceContext()).toEqual({ ok: true, context });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`https://cue.example${routes.deviceMe}`);
    expect(call.init.method).toBe("GET");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("no token: unlinked, no network call", async () => {
    const fetch = fakeFetch([json(context)]);
    const client = new CueApiClient({ baseUrl: "https://x", getToken: () => null, fetch });
    expect(await client.getDeviceContext()).toEqual({ ok: false, reason: "unlinked" });
    expect(fetch.calls).toHaveLength(0);
  });

  it.each([
    [401, "unlinked"],
    [403, "unlinked"],
    [500, "offline"],
    [404, "offline"],
  ] as const)("status %i -> %s, no retry", async (status, reason) => {
    const { client, fetch } = make([json({}, status)]);
    expect(await client.getDeviceContext()).toEqual({ ok: false, reason });
    expect(fetch.calls).toHaveLength(1);
  });

  it("network error and malformed body are offline", async () => {
    expect(await make([new TypeError("x")]).client.getDeviceContext()).toEqual({ ok: false, reason: "offline" });
    expect(await make([json({ encounterMode: "yes" })]).client.getDeviceContext()).toEqual({
      ok: false,
      reason: "offline",
    });
  });
});

describe("claimDevice", () => {
  const good = { deviceId: DEVICE_ID, deviceToken: "d".repeat(40) };

  it("posts the parsed input without auth", async () => {
    const { client, fetch } = make([json(good)]);
    const res = await client.claimDevice({ code: " ab12cd " });
    expect(res).toEqual({ ok: true, result: good });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`https://cue.example${routes.deviceClaim}`);
    expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(call.init.body as string)).toEqual({ code: "AB12CD", deviceLabel: "Mentra Live", mentraUserId: null });
  });

  it("malformed code: invalid_code without a network call", async () => {
    const { client, fetch } = make([json(good)]);
    expect(await client.claimDevice({ code: "abc" })).toEqual({ ok: false, error: "invalid_code" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("maps statuses and failures", async () => {
    expect(await make([json({}, 404)]).client.claimDevice({ code: "AB12CD" })).toEqual({ ok: false, error: "invalid_code" });
    expect(await make([json({}, 429)]).client.claimDevice({ code: "AB12CD" })).toEqual({ ok: false, error: "invalid_code" });
    expect(await make([json({}, 502)]).client.claimDevice({ code: "AB12CD" })).toEqual({ ok: false, error: "server" });
    expect(await make([new TypeError("x")]).client.claimDevice({ code: "AB12CD" })).toEqual({ ok: false, error: "network" });
    expect(await make([json({ deviceId: "x" })]).client.claimDevice({ code: "AB12CD" })).toEqual({
      ok: false,
      error: "invalid_response",
    });
  });
});
