"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Loading, Notice, PageHeader } from "@/components/ui";
import { describeError } from "@/lib/api";
import { DemoControls } from "./demo-controls";
import { GlassesCard } from "./glasses-card";
import { HeadsetRemoteCard } from "./headset-remote-card";
import { ModeCard } from "./mode-card";
import { PlaceCard } from "./place-card";
import { SignalPanel } from "./signal-panel";
import { VenueArrival } from "./venue-arrival";
import { VenueCard } from "./venue-card";
import { WingmanVoiceCard } from "./wingman-voice-card";

/**
 * Encounter status. Rendered purely from the provider's `encounter`, which
 * only ever carries the caller's OWN pending signal, mode, device and place.
 * Nothing on this page may depend on anyone else's signal.
 *
 * `arrivalCode`: set when the person came from a venue's QR link.
 */
export function EncounterView({ arrivalCode = null }: { arrivalCode?: string | null }) {
  const { encounter, encounterError, refreshEncounter } = useLive();
  const [retrying, setRetrying] = useState(false);
  /** Bumped on a demo reset so the signal panel starts from a clean slate. */
  const [runKey, setRunKey] = useState(0);
  const [showQr, setShowQr] = useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await refreshEncounter();
    } finally {
      setRetrying(false);
    }
  }

  if (!encounter) {
    return (
      <>
        <PageHeader title="Encounter" />
        {encounterError ? (
          <Notice
            tone="error"
            title="Couldn't load Encounter"
            action={
              <Button variant="secondary" onClick={retry} busy={retrying}>
                Try again
              </Button>
            }
          >
            {describeError(encounterError)}
          </Notice>
        ) : (
          <Loading label="Checking where things stand…" />
        )}
      </>
    );
  }

  const staleNotice = encounterError ? (
    <Notice
      tone="warn"
      className="mb-6"
      action={
        <Button variant="quiet" onClick={retry} busy={retrying}>
          Try again
        </Button>
      }
    >
      Couldn&apos;t refresh just now, so this may be slightly out of date.{" "}
      {describeError(encounterError)}
    </Notice>
  ) : null;

  return (
    <>
      <PageHeader title="Encounter" />
      {arrivalCode !== null ? <VenueArrival code={arrivalCode} /> : null}
      {staleNotice}
      <div className="space-y-6">
        <ModeCard enabled={encounter.encounterMode} />
        <PlaceCard encounter={encounter} onShowQr={() => setShowQr(true)} />
        <SignalPanel key={runKey} encounter={encounter} />
        <WingmanVoiceCard />
        <VenueCard
          encounter={encounter}
          showQr={showQr}
          onShowQr={() => setShowQr(true)}
          onHideQr={() => setShowQr(false)}
        />
        <GlassesCard device={encounter.device} />
        <HeadsetRemoteCard />
        <DemoControls onReset={() => setRunKey((k) => k + 1)} />
      </div>
    </>
  );
}
