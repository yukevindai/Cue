"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Loading, Notice, PageHeader } from "@/components/ui";
import { describeError } from "@/lib/api";
import { DemoControls } from "./demo-controls";
import { GlassesCard } from "./glasses-card";
import { HeadsetRemoteCard } from "./headset-remote-card";
import { ModeCard } from "./mode-card";
import { SessionCard } from "./session-card";
import { SessionSetup } from "./session-setup";
import { SignalPanel } from "./signal-panel";

/**
 * Encounter status. Rendered purely from the provider's `encounter`, which
 * only ever carries the caller's OWN pending signal, mode, device and session
 * membership. Nothing on this page may depend on the other person's signal.
 */
export function EncounterView() {
  const { encounter, encounterError, refreshEncounter } = useLive();
  const [retrying, setRetrying] = useState(false);
  /** Why the person is back on the setup screen, when we know. */
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  /** Bumped on a demo reset so the signal panel starts from a clean slate. */
  const [runKey, setRunKey] = useState(0);

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
            title="Couldn't load your session"
            action={
              <Button variant="secondary" onClick={retry} busy={retrying}>
                Try again
              </Button>
            }
          >
            {describeError(encounterError)}
          </Notice>
        ) : (
          <Loading label="Checking your session…" />
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

  if (!encounter.session) {
    return (
      <>
        <PageHeader title="Encounter">
          Start a session for two, or join one with a code.
        </PageHeader>
        {staleNotice}
        <SessionSetup notice={setupNotice} onEntered={() => setSetupNotice(null)} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Encounter" />
      {staleNotice}
      <div className="space-y-6">
        <SessionCard session={encounter.session} />
        <ModeCard enabled={encounter.encounterMode} />
        <SignalPanel key={runKey} encounter={encounter} onLeftSession={setSetupNotice} />
        <GlassesCard device={encounter.device} />
        <HeadsetRemoteCard />
        <DemoControls onEnded={setSetupNotice} onReset={() => setRunKey((k) => k + 1)} />
      </div>
    </>
  );
}
