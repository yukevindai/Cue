import "server-only";

import { createHash } from "node:crypto";
import type { ApiErrorCode, WingmanSuggestion } from "@cue/contracts";
import type { SuggestionCache } from "./cache";
import { buildModelInput, groundModelOutput, hasUsableText, noOverlapResult, type GroundedResult } from "./grounding";
import { callWingmanModel, WingmanUpstreamError, type ModelConfig, type WingmanModelClient } from "./model";
import { PROMPT_VERSION } from "./prompt";
import type { RateLimiter } from "./rate-limit";
import type { ModelInput, StoredSuggestion, WingmanMatchContext } from "./types";

/** Maps to an ApiError in the route. Kept free of `@/` imports so it is unit-testable. */
export class WingmanError extends Error {
  constructor(
    readonly code: Extract<ApiErrorCode, "rate_limited" | "upstream_timeout" | "upstream_error">,
    message: string,
  ) {
    super(message);
  }
}

export interface WingmanDeps {
  /** Throws (not_found) unless `userId` participates in the active match. Called on every request. */
  getContext(matchId: string, userId: string): Promise<WingmanMatchContext>;
  cache: SuggestionCache;
  requestLimiter: RateLimiter;
  modelLimiter: RateLimiter;
  /** Lazy so a missing key only matters when a model call is actually needed. */
  getClient(): WingmanModelClient;
  config: ModelConfig;
  now?: () => Date;
}

/** Backend key (profile versions + sharing) plus a hash of exactly what the model would see. */
function cacheKeyFor(ctx: WingmanMatchContext, input: ModelInput, model: string): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
  return [ctx.cacheKey, PROMPT_VERSION, model, digest].join("|");
}

/**
 * The "Find common ground" card for one requester. Order matters:
 * rate limit, access check, cache, then (only if needed) the model.
 * The result is returned to the requester only; nothing is written anywhere
 * the other person can read.
 */
export async function getWingmanSuggestion(
  matchId: string,
  userId: string,
  deps: WingmanDeps,
): Promise<WingmanSuggestion> {
  if (!deps.requestLimiter.take(userId)) {
    throw new WingmanError("rate_limited", "Too many requests. Try again in a minute.");
  }

  // Access is rechecked before anything is served, including cached results.
  const ctx = await deps.getContext(matchId, userId);
  const input = buildModelInput(ctx);
  const cacheKey = cacheKeyFor(ctx, input, deps.config.model);

  const hit = await deps.cache.get(ctx.matchId, userId, cacheKey);
  if (hit) return { ...hit, cached: true };

  let grounded: GroundedResult;
  if (!hasUsableText(input.you) || !hasUsableText(input.them)) {
    // Nothing to compare (empty profile or AI assist off): no model call, no profile text leaves the server.
    grounded = noOverlapResult(input.venueLabel);
  } else {
    if (!deps.modelLimiter.take(userId)) {
      throw new WingmanError("rate_limited", "Too many requests. Try again in a minute.");
    }
    try {
      const output = await callWingmanModel(input, deps.getClient(), deps.config);
      grounded = groundModelOutput(output, input);
    } catch (err) {
      if (!(err instanceof WingmanUpstreamError)) throw err;
      console.warn(`wingman upstream ${err.kind}: ${err.detail}`);
      throw err.kind === "timeout"
        ? new WingmanError("upstream_timeout", "The suggestion took too long. Try again.")
        : new WingmanError("upstream_error", "Suggestions are unavailable right now. Try again.");
    }
    if (grounded.dropped > 0) console.warn(`wingman dropped ${grounded.dropped} ungrounded claim(s)`);
  }

  const stored: StoredSuggestion = {
    matchId: ctx.matchId,
    sharedInterests: grounded.sharedInterests,
    suggestedQuestion: grounded.suggestedQuestion,
    openerBasis: grounded.openerBasis,
    noOverlap: grounded.noOverlap,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.cache.put(ctx.matchId, userId, cacheKey, stored);
  return { ...stored, cached: false };
}
