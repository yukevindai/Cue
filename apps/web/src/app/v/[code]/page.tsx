import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth";

export const metadata = { title: "Check in" };

/**
 * What a venue's QR code opens. Signed in: on to Encounter, which checks the
 * person in and confirms it. Signed out: to sign-in, which brings them back
 * here afterwards (`next` is checked there with `safeReturnPath`).
 *
 * This lives outside the (app) group on purpose: that group's layout sends
 * signed-out visitors to plain `/sign-in` and cannot see the path they asked
 * for.
 */
export default async function VenueLinkPage(props: PageProps<"/v/[code]">) {
  const { code: raw } = await props.params;
  // Keep only what a code can contain; the check-in call validates the rest.
  const code = safeDecode(raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const user = await getSessionUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/v/${code}`)}`);
  redirect(`/encounter?venue=${encodeURIComponent(code)}`);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
