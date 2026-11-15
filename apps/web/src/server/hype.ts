import "server-only";

import type { HypeLine } from "@cue/contracts";
import { supabaseSuggestionCache } from "@/server/ai/cache";
import { getHypeLine, HypeCache, HypeError } from "@/server/ai/hype";
import { getAnthropicClient, modelConfigFromEnv } from "@/server/ai/model";
import { MODEL_CALLS_PER_MINUTE, RateLimiter, REQUESTS_PER_MINUTE } from "@/server/ai/rate-limit";
import { HttpError } from "@/server/http";
import { getWingmanMatchContext } from "@/server/matches";
import { getAdminSupabase } from "@/server/supabase-admin";

/**
 * Production wiring for the spoken wingman line, shared by
 * POST /api/matches/[id]/hype (session) and POST /api/devices/hype (device).
 * Limits match the suggestions route: 30 requests and 6 model calls per user
 * per minute, for the hype line and separately for the suggestion it uses.
 */
const cache = new HypeCache();
const requestLimiter = new RateLimiter(REQUESTS_PER_MINUTE, 60_000);
const modelLimiter = new RateLimiter(MODEL_CALLS_PER_MINUTE, 60_000);
const wingmanRequestLimiter = new RateLimiter(REQUESTS_PER_MINUTE, 60_000);
const wingmanModelLimiter = new RateLimiter(MODEL_CALLS_PER_MINUTE, 60_000);

function hypeTimeoutMs(): number | undefined {
  const value = Number(process.env.HYPE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Throws HttpError(not_found) unless `userId` is in the active match, HttpError(rate_limited) when over the limit. */
export async function hypeLineFor(matchId: string, userId: string): Promise<HypeLine> {
  const config = modelConfigFromEnv();
  try {
    return await getHypeLine(matchId, userId, {
      getContext: getWingmanMatchContext,
      wingman: {
        cache: supabaseSuggestionCache(getAdminSupabase()),
        requestLimiter: wingmanRequestLimiter,
        modelLimiter: wingmanModelLimiter,
        getClient: getAnthropicClient,
        config,
      },
      cache,
      requestLimiter,
      modelLimiter,
      getClient: getAnthropicClient,
      config: { ...config, hypeTimeoutMs: hypeTimeoutMs() },
    });
  } catch (err) {
    if (err instanceof HypeError) throw new HttpError(err.code, err.message);
    throw err;
  }
}
