import { Uuid, WingmanSuggestion } from "@cue/contracts";
import { supabaseSuggestionCache } from "@/server/ai/cache";
import { getAnthropicClient, modelConfigFromEnv } from "@/server/ai/model";
import { MODEL_CALLS_PER_MINUTE, RateLimiter, REQUESTS_PER_MINUTE } from "@/server/ai/rate-limit";
import { getWingmanSuggestion, WingmanError } from "@/server/ai/wingman";
import { requireSessionUser } from "@/server/auth";
import { handle, HttpError } from "@/server/http";
import { getWingmanMatchContext } from "@/server/matches";
import { getAdminSupabase } from "@/server/supabase-admin";

const requestLimiter = new RateLimiter(REQUESTS_PER_MINUTE, 60_000);
const modelLimiter = new RateLimiter(MODEL_CALLS_PER_MINUTE, 60_000);

/** POST /api/matches/[id]/suggestions -> WingmanSuggestion, for the requester only. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    // An id that cannot be a match looks the same as one the caller may not see.
    if (!Uuid.safeParse(id).success) throw new HttpError("not_found", "Match not found");

    try {
      const suggestion = await getWingmanSuggestion(id, user.id, {
        getContext: getWingmanMatchContext,
        cache: supabaseSuggestionCache(getAdminSupabase()),
        requestLimiter,
        modelLimiter,
        getClient: getAnthropicClient,
        config: modelConfigFromEnv(),
      });
      return Response.json(WingmanSuggestion.parse(suggestion), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (err) {
      if (err instanceof WingmanError) throw new HttpError(err.code, err.message);
      throw err;
    }
  });
}
