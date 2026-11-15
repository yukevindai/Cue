import { SendMessageInput } from "@cue/contracts";
import { requireSessionUser } from "@/server/auth";
import { listMessages, sendMessage } from "@/server/chat";
import { handle, parseBody } from "@/server/http";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET /api/matches/[id]/messages[?before=<cursor>] -> MessageList. session only.
 * Newest page oldest-first; without a cursor it also marks the conversation read.
 * 404 not_found unless the caller is a participant of this ACTIVE match.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    const before = new URL(req.url).searchParams.get("before");
    return Response.json(await listMessages(id, user.id, before), { headers: NO_STORE });
  });
}

/**
 * POST /api/matches/[id]/messages SendMessageInput -> ChatMessage. session only.
 * 201 when stored now; 200 with the already stored message when this clientId
 * was sent before (a retry). 429 rate_limited past 20 messages per 10 s.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await requireSessionUser();
    const { id } = await params;
    const input = await parseBody(req, SendMessageInput);
    const { message, created } = await sendMessage(id, user.id, input);
    return Response.json(message, { status: created ? 201 : 200, headers: NO_STORE });
  });
}
