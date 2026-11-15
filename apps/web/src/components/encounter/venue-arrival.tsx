"use client";

import { useEffect, useRef, useState } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Notice } from "@/components/ui";
import { api, describeError, isApiError } from "@/lib/api";
import { venueCodeProblem } from "@/lib/encounter";

type Arrival =
  | { state: "checking" }
  | { state: "done"; name: string }
  | { state: "unknown" }
  | { state: "error"; text: string };

/**
 * Someone opened a venue's QR link (`/v/<code>`, which sends them here as
 * `/encounter?venue=<code>`): check them in once and say so.
 */
export function VenueArrival({ code }: { code: string }) {
  const { applyEncounter, encounter } = useLive();
  const invalid = venueCodeProblem(code) !== null;
  const [arrival, setArrival] = useState<Arrival>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (invalid || started.current === attempt) return;
    started.current = attempt;
    api
      .checkIn({ code })
      .then((status) => {
        applyEncounter(status);
        setArrival({ state: "done", name: status.checkIn?.name ?? "this place" });
        // Drop the code from the address so a reload doesn't check in again.
        window.history.replaceState(null, "", "/encounter");
      })
      .catch((err: unknown) => {
        if (isApiError(err, "not_found") || isApiError(err, "invalid_request")) {
          setArrival({ state: "unknown" });
        } else {
          setArrival({ state: "error", text: describeError(err) });
        }
      });
  }, [code, invalid, attempt, applyEncounter]);

  if (invalid || arrival.state === "unknown") {
    return (
      <Notice tone="warn" title="That venue code isn't known" className="mb-6">
        No place on Cue has the code {code ? <span className="font-mono">{code}</span> : "in that link"}.
        Check the code on the sign and type it under &ldquo;Enter a venue code&rdquo; below.
      </Notice>
    );
  }
  if (arrival.state === "checking") {
    return (
      <Notice className="mb-6">
        Checking you in at <span className="font-mono">{code}</span>…
      </Notice>
    );
  }
  if (arrival.state === "error") {
    return (
      <Notice
        tone="error"
        title="Couldn't check you in"
        className="mb-6"
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setArrival({ state: "checking" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        }
      >
        {arrival.text}
      </Notice>
    );
  }
  return (
    <Notice tone="good" title={`You're checked in at ${arrival.name}`} className="mb-6">
      {encounter?.encounterMode
        ? "Your signals can now match with people checked in here."
        : "Turn on Encounter mode below to signal. Your signals can then match with people checked in here."}
    </Notice>
  );
}
