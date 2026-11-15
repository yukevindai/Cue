import {
  ApiError,
  type ApiErrorCode,
  type BlockInput,
  ChatMessage,
  type CheckInInput,
  type CreateVenueInput,
  type DemoResetInput,
  EncounterStatus,
  InterestAck,
  type InterestEvent,
  type LocationInput,
  MatchCard,
  MatchList,
  MessageList,
  OwnProfile,
  PairingCode,
  type ProfileInput,
  routes,
  type SendMessageInput,
  WingmanSuggestion,
} from "@cue/contracts";
import type { z } from "zod";

/**
 * Client-side error codes: every server `ApiErrorCode`, plus three that can
 * only originate in the browser.
 * - `network`: the request never got a response.
 * - `timeout`: we gave up waiting.
 * - `bad_response`: the body did not match the contract schema.
 */
export type ClientErrorCode = ApiErrorCode | "network" | "timeout" | "bad_response";

export class ApiRequestError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isApiError(err: unknown, code?: ClientErrorCode): err is ApiRequestError {
  return err instanceof ApiRequestError && (code === undefined || err.code === code);
}

/** Plain wording for an error, for states that have nothing more specific to say. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiRequestError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "network":
      return "Can't reach Cue right now. Check your connection and try again.";
    case "timeout":
    case "upstream_timeout":
      return "That took too long. Please try again.";
    case "unauthenticated":
      return "You've been signed out. Sign in again to continue.";
    case "rate_limited":
      return "That's a few too many tries in a row. Give it a moment.";
    case "encounter_mode_off":
      return "Encounter mode is off.";
    case "invalid_request":
      return err.message || "Some of that didn't look right.";
    case "not_found":
      return "That's no longer here.";
    case "forbidden":
    case "blocked":
      return "That isn't available.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    if (timedOut) throw new ApiRequestError("timeout", "Request timed out");
    if (opts.signal?.aborted) throw err;
    throw new ApiRequestError("network", "Network request failed");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (res.ok) return res;

  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    // fall through to the generic error below
  }
  const parsed = ApiError.safeParse(raw);
  if (parsed.success) {
    throw new ApiRequestError(parsed.data.error.code, parsed.data.error.message, res.status);
  }
  throw new ApiRequestError(
    res.status === 401 ? "unauthenticated" : res.status === 404 ? "not_found" : "internal",
    `Unexpected ${res.status} response`,
    res.status,
  );
}

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: RequestOptions = {},
): Promise<z.infer<S>> {
  const res = await send(path, opts);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiRequestError("bad_response", "Response was not JSON", res.status);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[cue] ${path} did not match its contract`, parsed.error.issues);
    throw new ApiRequestError("bad_response", "Response did not match the contract", res.status);
  }
  return parsed.data;
}

async function requestEmpty(path: string, opts: RequestOptions = {}): Promise<void> {
  await send(path, opts);
}

type Opt = { signal?: AbortSignal };

/** Typed client for every session-authenticated route in `@cue/contracts` `routes`. */
export const api = {
  /** The caller's profile, or `null` when it has not been created yet (404). */
  async getProfile(o: Opt = {}): Promise<OwnProfile | null> {
    try {
      return await request(routes.profile, OwnProfile, o);
    } catch (err) {
      if (isApiError(err, "not_found")) return null;
      throw err;
    }
  },
  saveProfile: (input: ProfileInput) =>
    request(routes.profile, OwnProfile, { method: "PUT", body: input }),

  getEncounter: (o: Opt = {}) => request(routes.encounter, EncounterStatus, o),
  setEncounterMode: (enabled: boolean) =>
    request(routes.encounterMode, EncounterStatus, { method: "POST", body: { enabled } }),
  /** The phone's position while encounter mode is on. Never logged or stored client-side. */
  reportLocation: (input: LocationInput) =>
    request(routes.encounterLocation, EncounterStatus, { method: "POST", body: input }),
  forgetLocation: () => request(routes.encounterLocation, EncounterStatus, { method: "DELETE" }),
  /** Creates a venue and checks the caller in. */
  createVenue: (input: CreateVenueInput) =>
    request(routes.venues, EncounterStatus, { method: "POST", body: input }),
  /** 404 (`not_found`) for an unknown code. */
  checkIn: (input: CheckInInput) =>
    request(routes.venueCheckIn, EncounterStatus, { method: "POST", body: input }),
  checkOut: () => request(routes.venueCheckOut, EncounterStatus, { method: "POST" }),
  resetDemo: (input: Partial<DemoResetInput> = {}) =>
    request(routes.demoReset, EncounterStatus, { method: "POST", body: input }),

  sendInterest: (event: InterestEvent) =>
    request(routes.interest, InterestAck, { method: "POST", body: event }),

  getMatches: (o: Opt = {}) => request(routes.matches, MatchList, o),
  getMatch: (id: string, o: Opt = {}) => request(routes.match(id), MatchCard, o),
  unmatch: (id: string) => requestEmpty(routes.unmatch(id), { method: "POST" }),
  block: (input: BlockInput) => requestEmpty(routes.blocks, { method: "POST", body: input }),
  /** Claude can take a while; allow longer than the default before calling it a timeout. */
  getSuggestions: (id: string, o: Opt = {}) =>
    request(routes.suggestions(id), WingmanSuggestion, { method: "POST", timeoutMs: 30_000, ...o }),

  /** Newest page without `before` (this also marks the conversation read); older pages with it. */
  listMessages: (id: string, o: Opt & { before?: string | null } = {}) =>
    request(
      o.before ? `${routes.messages(id)}?before=${encodeURIComponent(o.before)}` : routes.messages(id),
      MessageList,
      { signal: o.signal },
    ),
  /** Idempotent per `clientId`: retry with the same id after a failure. */
  sendMessage: (id: string, input: SendMessageInput) =>
    request(routes.messages(id), ChatMessage, { method: "POST", body: input }),

  createPairingCode: () => request(routes.devicePair, PairingCode, { method: "POST" }),
  unlinkDevice: () => requestEmpty(routes.deviceUnlink, { method: "DELETE" }),
};
