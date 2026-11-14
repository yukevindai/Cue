import { requireSessionUser } from "@/server/auth";
import { startPairing } from "@/server/devices";
import { handle } from "@/server/http";

export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json(await startPairing(user.id));
  });
}
