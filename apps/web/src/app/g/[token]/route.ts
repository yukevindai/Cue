import { redirect } from "next/navigation";
import { guestsEnabled } from "@/server/guest-config";
import { redeemHandoff } from "@/server/guests";

/**
 * GET /g/[token]: a guest handoff link (demo only). Signs this browser into the
 * guest account and goes to Encounter; any failure goes to sign-in with no
 * detail. Supabase makes the token single-use and short-lived.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!guestsEnabled()) return new Response("Not found", { status: 404 });
  const { token } = await params;
  let ok = false;
  try {
    ok = await redeemHandoff(token);
  } catch {
    ok = false;
  }
  redirect(ok ? "/encounter" : "/sign-in");
}
