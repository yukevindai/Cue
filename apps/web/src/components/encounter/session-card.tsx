"use client";

import type { DemoSession } from "@cue/contracts";
import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/components/ui";
import { cx } from "@/lib/cx";
import { occupancyText, spellCode } from "@/lib/encounter";

/** Venue, the join code (large enough to read off a projector), and who is here. */
export function SessionCard({ session }: { session: DemoSession }) {
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let note: string;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(session.joinCode);
      note = "Copied";
    } catch {
      note = "Couldn't copy from here. Read the code out instead.";
    }
    setCopyNote(note);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopyNote(null), 3000);
  }

  const long = session.joinCode.length > 8;

  return (
    <Card aria-labelledby="session-title">
      <h2 id="session-title" className="text-sm font-medium uppercase tracking-[0.16em] text-ink-soft">
        Your session
      </h2>
      <p className="mt-1 font-display text-2xl leading-tight break-words">{session.venueLabel}</p>
      <p className="text-sm text-ink-soft">Venue entered by hand, not GPS</p>

      <div className="mt-5 rounded-2xl bg-sunk px-3 py-5 text-center">
        <p className="text-sm font-medium text-ink-soft">Join code</p>
        <p
          className={cx(
            "mt-1 font-mono font-semibold leading-none break-all",
            long
              ? "text-4xl tracking-[0.08em] sm:text-6xl"
              : "text-5xl tracking-[0.14em] sm:text-7xl",
          )}
        >
          <span aria-hidden>{session.joinCode}</span>
          <span className="sr-only">{spellCode(session.joinCode)}</span>
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>{occupancyText(session)}</p>
        <div className="flex items-center gap-3 max-sm:flex-col-reverse max-sm:items-stretch">
          <p role="status" className="text-sm text-ink-soft empty:hidden">
            {copyNote}
          </p>
          <Button variant="secondary" onClick={copy} className="shrink-0 max-sm:w-full">
            Copy code
          </Button>
        </div>
      </div>
    </Card>
  );
}
