import { HypeLine, Uuid } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { hypeLineFor } from "@/server/hype";
import { handle, HttpError } from "@/server/http";

/** POST /api/matches/[id]/hype -> HypeLine, for the requester only (404 unless in that active match). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    if (!Uuid.safeParse(id).success) throw new HttpError("not_found", "Match not found");
    return Response.json(HypeLine.parse(await hypeLineFor(id, user.id)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
