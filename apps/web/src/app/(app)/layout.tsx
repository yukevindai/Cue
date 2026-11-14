import { redirect } from "next/navigation";
import { AccountGuard } from "@/components/account-guard";
import { AppShell } from "@/components/app-shell";
import { LiveProvider } from "@/components/live-provider";
import { getSessionUser } from "@/server/auth";

/** Everything under (app) requires a signed-in user. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return (
    <LiveProvider userId={user.id} email={user.email}>
      <AccountGuard userId={user.id} />
      <AppShell>{children}</AppShell>
    </LiveProvider>
  );
}
