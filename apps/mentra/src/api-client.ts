import {
  DeviceClaimInput,
  DeviceClaimResult,
  DeviceContext,
  DeviceHypeInput,
  GuestDeviceInput,
  GuestDeviceResult,
  GuestHandoff,
  HypeLine,
  InterestAck,
  routes,
  type InterestEvent,
} from "@cue/contracts";
import type { z } from "zod";
import type { ContextFetchResult } from "./encounter-context";
import { silentLogger, type Logger } from "./logger";
import type { SubmitResult } from "./pipeline";

export type ClaimResult =
  | { ok: true; result: DeviceClaimResult }
  | { ok: false; error: "invalid_code" | "network" | "server" | "invalid_response" };

export type GuestCreateResult =
  | { ok: true; result: GuestDeviceResult }
  /** 400: nothing usable as a name. */
  | { ok: false; error: "no_name" }
  | { ok: false; error: "rate_limited" | "not_found" | "network" | "server" | "invalid_response" };

export type GuestHandoffResult =
  | { ok: true; handoff: GuestHandoff }
  /** 403: the device does not belong to a guest account. */
  | { ok: false; error: "not_guest" | "unauthorized" | "network" | "server" | "invalid_response" };

export type HypeResult =
  | { ok: true; line: HypeLine }
  | { ok: false; error: "unauthorized" | "network" | "server" | "invalid_response" };

export interface CueApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-attempt timeout (request plus body read). Default 2000. */
  timeoutMs?: number;
}

/** Waits before attempt 2 and attempt 3 of a submit. */
const RETRY_BACKOFF_MS = [300, 700] as const;
/** No attempt may start later than this after the first attempt started. */
const SUBMIT_BUDGET_MS = 4000;
const DEFAULT_TIMEOUT_MS = 2000;

interface HttpResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  body: unknown;
}

/**
 * Thin HTTP client for the three device-facing endpoints. Request and response
 * shapes come from `@cue/contracts`. It never logs the token, the Authorization
 * header or the pairing code: only status codes and error kinds.
 */
export class CueApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: CueApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.log = options.logger ?? silentLogger;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async claimDevice(input: z.input<typeof DeviceClaimInput>): Promise<ClaimResult> {
    const parsed = DeviceClaimInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid_code" };

