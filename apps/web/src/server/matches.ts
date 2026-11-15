import "server-only";

import type { MatchCard, SharedProfile } from "@cue/contracts";
import { iso, rpc, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { getProfileRows, sharingOf, toSharedProfile, type ProfileRow } from "@/server/profiles";
import { getAdminSupabase } from "@/server/supabase-admin";

export interface MatchRow {
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

/** Postgres timestamptz text exactly as PostgREST returns it (microsecond precision). */
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/;

/** Chat state of one match as seen by one participant. */
interface ChatSummary {
  unreadCount: number;
  lastMessageAt: string | null;
}

const NO_CHAT: ChatSummary = { unreadCount: 0, lastMessageAt: null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function otherOf(row: MatchRow, userId: string): string {
  return row.user_a === userId ? row.user_b : row.user_a;
}

/**
 * The ACTIVE match with this id, only if `userId` is a participant. Anything
 * else (ended, someone else's, malformed id, missing) is the same not_found,
 * so a non-participant learns nothing.
 */
export async function requireActiveMatch(matchId: string, userId: string): Promise<MatchRow> {
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

function toCard(row: MatchRow, other: ProfileRow, chat: ChatSummary): MatchCard {
  return {
    id: row.id,
    other: toSharedProfile(other),
    encounterAt: iso(row.first_signal_at),
    venueLabel: row.venue_label,
    venueLabelSource: row.venue_label_source,
    createdAt: iso(row.created_at),
    unreadCount: chat.unreadCount,
    lastMessageAt: chat.lastMessageAt,
  };
}

/**
 * Unread counts and newest-message times for the viewer's matches, in a fixed
 * number of queries whatever the number of matches:
 *   1. newest message per match (PostgREST embedded resource, limit 1 each),
 *   2. the viewer's read markers,
 *   3. the unread messages themselves (only `match_id`), selected with one
 *      OR filter that applies each match's own read cutoff.
 * Unread = sent by the OTHER person after the viewer's `last_read_at` (all of
 * the other person's messages when there is no read marker yet).
 * Callers must already have authorized `viewerId` for every match id.
 */
async function chatSummaries(matchIds: string[], viewerId: string): Promise<Map<string, ChatSummary>> {
  const out = new Map<string, ChatSummary>();
  if (matchIds.length === 0) return out;
  const db = getAdminSupabase();

  const [latestRows, readRows] = await Promise.all([
    db
      .from("matches")
      .select("id, latest:chat_messages(created_at)")
      .in("id", matchIds)
      .order("created_at", { referencedTable: "latest", ascending: false })
      .limit(1, { referencedTable: "latest" })
      .then(unwrap),
    db
      .from("chat_reads")
      .select("match_id, last_read_at")
      .eq("user_id", viewerId)
      .in("match_id", matchIds)
      .then(unwrap),
  ]);

  const lastRead = new Map<string, string>();
  for (const r of readRows as { match_id: string; last_read_at: string }[]) {
    if (UUID_RE.test(r.match_id) && PG_TIMESTAMP_RE.test(r.last_read_at)) lastRead.set(r.match_id, r.last_read_at);
  }

  const withMessages: string[] = [];
  for (const r of latestRows as { id: string; latest: { created_at: string }[] | null }[]) {
    const newest = r.latest?.[0]?.created_at ?? null;
    out.set(r.id, { unreadCount: 0, lastMessageAt: newest ? iso(newest) : null });
    if (newest && UUID_RE.test(r.id)) withMessages.push(r.id);
  }
  if (withMessages.length === 0) return out;

  // Every value interpolated below was validated above (uuid / timestamp shapes).
  const conditions = withMessages.map((id) => {
    const cutoff = lastRead.get(id);
    return cutoff ? `and(match_id.eq.${id},created_at.gt."${cutoff}")` : `match_id.eq.${id}`;
  });
  const unread = unwrap(
    await db
      .from("chat_messages")
      .select("match_id")
      .in("match_id", withMessages)
      .neq("sender_id", viewerId)
      .or(conditions.join(","))
      .limit(10_000),
  ) as { match_id: string }[];
  for (const { match_id } of unread) {
    const s = out.get(match_id);
    if (s) s.unreadCount += 1;
  }
  return out;
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
  const [profiles, chats] = await Promise.all([
    getProfileRows(rows.map((r) => otherOf(r, userId))),
    chatSummaries(
      rows.map((r) => r.id),
      userId,
    ),
  ]);
  const cards: MatchCard[] = [];
  for (const row of rows) {
    const other = profiles.get(otherOf(row, userId));
    if (other) cards.push(toCard(row, other, chats.get(row.id) ?? NO_CHAT));
  }
  return cards;
}

export async function getMatchCard(matchId: string, userId: string): Promise<MatchCard> {
  const row = await requireActiveMatch(matchId, userId);
  const otherId = otherOf(row, userId);
  const [profiles, chats] = await Promise.all([getProfileRows([otherId]), chatSummaries([row.id], userId)]);
  const other = profiles.get(otherId);
  if (!other) throw new HttpError("not_found", "Match not found");
  return toCard(row, other, chats.get(row.id) ?? NO_CHAT);
}

/** Ends the match for both people and deletes cached suggestions and the conversation (DB trigger). */
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
