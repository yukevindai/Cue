import type { HttpRequest, HttpResponse, HttpTransport } from "../lens/Assets/Scripts/Cue/Core/http";

export const SESSION = "22222222-2222-4222-8222-222222222222";
export const DEVICE = "33333333-3333-4333-8333-333333333333";
export const TOKEN = "tok_" + "x".repeat(40);

/**
 * A controllable clock. Time moves only through advance(). sleep() yields one
 * macrotask and resolves, so a pending request (microtasks) always beats a
 * timeout unless it never settles.
 */
export function fakeClock(start = Date.parse("2026-11-15T12:00:00.000Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

export type Handler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Records every request and answers with the handler. */
export function fakeTransport(handler: Handler): HttpTransport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = (async (req: HttpRequest) => {
    requests.push(req);
    return handler(req);
  }) as HttpTransport & { requests: HttpRequest[] };
  transport.requests = requests;
  return transport;
}

export const json = (status: number, body: unknown): HttpResponse => ({ status, text: JSON.stringify(body) });

export function ack(eventId: string, over: Record<string, unknown> = {}) {
  return {
    status: "accepted",
    eventId,
    receivedAt: "2026-11-15T12:00:00.100Z",
    expiresAt: "2026-11-15T12:00:15.100Z",
    matched: false,
    reason: null,
    ...over,
  };
}

export function deviceContext(over: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    encounterMode: true,
    encounterSessionId: SESSION,
    serverTime: "2026-11-15T12:00:00.000Z",
    ...over,
  };
}
