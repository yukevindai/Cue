"use client";

import Link from "next/link";
import { useMemo } from "react";
import { describeError } from "@/lib/api";
import { useLive } from "@/components/live-provider";
import { Button, buttonClass, Empty, Loading, Notice, PageHeader } from "@/components/ui";
import { MatchCard } from "./match-card";

export function MatchesView() {
  const { matches, matchesError, refreshMatches } = useLive();

  const sorted = useMemo(
    () =>
      matches
        ? [...matches].sort((a, b) => activityAt(b) - activityAt(a))
        : null,
    [matches],
  );

  return (
    <>
      <PageHeader title="Matches">
        The people who noticed you back. Their cards stay here until one of you unmatches.
      </PageHeader>

      {sorted === null && !matchesError ? <Loading label="Looking for your matches…" /> : null}

      {sorted === null && matchesError ? (
        <Notice
          tone="error"
          title="Couldn't load your matches"
          action={
            <Button variant="secondary" onClick={() => void refreshMatches()}>
              Try again
            </Button>
          }
        >
          {describeError(matchesError)}
        </Notice>
      ) : null}

      {sorted !== null && matchesError ? (
        <Notice tone="warn" className="mb-6">
          Couldn&apos;t refresh just now, so this list may be a little out of date. {describeError(matchesError)}
        </Notice>
      ) : null}

      {sorted !== null && sorted.length === 0 ? (
        <Empty
          title="No matches yet"
          action={
            <Link href="/encounter" className={buttonClass("secondary")}>
              Go to Encounter
            </Link>
          }
        >
          When you notice someone and they notice you within the same few seconds, their card
          appears here. Nothing shows up for one-sided interest, in either direction.
        </Empty>
      ) : null}

      {sorted !== null && sorted.length > 0 ? (
        <ul className="space-y-6">
          {sorted.map((m) => (
            <MatchCard key={m.id} match={m} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Most recent of the match itself and its newest message, for ordering. */
function activityAt(m: { createdAt: string; lastMessageAt: string | null }): number {
  const made = new Date(m.createdAt).getTime();
  return m.lastMessageAt ? Math.max(made, new Date(m.lastMessageAt).getTime()) : made;
}
