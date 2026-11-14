import "server-only";

import { WingmanSuggestion } from "@cue/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredSuggestion } from "./types";

const TABLE = "wingman_suggestions";
const Stored = WingmanSuggestion.omit({ cached: true });

/** Cache of validated results, one current entry per match and requester. */
export interface SuggestionCache {
  get(matchId: string, requesterId: string, cacheKey: string): Promise<StoredSuggestion | null>;
  put(matchId: string, requesterId: string, cacheKey: string, payload: StoredSuggestion): Promise<void>;
}

/**
 * `wingman_suggestions` (backend-owned table). A row is served only when its
 * cache_key equals the key computed for this request, so a profile or sharing
 * change makes older rows unreachable; the backend deletes rows when the match
 * ends. Cache failures never fail the request.
 */
export function supabaseSuggestionCache(db: SupabaseClient): SuggestionCache {
  return {
    async get(matchId, requesterId, cacheKey) {
      const { data, error } = await db
        .from(TABLE)
        .select("payload")
        .eq("match_id", matchId)
        .eq("requester_id", requesterId)
        .eq("cache_key", cacheKey)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) {
        console.warn("wingman cache read failed:", error.code);
        return null;
      }
      const parsed = Stored.safeParse(data?.[0]?.payload);
      return parsed.success && parsed.data.matchId === matchId ? parsed.data : null;
    },

    async put(matchId, requesterId, cacheKey, payload) {
      const stale = await db.from(TABLE).delete().eq("match_id", matchId).eq("requester_id", requesterId);
      const { error } = stale.error
        ? stale
        : await db
            .from(TABLE)
            .insert({ match_id: matchId, requester_id: requesterId, cache_key: cacheKey, payload });
      if (error) console.warn("wingman cache write failed:", error.code);
    },
  };
}
