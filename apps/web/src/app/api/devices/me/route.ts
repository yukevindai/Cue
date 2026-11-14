import { getDeviceContext, requireDevice } from "@/server/devices";
import { handle } from "@/server/http";

/** Device-token auth only; cookie sessions are not accepted here. */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    return Response.json(await getDeviceContext(await requireDevice(req)));
  });
}
