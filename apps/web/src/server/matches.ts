import "server-only";

import type { MatchCard, SharedProfile } from "@cue/contracts";
import { iso, rpc, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { getProfileRows, sharingOf, toSharedProfile, type ProfileRow } from "@/server/profiles";
import { getAdminSupabase } from "@/server/supabase-admin";

interface MatchRow {
  id: string;
  user_a: string;
  user_b: string;
  first_signal_at: string;
  venue_label: string;
  venue_label_source: "manual";
  status: "active" | "ended";
  created_at: string;
}

const MATCH_COLUMNS =
  "id, user_a, user_b, first_signal_at, venue_label, venue_label_source, status, created_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function otherOf(row: MatchRow, userId: string): string {
  return row.user_a === userId ? row.user_b : row.user_a;
}

/**
 * The ACTIVE match with this id, only if `userId` is a participant. Anything
 * else (ended, someone else's, malformed id, missing) is the same not_found,
 * so a non-participant learns nothing.
 */
async function requireActiveMatch(matchId: string, userId: string): Promise<MatchRow> {
  if (!UUID_RE.test(matchId)) throw new HttpError("not_found", "Match not found");
  const row = unwrap(
    await getAdminSupabase()
      .from("matches")
      .select(MATCH_COLUMNS)
      .eq("id", matchId)
      .eq("status", "active")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .maybeSingle(),
  ) as MatchRow | null;
  if (!row) throw new HttpError("not_found", "Match not found");
  return row;
}

function toCard(row: MatchRow, other: ProfileRow): MatchCard {
  return {
    id: row.id,
    other: toSharedProfile(other),
    encounterAt: iso(row.first_signal_at),
    venueLabel: row.venue_label,
    venueLabelSource: row.venue_label_source,
    createdAt: iso(row.created_at),
  };
}

/** Active matches of the caller, newest first, each with the other person's approved fields. */
export async function listMatches(userId: string): Promise<MatchCard[]> {
  const rows = unwrap(
    await getAdminSupabase()
      .from("matches")
      .select(MATCH_COLUMNS)
      .eq("status", "active")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order("created_at", { ascending: false }),
  ) as MatchRow[];
  const profiles = await getProfileRows(rows.map((r) => otherOf(r, userId)));
  const cards: MatchCard[] = [];
  for (const row of rows) {
    const other = profiles.get(otherOf(row, userId));
    if (other) cards.push(toCard(row, other));
  }
  return cards;
}

export async function getMatchCard(matchId: string, userId: string): Promise<MatchCard> {
  const row = await requireActiveMatch(matchId, userId);
  const otherId = otherOf(row, userId);
  const other = (await getProfileRows([otherId])).get(otherId);
  if (!other) throw new HttpError("not_found", "Match not found");
  return toCard(row, other);
}

/** Ends the match for both people and deletes cached suggestions (DB trigger). */
export async function unmatch(matchId: string, userId: string): Promise<void> {
  if (!UUID_RE.test(matchId)) throw new HttpError("not_found", "Match not found");
  const ended = await rpc<boolean>("end_match", {
    p_match_id: matchId,
    p_user_id: userId,
    p_reason: "unmatch",
  });
  if (!ended) throw new HttpError("not_found", "Match not found");
}

// ---------------------------------------------------------------------------
// Interface for the AI role (server/ai/**).
// ---------------------------------------------------------------------------

export interface WingmanParty {
  userId: string;
  /** The party's shared view: only fields their owner approved for a match. */
  profile: SharedProfile;
  /** Owner allows the shared fields to be sent to Claude. */
  aiAssist: boolean;
  version: number;
}

export interface WingmanMatchContext {
  matchId: string;
  venueLabel: string;
  requester: WingmanParty;
  other: WingmanParty;
  /**
   * Changes whenever either profile's content or sharing changes
   * (`profiles.version` is bumped by a DB trigger on both). Scoped to the
   * match and the requester, so it can be compared with
   * `wingman_suggestions.cache_key` for the row (match_id, requester_id).
   */
  cacheKey: string;
}

function toParty(row: ProfileRow): WingmanParty {
  return {
    userId: row.user_id,
    profile: toSharedProfile(row),
    aiAssist: sharingOf(row).aiAssist,
    version: row.version,
  };
}

/** Throws HttpError("not_found") unless userId is a participant of this ACTIVE match. */
export async function getWingmanMatchContext(
  matchId: string,
  userId: string,
): Promise<WingmanMatchContext> {
  const row = await requireActiveMatch(matchId, userId);
  const otherId = otherOf(row, userId);
  const profiles = await getProfileRows([userId, otherId]);
  const mine = profiles.get(userId);
  const theirs = profiles.get(otherId);
  if (!mine || !theirs) throw new HttpError("not_found", "Match not found");
  const requester = toParty(mine);
  const other = toParty(theirs);
  return {
    matchId: row.id,
    venueLabel: row.venue_label,
    requester,
    other,
    cacheKey: `v1:${row.id}:${requester.userId}:${requester.version}:${other.userId}:${other.version}`,
  };
}
