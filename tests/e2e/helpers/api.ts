import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";
import {
  ApiError,
  BlockInput,
  ChatMessage,
  CreateSessionInput,
  DemoResetInput,
  DeviceClaimInput,
  DeviceClaimResult,
  DeviceContext,
  EncounterModeInput,
  EncounterStatus,
  InterestAck,
  InterestEvent,
  JoinSessionInput,
  MatchCard,
  MatchList,
  MessageList,
  OwnProfile,
  PairingCode,
  ProfileInput,
  WingmanSuggestion,
  routes,
} from "@cue/contracts";

/**
 * Typed result of one API call. 2xx bodies are parsed with the contract schema
 * and non-2xx bodies with `ApiError`; a body that does not match throws, so a
 * route that drifts from the contract fails the test that touches it.
 */
export interface ApiResult<T> {
  status: number;
  ok: boolean;
  /** Parsed success body (undefined for 204 routes and for failures). */
  data: T | undefined;
  /** Parsed ApiError (undefined on success). */
  error: ApiError["error"] | undefined;
  /** Raw response text, for leak scans. */
  text: string;
}

async function call<T>(
  ctx: APIRequestContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { body?: unknown; schema?: z.ZodType<T> } = {},
): Promise<ApiResult<T>> {
  const res = await ctx.fetch(path, {
    method,
    data: opts.body,
    failOnStatusCode: false,
    // Never follow redirects: an auth redirect to /login must show up as a failure.
    maxRedirects: 0,
  });
  const status = res.status();
  const text = await res.text();
  const ok = status >= 200 && status < 300;
  const where = `${method} ${path} -> ${status}`;
  if (ok) {
    if (!opts.schema || status === 204) return { status, ok, data: undefined, error: undefined, text };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${where}: body is not JSON: ${text.slice(0, 200)}`);
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${where}: body violates contract: ${parsed.error.message}\n${text.slice(0, 500)}`);
    }
    return { status, ok, data: parsed.data, error: undefined, text };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${where}: error body is not JSON (not an ApiError): ${text.slice(0, 200)}`);
  }
  const parsed = ApiError.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${where}: error body is not an ApiError: ${text.slice(0, 300)}`);
  }
  return { status, ok, data: undefined, error: parsed.data.error, text };
}

/** Unwraps a successful result or throws with the failure details. */
export function must<T>(r: ApiResult<T>, what = "request"): T {
  if (!r.ok) {
    throw new Error(`${what} failed: ${r.status} ${r.error?.code ?? ""} ${r.error?.message ?? r.text}`);
  }
  return r.data as T;
}

type Input<S extends z.ZodType> = z.input<S>;

