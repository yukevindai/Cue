"use client";

import { useState, type FormEvent } from "react";
import { useLive } from "@/components/live-provider";
import { Button, Card, Notice, SectionTitle, TextField } from "@/components/ui";
import { api, describeError, isApiError } from "@/lib/api";
import {
  JOIN_CODE_MAX,
  VENUE_LABEL_MAX,
  joinCodeProblem,
  normalizeJoinCode,
  venueLabelProblem,
} from "@/lib/encounter";

type JoinError = { kind: "full" } | { kind: "text"; text: string };

/** No session yet: start one, or join with a code. */
export function SessionSetup({
  notice,
  onEntered,
}: {
  notice: string | null;
  onEntered: () => void;
}) {
  const { applyEncounter } = useLive();
  const [busy, setBusy] = useState<"create" | "join" | null>(null);

  const [venue, setVenue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState<JoinError | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = venueLabelProblem(venue);
    if (problem) return setCreateError(problem);
    setBusy("create");
    setCreateError(null);
    try {
      const status = await api.createSession({ venueLabel: venue.trim() });
      onEntered();
      applyEncounter(status);
    } catch (err) {
      setCreateError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = joinCodeProblem(code);
    if (problem) return setJoinError({ kind: "text", text: problem });
    setBusy("join");
    setJoinError(null);
    try {
      const status = await api.joinSession({ joinCode: code });
      onEntered();
      applyEncounter(status);
    } catch (err) {
      if (isApiError(err, "session_full")) setJoinError({ kind: "full" });
      else if (isApiError(err, "not_found")) {
        setJoinError({ kind: "text", text: "No session with that code. Check it and try again." });
      } else setJoinError({ kind: "text", text: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {notice ? <Notice>{notice}</Notice> : null}

      <p className="max-w-prose text-ink-soft">
        This demo pairs exactly two consenting people. A signal only ever goes to the one other
        person in your session.
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card aria-labelledby="start-session-title">
          <SectionTitle id="start-session-title">Start a session</SectionTitle>
          <form onSubmit={onCreate} noValidate className="mt-4 space-y-4">
            <TextField
              label="Where are you?"
              hint="Typed in by you, shown on a match as a manually entered venue. Cue doesn't use GPS here."
              error={createError}
              value={venue}
              onChange={(e) => {
                setVenue(e.target.value);
                if (createError) setCreateError(null);
              }}
              maxLength={VENUE_LABEL_MAX}
              placeholder="Hackathon main hall"
              autoComplete="off"
              enterKeyHint="go"
            />
            <Button type="submit" full busy={busy === "create"} disabled={busy === "join"}>
              Start a session
            </Button>
          </form>
        </Card>

        <Card aria-labelledby="join-session-title">
          <SectionTitle id="join-session-title">Join with a code</SectionTitle>
          <form onSubmit={onJoin} noValidate className="mt-4 space-y-4">
            <TextField
              label="Session code"
              hint="The code on the other person's Encounter screen."
              error={joinError?.kind === "text" ? joinError.text : null}
              value={code}
              onChange={(e) => {
                setCode(normalizeJoinCode(e.target.value).slice(0, JOIN_CODE_MAX));
                if (joinError?.kind === "text") setJoinError(null);
              }}
              className="text-center font-mono text-3xl uppercase tracking-[0.2em] placeholder:tracking-normal"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
            {joinError?.kind === "full" ? (
              <Notice tone="warn" title="That session is full" className="animate-rise">
                A Cue demo session holds exactly two people, and this one already has both. Cue
                never adds a third person or picks someone at random. Ask the organiser for a new
                code, or start your own session.
              </Notice>
            ) : null}
            <Button
              type="submit"
              variant="secondary"
              full
              busy={busy === "join"}
              disabled={busy === "create"}
            >
              Join session
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
