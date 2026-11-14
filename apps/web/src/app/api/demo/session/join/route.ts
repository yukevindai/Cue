import { JoinSessionInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { joinSession } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, JoinSessionInput);
    return Response.json(await joinSession(user.id, input.joinCode));
  });
}
