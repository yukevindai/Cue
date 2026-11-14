import type { InterestAck } from "@cue/contracts";

export const SESSION_ID = "22222222-2222-4222-8222-222222222222";
export const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
export const EVENT_ID = "44444444-4444-4444-8444-444444444444";

export function ack(overrides: Partial<InterestAck> = {}): InterestAck {
  return {
    status: "accepted",
    eventId: EVENT_ID,
    receivedAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-14T10:00:15.000Z",
    matched: false,
    reason: null,
    ...overrides,
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export type FakeStep = Response | Error | ((call: FetchCall) => Response | Promise<Response>);

/** Fetch fake that plays steps in order (the last repeats) and records every call. */
export function fakeFetch(steps: FakeStep[]): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) throw new Error("no step");
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step.clone();
    return step(call);
  };
  return Object.assign(fn, { calls }) as typeof fetch & { calls: FetchCall[] };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
