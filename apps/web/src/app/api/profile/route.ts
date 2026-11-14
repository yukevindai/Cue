import { ProfileInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { handle, parseBody } from "@/server/http";
import { getOwnProfile, saveOwnProfile } from "@/server/profiles";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    return Response.json(await getOwnProfile(user.id));
  });
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const input = await parseBody(req, ProfileInput);
    return Response.json(await saveOwnProfile(user.id, input));
  });
}
