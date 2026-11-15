"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { MatchCard } from "@cue/contracts";
import { api, describeError, isApiError } from "@/lib/api";
import { useLive } from "@/components/live-provider";
import { Button, buttonClass, ConfirmDialog, Empty, Loading, Notice } from "@/components/ui";

export function BackLink({ href = "/matches", children = "Matches" }: { href?: string; children?: string }) {
  return (
    <Link
      href={href}
      className="-ml-2 mb-4 inline-flex min-h-12 items-center rounded-full px-2 text-ink-soft hover:text-ink hover:underline"
    >
      <span aria-hidden>←&nbsp;</span>
      {children}
    </Link>
  );
}

export function Gone() {
  return (
    <>
      <BackLink />
      <Empty
        title="This match is no longer available"
        action={
          <Link href="/matches" className={buttonClass("secondary")}>
            Back to Matches
          </Link>
        }
      >
        One of you unmatched, or the demo was reset. Nothing is wrong with your account.
      </Empty>
    </>
  );
}

type Fetched =
  | { state: "loading" }
  | { state: "ok"; card: MatchCard }
  | { state: "gone" }
  | { state: "error"; message: string };

/**
 * One match, from the live list when it is there (so it stays current), else
 * fetched. Reports "gone" when the server says so or when it drops out of the
 * live list after having been in it.
 */
export function useMatch(id: string) {
  const { matches } = useLive();
  const [fetched, setFetched] = useState<Fetched>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [wasListed, setWasListed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const listed = matches?.find((m) => m.id === id) ?? null;
  if (listed && !wasListed) setWasListed(true);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .getMatch(id, { signal: ctrl.signal })
      .then((card) => setFetched({ state: "ok", card }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (isApiError(err, "not_found") || isApiError(err, "forbidden")) setFetched({ state: "gone" });
        else setFetched({ state: "error", message: describeError(err) });
      });
    return () => ctrl.abort();
  }, [id, attempt]);

  // Stable identities: the conversation's fetch and subscription depend on these.
  const retry = useCallback(() => {
    setFetched({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  const markGone = useCallback(() => setFetched({ state: "gone" }), []);

  const card = listed ?? (fetched.state === "ok" ? fetched.card : null);
  const gone = fetched.state === "gone" || (wasListed && matches !== null && listed === null);

  return {
    card,
    gone,
    leaving,
    error: fetched.state === "error" ? fetched.message : null,
    retry,
    markGone,
    setLeaving,
  };
}

/** Loading, gone and error states shared by the match page and its conversation. */
export function MatchFallback({ m, back }: { m: ReturnType<typeof useMatch>; back?: { href: string; label: string } }) {
  if (m.leaving) return <Loading label="Leaving this match…" />;
  if (m.gone) return <Gone />;
  if (m.error) {
    return (
      <>
        <BackLink href={back?.href}>{back?.label}</BackLink>
        <Notice
          tone="error"
          title="Couldn't open this match"
          action={
            <Button variant="secondary" onClick={m.retry}>
              Try again
            </Button>
          }
        >
          {m.error}
        </Notice>
      </>
    );
  }
  return (
    <>
      <BackLink href={back?.href}>{back?.label}</BackLink>
      <Loading label="Opening your match…" />
    </>
  );
}

/** Unmatch and Block, each behind a confirmation. */
export function StepAway({
  match,
  onGone,
  onLeaving,
  onLeaveFailed,
  compact = false,
}: {
  match: MatchCard;
  onGone: () => void;
  onLeaving: () => void;
  onLeaveFailed: () => void;
  compact?: boolean;
}) {
  const { refreshMatches, forgetMatch } = useLive();
  const router = useRouter();
  const name = match.other.displayName;
  const [dialog, setDialog] = useState<"unmatch" | "block" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
  };

  async function confirm(kind: "unmatch" | "block") {
    setBusy(true);
    setError(null);
    try {
      if (kind === "unmatch") await api.unmatch(match.id);
      else await api.block({ userId: match.other.userId });
    } catch (err) {
      setBusy(false);
      // Already gone on the server: the outcome the person wanted.
      if (isApiError(err, "not_found")) {
        forgetMatch(match.id);
        onGone();
        return;
      }
      setError(describeError(err));
      return;
    }
    onLeaving();
    forgetMatch(match.id);
    void refreshMatches();
    router.replace("/matches");
    // If navigation is somehow slow, never leave the view stuck.
    window.setTimeout(onLeaveFailed, 8000);
  }

  const buttons = (
    <div className={compact ? "flex flex-wrap gap-x-2" : "mt-3 flex flex-wrap gap-x-4 gap-y-1"}>
      <Button variant="quiet" className={compact ? "min-h-11 px-3 text-sm" : undefined} onClick={() => setDialog("unmatch")}>
        Unmatch
      </Button>
      <Button variant="quiet" className={compact ? "min-h-11 px-3 text-sm" : undefined} onClick={() => setDialog("block")}>
        Block {name}
      </Button>
    </div>
  );

  return (
    <>
      {compact ? (
        buttons
      ) : (
        <section aria-labelledby="step-away" className="border-t border-line pt-6">
          <h2 id="step-away" className="font-display text-xl text-ink-soft">
            Step away
          </h2>
          {buttons}
        </section>
      )}

      {dialog === "unmatch" ? (
        <ConfirmDialog
          title={`Unmatch ${name}?`}
          confirmLabel="Unmatch"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void confirm("unmatch")}
          onCancel={close}
        >
          <p>
            You&apos;ll both lose each other&apos;s card and your conversation straight away. Anything already seen
            can&apos;t be unseen. {name} isn&apos;t notified.
          </p>
        </ConfirmDialog>
      ) : null}
      {dialog === "block" ? (
        <ConfirmDialog
          title={`Block ${name}?`}
          confirmLabel="Block"
          danger
          busy={busy}
          error={error}
          onConfirm={() => void confirm("block")}
          onCancel={close}
        >
          <p>
            This ends the match and your conversation now, and stops any future match with {name}, even in a new
            session. {name} isn&apos;t told they were blocked.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
