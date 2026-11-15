import { GuestHandoff } from "@cue/contracts";
import { requireDevice } from "@/server/devices";
import { clientAddress, createHandoff, guestRateLimit, requireGuestsEnabled } from "@/server/guests";
import { handle } from "@/server/http";

/** POST /api/guest/handoff (device token, demo only): one-time link that signs a phone into the guest account. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    requireGuestsEnabled();
    guestRateLimit("guest-handoff", clientAddress(req));
    const device = await requireDevice(req);
    return Response.json(GuestHandoff.parse(await createHandoff(device)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
