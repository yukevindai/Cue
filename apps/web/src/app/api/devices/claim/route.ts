import { DeviceClaimInput } from "@cue/contracts";
import { claimDevice } from "@/server/devices";
import { handle, parseBody } from "@/server/http";

/** Unauthenticated: the pairing code is the credential. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const input = await parseBody(req, DeviceClaimInput);
    const clientKey = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    return Response.json(await claimDevice(input, clientKey));
  });
}
