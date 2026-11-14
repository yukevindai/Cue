"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, Notice, StatusPill } from "@/components/ui";
import { api, describeError } from "@/lib/api";

/** Encounter mode: one large control, so pausing is never more than a tap away. */
export function ModeCard({ enabled }: { enabled: boolean }) {
  const { applyEncounter } = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setMode(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      applyEncounter(await api.setEncounterMode(next));
    } catch (err) {
      setError(
        `${next ? "Couldn't resume." : "Couldn't pause, so you are still available."} ${describeError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-labelledby="mode-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="mode-title" className="font-display text-2xl leading-tight tracking-tight">
          Encounter mode
        </h2>
        <p role="status">
          {enabled ? (
            <StatusPill tone="on" pulse>
              Available
            </StatusPill>
          ) : (
            <StatusPill tone="off">Paused</StatusPill>
          )}
        </p>
      </div>

      {enabled ? (
        <>
          <p className="mt-2 text-ink-soft">
            Your signals count in this session. Pause whenever you like.
          </p>
          <Button variant="secondary" full className="mt-4" busy={busy} onClick={() => setMode(false)}>
            Pause
          </Button>
        </>
      ) : (
        <>
          <p className="mt-2">
            Paused. Signals from your glasses and this page are ignored until you resume. Pausing
            also cancels a signal you&apos;ve sent.
          </p>
          <Button full className="mt-4" busy={busy} onClick={() => setMode(true)}>
            Resume
          </Button>
        </>
      )}

      {error ? (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      ) : null}
    </Card>
  );
}
