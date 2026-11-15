import { CheckInInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { checkIn } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

/** POST CheckInInput -> EncounterStatus; 404 not_found for an unknown or inactive code. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, CheckInInput);
    return Response.json(await checkIn(user.id, input.code));
  });
}
