import { CreateSessionInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { createSession } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, CreateSessionInput);
    return Response.json(await createSession(user.id, input.venueLabel));
  });
}
