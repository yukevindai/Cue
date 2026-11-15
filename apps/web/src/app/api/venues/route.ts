import { CreateVenueInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { createVenue } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

/** POST CreateVenueInput -> EncounterStatus: creates a venue and checks the caller in. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, CreateVenueInput);
    return Response.json(await createVenue(user.id, input.name));
  });
}
