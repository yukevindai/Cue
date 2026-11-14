import { expect } from "@playwright/test";
import type { MatchCard } from "@cue/contracts";
import { must, type Api } from "./api";

/** Match ids visible to this person through GET /api/matches. */
export async function matchIds(api: Api): Promise<string[]> {
  return must(await api.listMatches(), "listMatches").matches.map((m) => m.id);
}

/** Exactly one match, visible to both people, with the same id. Returns A's and B's cards. */
export async function expectExactlyOneSharedMatch(a: Api, b: Api): Promise<{ forA: MatchCard; forB: MatchCard }> {
  const listA = must(await a.listMatches(), "A listMatches").matches;
  const listB = must(await b.listMatches(), "B listMatches").matches;
  expect(listA, "A sees exactly one match").toHaveLength(1);
  expect(listB, "B sees exactly one match").toHaveLength(1);
  expect(listA[0].id).toBe(listB[0].id);
  return { forA: listA[0], forB: listB[0] };
}

export async function expectNoMatches(...apis: Api[]): Promise<void> {
  for (const api of apis) {
    expect(await matchIds(api)).toEqual([]);
  }
}

/** None of the needles may appear anywhere in the raw response texts. */
export function expectNoLeak(texts: string[], needles: Record<string, string>): void {
  for (const [what, needle] of Object.entries(needles)) {
    for (const t of texts) {
      expect(t, `response must not reveal ${what}`).not.toContain(needle);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until just after an ISO timestamp (used to outlast the real 15 s matching window). */
export async function sleepPast(iso: string, marginMs = 750): Promise<void> {
  const ms = new Date(iso).getTime() - Date.now() + marginMs;
  if (ms > 0) await sleep(ms);
}
