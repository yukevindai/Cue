import { requireSessionUser } from "@/server/auth";
import { handle } from "@/server/http";
import { unmatch } from "@/server/matches";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    await unmatch(id, user.id);
    return new Response(null, { status: 204 });
  });
}
