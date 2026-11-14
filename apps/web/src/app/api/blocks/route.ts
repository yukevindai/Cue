import { BlockInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { blockUser } from "@/server/blocks";
import { handle, parseBody } from "@/server/http";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, BlockInput);
    await blockUser(user.id, input.userId);
    return new Response(null, { status: 204 });
  });
}
