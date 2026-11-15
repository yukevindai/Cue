"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Card, Notice } from "@/components/ui";
import { api, describeError } from "@/lib/api";
import { cx } from "@/lib/cx";

export const LOCATION_PRIVACY_TEXT =
  "SocialEyes uses your phone's location only while Encounter mode is on, to tell who is near you. It is never shown to anyone and never saved with a match.";

/**
 * Encounter mode: the first thing on the page, one switch. Turning it on is
 * what asks the browser for location (the reporter in LiveProvider starts
 * watching once the server says the mode is on), so the reason is written
 * right under the switch, before the browser's prompt appears.
 */
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
        `${next ? "Couldn't turn Encounter mode on." : "Couldn't turn Encounter mode off, so it is still on."} ${describeError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-labelledby="mode-title">
      <div className="flex items-center justify-between gap-4">
        <h2 id="mode-title" className="font-display text-2xl leading-tight tracking-tight">
          Encounter mode
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="mode-title"
          aria-describedby="mode-privacy"
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void setMode(!enabled)}
          className={cx(
            "relative h-10 w-[4.5rem] shrink-0 rounded-full border transition-colors disabled:opacity-55",
            enabled ? "border-moss bg-moss" : "border-line-strong bg-sunk",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "absolute top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-white shadow transition-[left]",
              enabled ? "left-[2.2rem]" : "left-1",
            )}
          />
        </button>
      </div>

      <p role="status" className="mt-2 font-medium">
        {enabled
          ? "On. Your signals can match with someone near you."
          : "Off. Signals from your glasses and this page are ignored."}
      </p>
      <p id="mode-privacy" className="mt-2 text-ink-soft">
        {LOCATION_PRIVACY_TEXT}
      </p>
      {enabled ? (
        <p className="mt-2 text-sm text-ink-soft">
          Turning it off cancels a signal you&apos;ve sent and makes SocialEyes forget your location.
        </p>
      ) : null}

      {error ? (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      ) : null}
    </Card>
  );
}
