import { InterestEvent } from "@cue/contracts";
import { handle, parseBody } from "@/server/http";
import { authenticateInterestCaller, submitInterest } from "@/server/interest";

/** POST InterestEvent -> InterestAck. Cookie session (web_demo) or device token (mentra_touch). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const caller = await authenticateInterestCaller(req);
    const event = await parseBody(req, InterestEvent);
    return Response.json(await submitInterest(caller, event));
  });
}
