import "server-only";

import { HttpError } from "@/server/http";
import { getAdminSupabase } from "@/server/supabase-admin";

/** Blocks and ends any active match. Unknown ids succeed silently (no account-existence oracle). */
export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) throw new HttpError("invalid_request", "You cannot block yourself");
  const { error } = await getAdminSupabase().rpc("block_user", {
    p_blocker_id: blockerId,
    p_blocked_id: blockedId,
  });
  if (error && error.code !== "23503") throw new Error(`database error ${error.code}: ${error.message}`);
}