/** One method per route in `routes` (packages/contracts/src/routes.ts). */
export function apiFor(ctx: APIRequestContext) {
  return {
    ctx,
    getProfile: () => call(ctx, "GET", routes.profile, { schema: OwnProfile }),
    putProfile: (body: Input<typeof ProfileInput>) =>
      call(ctx, "PUT", routes.profile, { body, schema: OwnProfile }),
    getEncounter: () => call(ctx, "GET", routes.encounter, { schema: EncounterStatus }),
    setMode: (enabled: boolean) =>
      call(ctx, "POST", routes.encounterMode, {
        body: { enabled } satisfies Input<typeof EncounterModeInput>,
        schema: EncounterStatus,
      }),
    createSession: (venueLabel: string) =>
      call(ctx, "POST", routes.demoSession, {
        body: { venueLabel } satisfies Input<typeof CreateSessionInput>,
        schema: EncounterStatus,
      }),
    joinSession: (joinCode: string) =>
      call(ctx, "POST", routes.demoSessionJoin, {
        body: { joinCode } satisfies Input<typeof JoinSessionInput>,
        schema: EncounterStatus,
      }),
    reset: (leave = false) =>
      call(ctx, "POST", routes.demoReset, {
        body: { leave } satisfies Input<typeof DemoResetInput>,
        schema: EncounterStatus,
      }),
    /** Body is sent as given (use `rawBody` helpers in tests for invalid shapes). */
    interest: (body: Input<typeof InterestEvent> | Record<string, unknown>) =>
      call(ctx, "POST", routes.interest, { body, schema: InterestAck }),
    listMatches: () => call(ctx, "GET", routes.matches, { schema: MatchList }),
    getMatch: (id: string) => call(ctx, "GET", routes.match(id), { schema: MatchCard }),
    unmatch: (id: string) => call<void>(ctx, "POST", routes.unmatch(id)),
    suggestions: (id: string) =>
      call(ctx, "POST", routes.suggestions(id), { body: {}, schema: WingmanSuggestion }),
    /** Newest page, or the page before `before`. `before` is sent as given (tests tamper with it). */
    listMessages: (id: string, before?: string) =>
      call(ctx, "GET", `${routes.messages(id)}${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`, {
        schema: MessageList,
      }),
    /** Body is sent as given, so tests can send invalid or extra keys. */
    sendMessage: (id: string, body: Record<string, unknown>) =>
      call(ctx, "POST", routes.messages(id), { body, schema: ChatMessage }),
    block: (userId: string) =>
      call<void>(ctx, "POST", routes.blocks, { body: { userId } satisfies Input<typeof BlockInput> }),
    devicePair: () => call(ctx, "POST", routes.devicePair, { body: {}, schema: PairingCode }),
    deviceClaim: (body: Input<typeof DeviceClaimInput>) =>
      call(ctx, "POST", routes.deviceClaim, { body, schema: DeviceClaimResult }),
    deviceMe: () => call(ctx, "GET", routes.deviceMe, { schema: DeviceContext }),
    deviceUnlink: () => call<void>(ctx, "DELETE", routes.deviceUnlink),
  };
}
export type Api = ReturnType<typeof apiFor>;

/** Builds a valid InterestEvent. `source` defaults to the web confirm path. */
export function interestEvent(
  sessionId: string,
  opts: {
    source?: "web_demo" | "mentra_touch" | "headset_remote" | "spectacles_hand";
    /** Overrides the default gesture for the source (`media_next_track` for headset_remote). */
    gesture?: "media_next_track" | "media_previous_track" | "media_play_pause";
    eventId?: string;
  } = {},
): Input<typeof InterestEvent> {
  const source = opts.source ?? "web_demo";
  const defaultGesture =
    source === "mentra_touch"
      ? "backward_swipe"
      : source === "headset_remote"
        ? "media_next_track"
        : source === "spectacles_hand"
          ? "double_pinch"
          : "web_confirm";
  return {
    eventId: opts.eventId ?? randomUUID(),
    encounterSessionId: sessionId,
    source,
    gesture: opts.gesture ?? defaultGesture,
    occurredAt: new Date().toISOString(),
  };
}

type Ack = z.infer<typeof InterestAck>;

/**
 * Interprets an interest response. The contract says every ack is HTTP 200
 * (`accepted | duplicate | rejected`), but ApiErrorCode also lists
 * not_in_session / encounter_mode_off / blocked, so the backend could answer a
 * rejection either way. Tests that only care about "this signal was refused"
 * use this to accept both encodings.
 */
export function interestOutcome(
  r: ApiResult<Ack>,
): { kind: "ack"; ack: Ack } | { kind: "error"; status: number; code: string } {
  if (r.data) return { kind: "ack", ack: r.data };
  return { kind: "error", status: r.status, code: r.error?.code ?? "unknown" };
}

/** True if the signal was refused for `reason` (as an ack rejection or the matching ApiError code). */
export function wasRejected(r: ApiResult<Ack>, reason: "not_in_session" | "encounter_mode_off" | "blocked" | "already_matched"): boolean {
  const o = interestOutcome(r);
  if (o.kind === "ack") return o.ack.status === "rejected" && o.ack.reason === reason;
  return o.code === reason;
}

/** True if this response definitely did not complete a match. */
export function notMatched(r: ApiResult<Ack>): boolean {
  const o = interestOutcome(r);
  return o.kind === "ack" ? o.ack.matched === false : true;
}
