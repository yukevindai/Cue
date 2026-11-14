"use client";

import { useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, ConfirmDialog } from "@/components/ui";
import { api, describeError } from "@/lib/api";

type Action = "reset" | "end";

/** Organiser tools, deliberately quiet: reset for another run, or end the session. */
export function DemoControls({ onEnded }: { onEnded: (text: string) => void }) {
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
      if (action === "end") onEnded("Session ended. Start a new one, or join with a code.");
      else setDone("Demo reset. Ready for another run.");
      applyEncounter(status);
      void refreshMatches();
    } catch (err) {
      setError(
        `${action === "end" ? "The session is still running." : "Nothing was reset."} ${describeError(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-card border border-line px-5 py-4 text-ink-soft open:pb-5">
      <summary className="cursor-pointer rounded-md py-1 font-medium">Demo controls</summary>
      <div className="mt-3 space-y-4">
        <p className="text-sm">For whoever is running the demo. Both actions affect both people.</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="secondary" onClick={() => open("reset")}>
            Reset demo
          </Button>
          <Button variant="danger" onClick={() => open("end")}>
            End session
          </Button>
        </div>
        <p role="status" className="text-sm font-medium text-ink empty:hidden">
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
          <p>
            Clears pending signals and removes this session&apos;s matches for both of you, so you
            can run the demo again. You both stay in the session.
          </p>
        </ConfirmDialog>
      ) : null}
      {confirm === "end" ? (
        <ConfirmDialog
          title="End this session?"
          confirmLabel="End session"
          danger
          busy={busy}
          error={error}
          onConfirm={() => run("end")}
          onCancel={() => setConfirm(null)}
        >
          <p>
            Ends this session for both people and clears its signals and matches. You&apos;ll need
            a new code to start again.
          </p>
        </ConfirmDialog>
      ) : null}
    </details>
  );
}
