import { DeviceHypeInput, HypeLine } from "@cue/contracts";
import { requireDevice } from "@/server/devices";
import { hypeLineFor } from "@/server/hype";
import { handle, parseBody } from "@/server/http";

/** POST /api/devices/hype (device token) -> HypeLine; 404 unless the wearer is in that active match. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const device = await requireDevice(req);
    const { matchId } = await parseBody(req, DeviceHypeInput);
    return Response.json(HypeLine.parse(await hypeLineFor(matchId, device.userId)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  });
}
