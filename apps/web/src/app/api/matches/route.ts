import { requireSessionUser } from "@/server/auth";
import { handle } from "@/server/http";
import { listMatches } from "@/server/matches";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json({ matches: await listMatches(user.id) });
  });
}
