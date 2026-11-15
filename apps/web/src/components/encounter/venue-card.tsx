"use client";

import { CHECK_IN_HOURS, type EncounterStatus } from "@cue/contracts";
import { useState, type FormEvent } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, TextField } from "@/components/ui";
import { api, describeError, isApiError } from "@/lib/api";
import {
  normalizeVenueCode,
  VENUE_CODE_LENGTH,
  VENUE_NAME_MAX,
  venueCodeProblem,
  venueNameProblem,
} from "@/lib/encounter";
import { VenueQr } from "./venue-qr";

/**
 * Venue check-in without a QR scan (type the code), and hosting a place (name
 * it, get a QR code to show or print). Hosting checks the host in.
 */
export function VenueCard({
  encounter,
  showQr,
  onShowQr,
  onHideQr,
}: {
  encounter: EncounterStatus;
  showQr: boolean;
  onShowQr: () => void;
  onHideQr: () => void;
}) {
  const { applyEncounter } = useLive();
  const [busy, setBusy] = useState<"check-in" | "host" | null>(null);

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checkedInNote, setCheckedInNote] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  async function onCheckIn(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = venueCodeProblem(code);
    if (problem) return setCodeError(problem);
    setBusy("check-in");
    setCodeError(null);
    setCheckedInNote(null);
    try {
      const status = await api.checkIn({ code });
      applyEncounter(status);
      setCode("");
      onHideQr();
      setCheckedInNote(
        status.checkIn ? `You're checked in at ${status.checkIn.name}.` : "You're checked in.",
      );
    } catch (err) {
      if (isApiError(err, "not_found")) {
        setCodeError(`No place has the code ${code}. Check it and try again.`);
      } else if (isApiError(err, "invalid_request")) {
        setCodeError("That isn't a venue code. Codes are 6 letters and numbers.");
      } else setCodeError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function onHost(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = venueNameProblem(name);
    if (problem) return setNameError(problem);
    setBusy("host");
    setNameError(null);
    setCheckedInNote(null);
    try {
      applyEncounter(await api.createVenue({ name: name.trim() }));
      setName("");
      onShowQr();
    } catch (err) {
      setNameError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card aria-labelledby="venues-title" className="space-y-6">
      <h2 id="venues-title" className="sr-only">
        Venues
      </h2>

      {showQr && encounter.checkIn ? <VenueQr checkIn={encounter.checkIn} onHide={onHideQr} /> : null}

      <section aria-labelledby="check-in-title">
        <h3 id="check-in-title" className="font-display text-2xl leading-tight tracking-tight">
          Enter a venue code
        </h3>
        <p className="mt-1 text-ink-soft">
          Scanning a venue&apos;s QR code checks you in. No camera handy? Type its code. Everyone
          checked in at the same place can match, wherever they stand in it.
        </p>
        <form onSubmit={onCheckIn} noValidate className="mt-4 space-y-4">
          <TextField
            label="Venue code"
            hint="6 letters and numbers, shown under the place's QR code."
            error={codeError}
            value={code}
            onChange={(e) => {
              setCode(normalizeVenueCode(e.target.value));
              if (codeError) setCodeError(null);
            }}
            maxLength={VENUE_CODE_LENGTH + 4}
            className="text-center font-mono text-3xl uppercase tracking-[0.2em] placeholder:tracking-normal"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <Button
            type="submit"
            variant="secondary"
            full
            busy={busy === "check-in"}
            disabled={busy === "host"}
          >
            Check in
          </Button>
          <p role="status" className="text-sm font-medium empty:hidden">
            {checkedInNote}
          </p>
        </form>
      </section>

      <section aria-labelledby="host-title" className="border-t border-line pt-6">
        <h3 id="host-title" className="font-display text-2xl leading-tight tracking-tight">
          Host a place
        </h3>
        <p className="mt-1 text-ink-soft">
          Name it and Cue makes a QR code for it. Show it on your screen or print it. You&apos;re
          checked in straight away. A check-in lasts {CHECK_IN_HOURS} hours.
        </p>
        <form onSubmit={onHost} noValidate className="mt-4 space-y-4">
          <TextField
            label="Name of the place"
            hint="Shown to people who check in, and on matches made there."
            error={nameError}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            maxLength={VENUE_NAME_MAX}
            placeholder="Hackathon main hall"
            autoComplete="off"
            enterKeyHint="go"
          />
          <Button type="submit" full busy={busy === "host"} disabled={busy === "check-in"}>
            Host this place
          </Button>
        </form>
      </section>
    </Card>
  );
}
