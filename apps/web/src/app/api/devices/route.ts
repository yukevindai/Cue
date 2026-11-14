import { requireSessionUser } from "@/server/auth";
import { unlinkDevice } from "@/server/devices";
import { handle } from "@/server/http";

export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    await unlinkDevice(user.id);
    return new Response(null, { status: 204 });
  });
}
