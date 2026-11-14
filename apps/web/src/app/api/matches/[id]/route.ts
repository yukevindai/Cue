import { requireSessionUser } from "@/server/auth";
import { handle } from "@/server/http";
import { getMatchCard } from "@/server/matches";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    return Response.json(await getMatchCard(id, user.id));
  });
}
