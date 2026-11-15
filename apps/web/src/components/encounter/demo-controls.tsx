"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, ConfirmDialog } from "@/components/ui";
import { api, describeError } from "@/lib/api";

type Action = "reset" | "end";

const RESET_TEXT =
  "Ends the matches you made in the last 12 hours and clears your pending signal.";
const END_TEXT = `${RESET_TEXT} It also checks you out and turns Encounter mode off.`;

/** Demo tools, deliberately quiet: reset for another run, or end and leave. */
export function DemoControls({ onReset }: { onReset: () => void }) {
  const { applyEncounter, refreshMatches } = useLive();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function open(action: Action) {
    setError(null);
    setDone(null);
    setConfirm(action);
  }

  async function run(action: Action) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await api.resetDemo({ leave: action === "end" });
      setConfirm(null);
      setDone(
        action === "end"
          ? "Demo ended. You're checked out and Encounter mode is off."
          : "Demo reset. Ready for another run.",
      );
      onReset();
      applyEncounter(status);
      void refreshMatches();
    } catch (err) {
      setError(
        `${action === "end" ? "Nothing was ended." : "Nothing was reset."} ${describeError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-card border border-line px-5 py-4 text-ink-soft open:pb-5">
      <summary className="cursor-pointer rounded-md py-1 font-medium">Demo controls</summary>
      <div className="mt-3 space-y-4">
        <p className="text-sm">
          Reset demo ends the matches you made in the last 12 hours and clears your pending signal.
          End demo does that, and also checks you out and turns Encounter mode off.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="secondary" onClick={() => open("reset")}>
            Reset demo
          </Button>
          <Button variant="danger" onClick={() => open("end")}>
            End demo
          </Button>
        </div>
        <p role="status" className="text-sm font-medium text-ink">
          {done}
        </p>
      </div>

      {confirm === "reset" ? (
        <ConfirmDialog
          title="Reset the demo?"
          confirmLabel="Reset demo"
          busy={busy}
          error={error}
          onConfirm={() => run("reset")}
          onCancel={() => setConfirm(null)}
        >
          <p>{RESET_TEXT}</p>
          <p>Those matches end for the other person too, with their conversations.</p>
        </ConfirmDialog>
      ) : null}
      {confirm === "end" ? (
        <ConfirmDialog
          title="End the demo?"
          confirmLabel="End demo"
          danger
          busy={busy}
          error={error}
          onConfirm={() => run("end")}
          onCancel={() => setConfirm(null)}
        >
          <p>{END_TEXT}</p>
          <p>Those matches end for the other person too, with their conversations.</p>
        </ConfirmDialog>
      ) : null}
    </details>
  );
}
