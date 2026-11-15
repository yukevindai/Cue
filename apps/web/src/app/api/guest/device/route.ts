import { GuestDeviceInput, GuestDeviceResult } from "@cue/contracts";
import { clientAddress, createDeviceGuest, guestRateLimit, requireGuestsEnabled } from "@/server/guests";
import { handle, parseBody } from "@/server/http";

/** POST /api/guest/device (no auth, demo only): a guest from a spoken introduction, linked to the calling glasses. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    requireGuestsEnabled();
    guestRateLimit("guest-device", clientAddress(req));
    const input = await parseBody(req, GuestDeviceInput);
    return Response.json(GuestDeviceResult.parse(await createDeviceGuest(input)), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
