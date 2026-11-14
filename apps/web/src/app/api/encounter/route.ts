import { requireSessionUser } from "@/server/auth";
import { getEncounterStatus } from "@/server/encounter";
import { handle } from "@/server/http";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json(await getEncounterStatus(user.id));
  });
}
