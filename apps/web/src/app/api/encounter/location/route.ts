import { LocationInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { clearLocation, reportLocation } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

/**
 * POST LocationInput -> EncounterStatus. Stored only while encounter mode is
 * on; with mode off nothing is stored and the status is returned unchanged.
 * The response never contains coordinates.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, LocationInput);
    return Response.json(await reportLocation(user.id, input));
  });
}

/** DELETE -> EncounterStatus. Forgets the caller's location. */
export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json(await clearLocation(user.id));
  });
}
