import { requireSessionUser } from "@/server/auth";
import { checkOut } from "@/server/encounter";
import { handle } from "@/server/http";

/** POST -> EncounterStatus. Leaves the venue and cancels a pending signal. */
export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json(await checkOut(user.id));
  });
}
