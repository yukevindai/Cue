"use client";

import { useState, type ComponentProps } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { Button } from "@/components/ui";

export function SignOutButton({
  className,
  variant = "secondary",
  children = "Sign out",
}: {
  className?: string;
  variant?: ComponentProps<typeof Button>["variant"];
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const { error } = await getBrowserSupabase().auth.signOut();
      if (error) throw error;
      window.location.assign("/sign-in");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} className={className} busy={busy} onClick={signOut}>
        {children}
      </Button>
      {failed ? (
        <p role="alert" className="mt-2 text-sm font-medium text-ember-deep">
          Couldn&rsquo;t sign you out. Check your connection and try again.
        </p>
      ) : null}
    </>
  );
}
