"use client";

import { isGuestEmail } from "@cue/contracts";
import { useState, type ComponentProps } from "react";
import { useMaybeLive } from "@/components/live-provider";
import { api } from "@/lib/api";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { Button, ConfirmDialog } from "@/components/ui";

export const GUEST_SIGN_OUT_WARNING =
  "This is a guest account with no password. If you sign out you won't be able to get back into it.";

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
  const [confirming, setConfirming] = useState(false);
  const live = useMaybeLive();
  // A guest has no password: signing out loses the account, so ask first.
  const isGuest = Boolean(live?.profile?.isGuest) || isGuestEmail(live?.email);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      // Signing out turns Encounter mode off, so SocialEyes forgets this phone's
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
      <Button
        variant={variant}
        className={className}
        busy={busy && !confirming}
        onClick={() => (isGuest ? setConfirming(true) : void signOut())}
      >
        {children}
      </Button>
      {confirming ? (
        <ConfirmDialog
          title="Sign out of this guest account?"
          confirmLabel="Sign out anyway"
          cancelLabel="Stay"
          danger
          busy={busy}
          error={failed ? "Couldn't sign you out. Check your connection and try again." : null}
          onConfirm={() => void signOut()}
          onCancel={() => {
            if (!busy) setConfirming(false);
          }}
        >
          <p>{GUEST_SIGN_OUT_WARNING}</p>
        </ConfirmDialog>
      ) : null}
      {failed && !confirming ? (
        <p role="alert" className="mt-2 text-sm font-medium text-ember-deep">
          Couldn&rsquo;t sign you out. Check your connection and try again.
        </p>
      ) : null}
    </>
  );
}
