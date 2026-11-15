"use client";

import type { EncounterStatus } from "@cue/contracts";
import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, Notice, StatusPill } from "@/components/ui";
import { api, describeError } from "@/lib/api";
import { placeSummary, serverLocationText } from "@/lib/encounter";
import { locationLine } from "@/lib/location";

function formatUntil(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Where SocialEyes thinks you are: ready or not, the venue you're checked into, and
 * the phone location status. Never shows coordinates; the server never
 * returns them.
 */
export function PlaceCard({
  encounter,
  onShowQr,
}: {
  encounter: EncounterStatus;
  onShowQr: () => void;
}) {
  const { applyEncounter, geo, retryLocation } = useLive();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = placeSummary(encounter);
  const loc = locationLine(encounter.encounterMode, geo, serverLocationText(encounter));
  const { checkIn } = encounter;

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      applyEncounter(await api.checkOut());
    } catch (err) {
      setError(`You're still checked in. ${describeError(err)}`);
    } finally {
      setLeaving(false);
    }
  }

  return (
    <Card aria-labelledby="place-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="place-title" className="font-display text-2xl leading-tight tracking-tight">
          Where you are
        </h2>
        <p>
          {summary.tone === "ready" ? (
            <StatusPill tone="on" pulse>
              Ready
            </StatusPill>
          ) : summary.tone === "not_ready" ? (
            <StatusPill tone="wait">Not ready</StatusPill>
          ) : (
            <StatusPill tone="off">Off</StatusPill>
          )}
        </p>
      </div>

      <div role="status" aria-label="Place status" className="mt-2">
        <p className="font-display text-xl italic leading-snug">{summary.headline}</p>
        <p className="text-ink-soft">{summary.detail}</p>
      </div>

      <ul className="mt-4 divide-y divide-line border-y border-line">
        <li className="py-3">
          {checkIn ? (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="font-semibold break-words">Checked in at {checkIn.name}</p>
                <p className="text-sm text-ink-soft">
                  Until {formatUntil(checkIn.expiresAt)}, unless you leave first.
                </p>
              </div>
              <div className="flex gap-1">
                <Button variant="quiet" className="px-3" onClick={onShowQr}>
                  Show QR code
                </Button>
                <Button variant="quiet" className="-mr-3 px-3" busy={leaving} onClick={leave}>
                  Leave
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-ink-soft">Not checked in at a venue.</p>
          )}
        </li>
        <li className="py-3">
          <p className={loc.retry ? "font-medium" : undefined}>{loc.text}</p>
          {loc.retry ? (
            <Button variant="secondary" className="mt-3 max-sm:w-full" onClick={retryLocation}>
              Try location again
            </Button>
          ) : null}
        </li>
      </ul>

      {error ? (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      ) : null}
    </Card>
  );
}