    let res: HttpResponse;
    try {
      res = await this.request("POST", routes.deviceClaim, null, JSON.stringify(parsed.data));
    } catch (error) {
      this.log.warn("device claim failed", { error: errorKind(error) });
      return { ok: false, error: "network" };
    }
    this.log.debug("device claim response", { status: res.status });
    if (res.status >= 500) return { ok: false, error: "server" };
    if (res.status >= 400) return { ok: false, error: "invalid_code" };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: "server" };
    const body = DeviceClaimResult.safeParse(res.body);
    if (!body.success) return { ok: false, error: "invalid_response" };
    return { ok: true, result: body.data };
  }

  /**
   * Unauthenticated: creates a guest account from what the wearer said and
   * returns a device token for these glasses. One attempt, no retries.
   */
  async createGuestDevice(input: z.input<typeof GuestDeviceInput>): Promise<GuestCreateResult> {
    const parsed = GuestDeviceInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "no_name" };
    let res: HttpResponse;
    try {
      res = await this.request("POST", routes.guestDevice, null, JSON.stringify(parsed.data));
    } catch (error) {
      this.log.warn("guest create failed", { error: errorKind(error) });
      return { ok: false, error: "network" };
    }
    this.log.debug("guest create response", { status: res.status });
    if (res.status === 400) return { ok: false, error: "no_name" };
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    if (res.status === 404) return { ok: false, error: "not_found" };
    if (res.status !== 200 && res.status !== 201) return { ok: false, error: "server" };
    const body = GuestDeviceResult.safeParse(res.body);
    if (!body.success) return { ok: false, error: "invalid_response" };
    return { ok: true, result: body.data };
  }

  /** Device token required. One attempt. */
  async requestGuestHandoff(): Promise<GuestHandoffResult> {
    const token = this.getToken();
    if (token === null) return { ok: false, error: "unauthorized" };
    let res: HttpResponse;
    try {
      res = await this.request("POST", routes.guestHandoff, token, "{}");
    } catch (error) {
      this.log.warn("guest handoff failed", { error: errorKind(error) });
      return { ok: false, error: "network" };
    }
    if (res.status === 401) return { ok: false, error: "unauthorized" };
    if (res.status === 403) return { ok: false, error: "not_guest" };
    if (res.status !== 200) return { ok: false, error: "server" };
    const body = GuestHandoff.safeParse(res.body);
    if (!body.success) return { ok: false, error: "invalid_response" };
    return { ok: true, handoff: body.data };
  }

  /** Device token required. One attempt: the caller decides about a retry. */
  async requestHype(matchId: string): Promise<HypeResult> {
    const token = this.getToken();
    if (token === null) return { ok: false, error: "unauthorized" };
    const input = DeviceHypeInput.safeParse({ matchId });
    if (!input.success) return { ok: false, error: "invalid_response" };
    let res: HttpResponse;
    try {
      res = await this.request("POST", routes.deviceHype, token, JSON.stringify(input.data));
    } catch (error) {
      this.log.debug("hype request failed", { error: errorKind(error) });
      return { ok: false, error: "network" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized" };
    if (res.status !== 200) return { ok: false, error: "server" };
    const body = HypeLine.safeParse(res.body);
    if (!body.success) return { ok: false, error: "invalid_response" };
    return { ok: true, line: body.data };
  }

  /** One GET, no retries: the caller polls. */
  async getDeviceContext(): Promise<ContextFetchResult> {
    const token = this.getToken();
    if (token === null) return { ok: false, reason: "unlinked" };

    let res: HttpResponse;
    try {
      res = await this.request("GET", routes.deviceMe, token, null);
    } catch (error) {
      this.log.debug("device context unreachable", { error: errorKind(error) });
      return { ok: false, reason: "offline" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unlinked" };
    if (res.status !== 200) {
      this.log.debug("device context unexpected status", { status: res.status });
      return { ok: false, reason: "offline" };
    }
    const body = DeviceContext.safeParse(res.body);
    if (!body.success) return { ok: false, reason: "offline" };
    return { ok: true, context: body.data };
  }

  /**
   * POST the event. Retries only on network failure/timeout and 5xx, at most 3
   * attempts inside a 4000 ms budget, always with the byte-identical body (so
   * the same eventId, the server's idempotency key). Nothing is queued.
   */
  async submitInterest(event: InterestEvent): Promise<SubmitResult> {
    const token = this.getToken();
    if (token === null) return { ok: false, error: "unauthorized" };

    const body = JSON.stringify(event);
    const startedAt = this.now();
    let lastFailure: "network" | "server" = "network";

    for (let attempt = 1; attempt <= RETRY_BACKOFF_MS.length + 1; attempt++) {
      if (attempt > 1) {
        const delay = RETRY_BACKOFF_MS[attempt - 2] ?? 0;
        if (this.now() - startedAt + delay > SUBMIT_BUDGET_MS) break;
        await this.sleep(delay);
        if (this.now() - startedAt > SUBMIT_BUDGET_MS) break;
      }

      let res: HttpResponse;
      try {
        res = await this.request("POST", routes.interest, token, body);
      } catch (error) {
        lastFailure = "network";
        this.log.warn("interest attempt failed", { attempt, error: errorKind(error) });
        continue;
      }

      if (res.status >= 500) {
        lastFailure = "server";
        this.log.warn("interest attempt failed", { attempt, status: res.status });
        continue;
      }
      if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized" };
      if (res.status !== 200) {
        this.log.warn("interest refused", { status: res.status });
        return { ok: false, error: "server" };
      }
      const ack = InterestAck.safeParse(res.body);
      if (!ack.success) return { ok: false, error: "invalid_response" };
      return { ok: true, ack: ack.data };
    }
    return { ok: false, error: lastFailure };
  }

  /** One attempt with a timeout covering the response and body read. Throws on network failure. */
  private async request(
    method: "GET" | "POST",
    path: string,
    token: string | null,
    body: string | null,
  ): Promise<HttpResponse> {
    // The miniapp background runtime offers only "the SDK-supported
    // AbortController subset", so the timeout does not depend on fetch honoring
    // the signal: the attempt also loses a race against a timer.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        reject(error);
      }, this.timeoutMs);
    });
    const attempt = async (): Promise<HttpResponse> => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body !== null) headers["Content-Type"] = "application/json";
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== null ? { body } : {}),
        ...(controller !== null ? { signal: controller.signal } : {}),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: res.status, body: parsed };
    };
    try {
      const pending = attempt();
      pending.catch(() => {}); // a late failure after the timeout must not be unhandled
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
