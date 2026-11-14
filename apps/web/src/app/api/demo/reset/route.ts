import { DemoResetInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { resetDemo } from "@/server/encounter";
import { handle, parseBody } from "@/server/http";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    // The body is optional: a missing or empty body means {}.
    const text = await req.text();
    const input = text.trim()
      ? await parseBody(new Request(req.url, { method: "POST", body: text }), DemoResetInput)
      : DemoResetInput.parse({});
    return Response.json(await resetDemo(user.id, input.leave));
  });
}
