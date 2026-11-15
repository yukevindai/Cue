import { DEVICE_LABEL, REQUEST_TIMEOUT_MS, RETRY_BACKOFF_MS, ROUTES, SUBMIT_BUDGET_MS } from "./config";
import type { ContextFetchResult } from "./encounter-context";
import type { HttpResponse, HttpTransport, Sleep } from "./http";
import { silentLogger, type Logger } from "./logger";
import {
  normalizePairingCode,
  parseDeviceClaimResult,
  parseDeviceContext,
  parseInterestAck,
  type DeviceClaimInput,
  type DeviceClaimResult,
  type InterestAck,
  type InterestEvent,
} from "./wire";

export type ClaimResult =
  | { ok: true; result: DeviceClaimResult; error?: undefined }
  | { ok: false; error: "invalid_code" | "network" | "server" | "invalid_response"; result?: undefined };

/** Result of sending one InterestEvent (including retries, which reuse the same eventId). */
export type SubmitResult =
  | { ok: true; ack: InterestAck; error?: undefined }
  | { ok: false; error: "network" | "unauthorized" | "server" | "invalid_response"; ack?: undefined };

export interface CueApiClientOptions {
  /** Cue web origin, e.g. https://cue-gamma-five.vercel.app (no trailing path). */
  baseUrl: string;
  getToken: () => string | null;
  transport: HttpTransport;
  sleep: Sleep;
  now?: () => number;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Client for the three device endpoints. Mirrors apps/mentra/src/api-client.ts:
 * device token as a Bearer header, bounded retry of a submit with the
 * byte-identical body (same eventId, the server's idempotency key), nothing
 * queued for later. Never logs the token, the Authorization header or the code.
 */
export class CueApiClient {
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly timeoutMs: number;

  constructor(private readonly options: CueApiClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async claimDevice(rawCode: string): Promise<ClaimResult> {
    const code = normalizePairingCode(rawCode);
    if (code === null) return { ok: false, error: "invalid_code" };
    const input: DeviceClaimInput = { code, deviceLabel: DEVICE_LABEL, mentraUserId: null };

    let res: HttpResponse;
    try {
      res = await this.request("POST", ROUTES.deviceClaim, null, JSON.stringify(input));
    } catch (error) {
      this.log.warn("device claim failed", { error: errorKind(error) });
      return { ok: false, error: "network" };
    }
    this.log.debug("device claim response", { status: res.status });
    if (res.status >= 500) return { ok: false, error: "server" };
    if (res.status >= 400) return { ok: false, error: "invalid_code" };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: "server" };
    const result = parseDeviceClaimResult(parseJson(res.text));
    return result === null ? { ok: false, error: "invalid_response" } : { ok: true, result };
  }

  /** One GET, no retries: the caller polls. */
  async getDeviceContext(): Promise<ContextFetchResult> {
    const token = this.options.getToken();
    if (token === null) return { ok: false, reason: "unlinked" };

    let res: HttpResponse;
    try {
      res = await this.request("GET", ROUTES.deviceMe, token, null);
    } catch (error) {
      this.log.debug("device context unreachable", { error: errorKind(error) });
      return { ok: false, reason: "offline" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unlinked" };
    if (res.status !== 200) return { ok: false, reason: "offline" };
    const context = parseDeviceContext(parseJson(res.text));
    return context === null ? { ok: false, reason: "offline" } : { ok: true, context };
  }

  /**
   * POST the event. Retries only on network failure/timeout and 5xx, at most 3
   * attempts inside a 4000 ms budget, always with the same body.
   */
  async submitInterest(event: InterestEvent): Promise<SubmitResult> {
    const token = this.options.getToken();
    if (token === null) return { ok: false, error: "unauthorized" };

    const body = JSON.stringify(event);
    const startedAt = this.now();
    let lastFailure: "network" | "server" = "network";

    for (let attempt = 1; attempt <= RETRY_BACKOFF_MS.length + 1; attempt++) {
      if (attempt > 1) {
        const delay = RETRY_BACKOFF_MS[attempt - 2] ?? 0;
        if (this.now() - startedAt + delay > SUBMIT_BUDGET_MS) break;
        await this.options.sleep(delay);
        if (this.now() - startedAt > SUBMIT_BUDGET_MS) break;
      }

      let res: HttpResponse;
      try {
        res = await this.request("POST", ROUTES.interest, token, body);
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
      const ack = parseInterestAck(parseJson(res.text));
      return ack === null ? { ok: false, error: "invalid_response" } : { ok: true, ack };
    }
    return { ok: false, error: lastFailure };
  }

  /** One attempt that loses a race against the timeout. Throws on network failure or timeout. */
  private async request(
    method: "GET" | "POST",
    path: string,
    token: string | null,
    body: string | null,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (token !== null) headers.Authorization = `Bearer ${token}`;

    const pending = this.options.transport({ method, url: `${this.baseUrl}${path}`, headers, body });
    pending.catch(() => {}); // a late failure after the timeout must not be unhandled
    let timedOut = false;
    const timeout = this.options.sleep(this.timeoutMs).then(() => {
      timedOut = true;
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    });
    timeout.catch(() => {});
    const res = await Promise.race([pending, timeout]);
    if (timedOut) throw new Error("request timed out");
    return res;
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
