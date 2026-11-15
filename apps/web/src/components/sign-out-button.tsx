"use client";

import { useState, type ComponentProps } from "react";
import { api } from "@/lib/api";
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
      // Signing out turns Encounter mode off, so Cue forgets this phone's
      // location and drops a pending signal. Best effort: a failure here must
      // not keep someone signed in.
      await api.setEncounterMode(false).catch(() => undefined);
      const { error } = await getBrowserSupabase().auth.signOut();
      if (error) throw error;
      // Full navigation on purpose: server-rendered state must reset.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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
