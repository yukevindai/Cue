import { EncounterModeInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { setEncounterMode } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, EncounterModeInput);
    return Response.json(await setEncounterMode(user.id, input.enabled));
  });
}
