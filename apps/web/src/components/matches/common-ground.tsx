"use client";

import { useEffect, useRef, useState } from "react";
import type { SharedInterest, WingmanSuggestion } from "@cue/contracts";
import { api, describeError, isApiError } from "@/lib/api";
import { Button, Card, Mark, SectionTitle, Spinner } from "@/components/ui";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: WingmanSuggestion }
  | { status: "error"; message: string; retry: boolean };

function errorState(err: unknown): { message: string; retry: boolean } {
  if (isApiError(err)) {
    switch (err.code) {
      case "timeout":
      case "upstream_timeout":
        return { message: "That took too long. Your match is unaffected. Try again.", retry: true };
      case "upstream_error":
      case "internal":
      case "bad_response":
        return {
          message: "The suggestion service didn't answer properly. Your match is unaffected.",
          retry: true,
        };
      case "rate_limited":
        return {
          message: "That's a few tries in a row. Wait a moment, then try again.",
          retry: true,
        };
      case "forbidden":
        return { message: "Common ground isn't available for this match.", retry: false };
    }
  }
  return { message: describeError(err), retry: true };
}

export function CommonGround({
  matchId,
  name,
  onGone,
}: {
  matchId: string;
  name: string;
  onGone: () => void;
}) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [slow, setSlow] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const slowTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      ctrlRef.current?.abort();
      if (slowTimer.current !== null) window.clearTimeout(slowTimer.current);
    },
    [],
  );

  async function request() {
    ctrlRef.current?.abort();
    if (slowTimer.current !== null) window.clearTimeout(slowTimer.current);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setSlow(false);
    setState({ status: "loading" });
    slowTimer.current = window.setTimeout(() => setSlow(true), 8000);
    try {
      const data = await api.getSuggestions(matchId, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setState({ status: "done", data });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (isApiError(err, "not_found")) {
        onGone();
        return;
      }
      setState({ status: "error", ...errorState(err) });
    } finally {
      if (ctrlRef.current === ctrl && slowTimer.current !== null) {
        window.clearTimeout(slowTimer.current);
        slowTimer.current = null;
        setSlow(false);
      }
    }
  }

  const loading = state.status === "loading";

  return (
    <Card aria-labelledby="common-ground-title" className="space-y-4">
      <SectionTitle id="common-ground-title">Find common ground</SectionTitle>

      {state.status === "idle" || state.status === "error" ? (
        <p className="text-ink-soft">
          Looks at what you&apos;ve each chosen to share and suggests one way to start talking.
          Optional, and only you see it.
        </p>
      ) : null}

      {state.status === "error" ? (
        <p role="alert" className="font-medium text-ember-deep">
          {state.message}
        </p>
      ) : null}

      {loading ? (
        <div role="status" className="flex min-h-28 items-center gap-4 rounded-2xl bg-sunk px-5 py-4">
          <Mark size={26} className="shrink-0 animate-breathe text-ink-soft" />
          <div>
            <p>Reading what you&apos;ve both shared…</p>
            {slow ? <p className="text-sm text-ink-soft">Still thinking. This can take a little while.</p> : null}
          </div>
        </div>
      ) : null}

      {state.status === "done" ? <Result data={state.data} name={name} /> : null}

      {state.status === "idle" ? (
        <Button variant="secondary" full className="sm:w-auto" onClick={() => void request()}>
          Find common ground
        </Button>
      ) : null}

      {state.status === "error" && state.retry ? (
        <Button variant="secondary" full className="sm:w-auto" onClick={() => void request()}>
          Try again
        </Button>
      ) : null}

      {loading ? (
        <Button variant="secondary" full className="sm:w-auto" disabled>
          <Spinner size={18} />
          Find common ground
        </Button>
      ) : null}

      {state.status === "done" ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-3">
          <p className="text-sm text-ink-soft">
            Suggested by Claude, an AI model, from the fields you both allowed. It can be wrong.
          </p>
          <Button variant="quiet" onClick={() => void request()}>
            Ask again
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Result({ data, name }: { data: WingmanSuggestion; name: string }) {
  const hasOverlap = !data.noOverlap && data.sharedInterests.length > 0;
  const basedOnEncounter = data.openerBasis === "encounter_context";

  return (
    <div className="animate-rise space-y-5">
      {hasOverlap ? (
        <ul className="space-y-4">
          {data.sharedInterests.map((s) => (
            <SharedItem key={s.label} item={s} name={name} />
          ))}
        </ul>
      ) : (
        <div>
          <p className="font-display text-xl">No clear overlap in what you&apos;ve each shared.</p>
          <p className="text-ink-soft">That&apos;s fine. Plenty of good conversations start without one.</p>
        </div>
      )}

      {data.suggestedQuestion ? (
        <Opener
          question={data.suggestedQuestion}
          label={basedOnEncounter ? "A way to start, based on where you met" : "A way to start"}
          name={name}
        />
      ) : hasOverlap ? null : (
        <p className="text-ink-soft">No suggestion this time. Starting with hello works.</p>
      )}
    </div>
  );
}

function fieldPhrase(field: "interests" | "bio", who: "your" | "their", name: string) {
  const owner = who === "your" ? "your" : `${name}'s`;
  return `in ${owner} ${field}`;
}

function SharedItem({ item, name }: { item: SharedInterest; name: string }) {
  return (
    <li className="rounded-2xl border border-line p-4">
      <p className="font-display text-xl leading-tight">{item.label}</p>
      <p className="mt-1">{item.summary}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Evidence
          heading="From your profile"
          quote={item.yourEvidence.quote}
          where={fieldPhrase(item.yourEvidence.field, "your", name)}
        />
        <Evidence
          heading={`From ${name}'s profile`}
          quote={item.theirEvidence.quote}
          where={fieldPhrase(item.theirEvidence.field, "their", name)}
        />
      </div>
    </li>
  );
}

function Evidence({ heading, quote, where }: { heading: string; quote: string; where: string }) {
  return (
    <figure className="rounded-xl bg-sunk px-4 py-3">
      <figcaption className="text-sm font-semibold text-ink-soft">{heading}</figcaption>
      <blockquote className="mt-1 break-words">&ldquo;{quote}&rdquo;</blockquote>
      <p className="mt-1 text-sm text-ink-soft">{where}</p>
    </figure>
  );
}

function Opener({ question, label, name }: { question: string; label: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(question);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="rounded-card border border-ember/30 bg-ember-soft px-5 py-5">
      <p className="text-sm font-medium uppercase tracking-[0.12em] text-ink-soft">{label}</p>
      <p className="mt-2 font-display text-2xl italic leading-snug sm:text-3xl">{question}</p>
      <p className="mt-3 text-sm text-ink-soft">
        A suggestion for you only. Nothing is sent to {name}. Use it, change it, or ignore it.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <Button variant="quiet" onClick={() => void copy()}>
          Copy
        </Button>
        <span role="status" className="text-sm text-ink-soft">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </div>
  );
}
