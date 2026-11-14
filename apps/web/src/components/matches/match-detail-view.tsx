"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { MatchCard } from "@cue/contracts";
import { api, describeError, isApiError } from "@/lib/api";
import { formatEncounterTime } from "@/lib/format";
import { useLive } from "@/components/live-provider";
import {
  Avatar,
  Button,
  buttonClass,
  Card,
  Chip,
  ConfirmDialog,
  Empty,
  Loading,
  Notice,
  SectionTitle,
} from "@/components/ui";
import { CommonGround } from "./common-ground";

type Fetched =
  | { state: "loading" }
  | { state: "ok"; card: MatchCard }
  | { state: "gone" }
  | { state: "error"; message: string };

function BackLink() {
  return (
    <Link
      href="/matches"
      className="-ml-2 mb-4 inline-flex min-h-12 items-center rounded-full px-2 text-ink-soft hover:text-ink hover:underline"
    >
      <span aria-hidden>←&nbsp;</span>Matches
    </Link>
  );
}

function Gone() {
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

export function MatchDetailView({ id }: { id: string }) {
  const { matches, forgetMatch } = useLive();
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
        if (isApiError(err, "not_found") || isApiError(err, "forbidden")) {
          setFetched({ state: "gone" });
        } else {
          setFetched({ state: "error", message: describeError(err) });
        }
      });
    return () => ctrl.abort();
  }, [id, attempt]);

  const card = listed ?? (fetched.state === "ok" ? fetched.card : null);
  const goneNow =
    fetched.state === "gone" || (wasListed && matches !== null && listed === null);

  if (leaving) return <Loading label="Leaving this match…" />;
  if (goneNow) return <Gone />;

  if (!card) {
    if (fetched.state === "error") {
      return (
        <>
          <BackLink />
          <Notice
            tone="error"
            title="Couldn't open this match"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFetched({ state: "loading" });
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            {fetched.message}
          </Notice>
        </>
      );
    }
    return (
      <>
        <BackLink />
        <Loading label="Opening your match…" />
      </>
    );
  }

  return (
    <Detail
      key={card.id}
      match={card}
      onGone={() => setFetched({ state: "gone" })}
      onLeaving={() => setLeaving(true)}
      onLeaveFailed={() => setLeaving(false)}
      forget={forgetMatch}
    />
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Detail({
  match,
  onGone,
  onLeaving,
  onLeaveFailed,
  forget,
}: {
  match: MatchCard;
  onGone: () => void;
  onLeaving: () => void;
  onLeaveFailed: () => void;
  forget: (id: string) => void;
}) {
  const { refreshMatches } = useLive();
  const router = useRouter();
  const { other } = match;
  const name = other.displayName;

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
      else await api.block({ userId: other.userId });
    } catch (err) {
      setBusy(false);
      // Already gone on the server: the outcome the person wanted.
      if (isApiError(err, "not_found")) {
        forget(match.id);
        onGone();
        return;
      }
      setError(describeError(err));
      return;
    }
    onLeaving();
    forget(match.id);
    void refreshMatches();
    router.replace("/matches");
    // If navigation is somehow slow, never leave the view stuck.
    window.setTimeout(onLeaveFailed, 8000);
  }

  const missing: string[] = [];
  if (!other.photoUrl) missing.push("a photo");
  if (!other.bio) missing.push("a bio");
  if (other.interests.length === 0) missing.push("interests");
  if (other.socialLinks.length === 0) missing.push("social links");

  return (
    <div className="animate-rise space-y-8">
      <div>
        <BackLink />

        <section aria-label="Who you matched with" className="sm:flex sm:items-start sm:gap-8">
          <Avatar name={name} src={other.photoUrl} size={112} className="mb-4 sm:mb-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-4xl leading-[1.1] tracking-tight break-words sm:text-5xl">
              {name}
            </h1>
            <div className="mt-4 rounded-card border border-line bg-sunk px-5 py-4">
              <p className="font-display text-2xl italic leading-snug">
                You met {formatEncounterTime(match.encounterAt)}
              </p>
              <p className="font-display text-2xl leading-snug">at {match.venueLabel}</p>
              <p className="mt-2 text-sm text-ink-soft">
                Venue typed in by the session organiser. Not a GPS location.
              </p>
            </div>
          </div>
        </section>
      </div>

      {other.bio || other.interests.length > 0 || other.socialLinks.length > 0 ? (
        <Card className="space-y-6">
          {other.bio ? (
            <div>
              <SectionTitle>About {name}</SectionTitle>
              <p className="mt-2 whitespace-pre-line text-lg">{other.bio}</p>
            </div>
          ) : null}

          {other.interests.length > 0 ? (
            <div>
              <h2 className="font-display text-2xl leading-tight tracking-tight">Interests</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {other.interests.map((i) => (
                  <li key={i}>
                    <Chip>{i}</Chip>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {other.socialLinks.length > 0 ? (
            <div>
              <h2 className="font-display text-2xl leading-tight tracking-tight">Elsewhere</h2>
              <ul className="mt-2 divide-y divide-line">
                {other.socialLinks.map((l) => (
                  <li key={l.url}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-h-12 items-center justify-between gap-3 py-2 hover:text-ember-deep"
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold">{l.label}</span>
                        <span className="block truncate text-sm text-ink-soft">{hostname(l.url)}</span>
                      </span>
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden
                        className="shrink-0 text-ink-soft"
                      >
                        <path
                          d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="sr-only">opens in a new tab</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {missing.length > 0 ? (
        <p className="text-ink-soft">
          {name} hasn&apos;t shared {joinList(missing)}.
        </p>
      ) : null}

      <CommonGround matchId={match.id} name={name} onGone={onGone} />

      <section aria-labelledby="step-away" className="border-t border-line pt-6">
        <h2 id="step-away" className="font-display text-xl text-ink-soft">
          Step away
        </h2>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <Button variant="quiet" onClick={() => setDialog("unmatch")}>
            Unmatch
          </Button>
          <Button variant="quiet" onClick={() => setDialog("block")}>
            Block {name}
          </Button>
        </div>
      </section>

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
            You&apos;ll both lose each other&apos;s card straight away. Anything already seen
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
            This ends the match now and stops any future match with {name}, even in a new session.{" "}
            {name} isn&apos;t told they were blocked.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
