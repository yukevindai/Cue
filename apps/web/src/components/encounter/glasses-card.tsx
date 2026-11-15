"use client";

import type { DeviceStatus, PairingCode } from "@cue/contracts";
import { useEffect, useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, ConfirmDialog, Notice, StatusPill } from "@/components/ui";
import { api, describeError } from "@/lib/api";
import { formatCountdown, groupPairingCode, spellCode } from "@/lib/encounter";
import { formatAgo, secondsUntil } from "@/lib/format";
import { useServerNow } from "./use-server-now";

const LINK_POLL_MS = 3000;

/** Mentra Live link status and the pairing flow. Own device only. (Meta glasses: HeadsetRemoteCard.) */
export function GlassesCard({ device }: { device: DeviceStatus }) {
  const { clockOffsetMs, refreshEncounter } = useLive();

  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const showingCode = pairing !== null && !device.linked;
  const now = useServerNow(clockOffsetMs, showingCode ? 500 : 30_000);
  const codeSecondsLeft = pairing ? secondsUntil(pairing.expiresAt, now) : 0;
  const codeExpired = showingCode && codeSecondsLeft <= 0;
  const waitingForClaim = showingCode && !codeExpired;

  // Device linking is not pushed over realtime: poll while a code is on screen.
  useEffect(() => {
    if (!waitingForClaim) return;
    const id = window.setInterval(() => void refreshEncounter(), LINK_POLL_MS);
    return () => window.clearInterval(id);
  }, [waitingForClaim, refreshEncounter]);

  async function getCode() {
    if (pairBusy) return;
    setPairBusy(true);
    setPairError(null);
    try {
      setPairing(await api.createPairingCode());
    } catch (err) {
      setPairError(`Couldn't get a pairing code. ${describeError(err)}`);
    } finally {
      setPairBusy(false);
    }
  }

  async function unlink() {
    if (unlinkBusy) return;
    setUnlinkBusy(true);
    setUnlinkError(null);
    try {
      await api.unlinkDevice();
      setPairing(null);
      await refreshEncounter();
      setConfirmUnlink(false);
    } catch (err) {
      setUnlinkError(`The glasses are still linked. ${describeError(err)}`);
    } finally {
      setUnlinkBusy(false);
    }
  }

  return (
    <Card aria-labelledby="glasses-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="glasses-title" className="font-display text-2xl leading-tight tracking-tight">
          Mentra Live
        </h2>
        <p role="status">
          {device.linked ? (
            <StatusPill tone="on">Glasses linked</StatusPill>
          ) : (
            <StatusPill tone="off">Glasses not linked</StatusPill>
          )}
        </p>
      </div>

      {device.linked ? (
        <div className="mt-3">
          <p className="font-semibold break-words">{device.deviceLabel ?? "Mentra Live"}</p>
          <p className="text-sm text-ink-soft">
            {device.lastSeenAt
              ? `Last seen ${formatAgo(device.lastSeenAt, now)}`
              : "Hasn't checked in yet"}
          </p>
          <p className="mt-3 text-ink-soft">
            Swipe backward along the temple, toward your ear, to signal. Forward swipes and taps do
            nothing.
          </p>
          <Button
            variant="quiet"
            className="mt-2 -ml-5"
            onClick={() => {
              setUnlinkError(null);
              setConfirmUnlink(true);
            }}
          >
            Unlink
          </Button>
        </div>
      ) : showingCode && pairing ? (
        <div className="mt-4 animate-rise">
          {codeExpired ? (
            <>
              <p>That code has expired.</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <Button onClick={getCode} busy={pairBusy}>
                  Get a new code
                </Button>
                <Button variant="quiet" onClick={() => setPairing(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-2xl bg-sunk px-3 py-5 text-center">
                <p className="font-mono text-5xl font-semibold leading-none tracking-[0.12em] sm:text-6xl">
                  <span aria-hidden>{groupPairingCode(pairing.code)}</span>
                  <span className="sr-only">Pairing code: {spellCode(pairing.code)}</span>
                </p>
              </div>
              <p className="mt-3">Enter this code in the Cue app on your glasses.</p>
              <p className="text-sm text-ink-soft">
                Expires in{" "}
                <span className="font-mono tabular-nums" aria-hidden>
                  {formatCountdown(codeSecondsLeft)}
                </span>
                <span className="sr-only">
                  about {Math.max(1, Math.ceil(codeSecondsLeft / 60))} min
                </span>
                . This card updates by itself once the glasses are linked.
              </p>
              <Button variant="quiet" className="mt-2 -ml-5" onClick={() => setPairing(null)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-ink-soft">
            For Mentra Live: link them so a backward swipe on the temple sends your signal. Wearing
            Meta glasses? Use the Meta glasses card instead. Without glasses you can still use the
            Interested button on this page.
          </p>
          <Button variant="secondary" className="mt-4 max-sm:w-full" onClick={getCode} busy={pairBusy}>
            Link glasses
          </Button>
        </div>
      )}

      {pairError && !device.linked ? (
        <Notice tone="error" className="mt-4">
          {pairError}
        </Notice>
      ) : null}

      {confirmUnlink ? (
        <ConfirmDialog
          title="Unlink your Mentra Live?"
          confirmLabel="Unlink"
          danger
          busy={unlinkBusy}
          error={unlinkError}
          onConfirm={unlink}
          onCancel={() => setConfirmUnlink(false)}
        >
          <p>Swipes will stop sending signals until you link again.</p>
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}
