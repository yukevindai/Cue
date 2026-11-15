import { GuestInput, GuestResult } from "@cue/contracts";
import { clientAddress, createWebGuest, guestRateLimit, requireGuestsEnabled } from "@/server/guests";
import { handle, parseBody } from "@/server/http";

/** POST /api/guest (no auth, demo only): a name-only account, signed in through the response cookies. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    requireGuestsEnabled();
    guestRateLimit("guest", clientAddress(req));
    const { intro } = await parseBody(req, GuestInput);
    return Response.json(GuestResult.parse(await createWebGuest(intro)), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
