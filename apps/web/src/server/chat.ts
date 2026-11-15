import "server-only";

import { CHAT_PAGE_SIZE, type ChatMessage, type MessageList, type SendMessageInput } from "@cue/contracts";
import type { PostgrestError } from "@supabase/supabase-js";
import { iso, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { requireActiveMatch } from "@/server/matches";
import { rateLimit } from "@/server/rate-limit";
import { getAdminSupabase } from "@/server/supabase-admin";

/**
 * In-app chat between the two people of an ACTIVE match.
 *
 * Authorization happens here, before any service-role query: the caller must
 * be a participant of the active match, otherwise everything is the same
 * `not_found` (ended, someone else's, malformed id). A DB trigger enforces the
 * same rule on every insert (SQLSTATE CUE03), which covers a match that ends
 * between the check and the write.
 *
 * Bodies are stored exactly as validated by `SendMessageInput` and are never
 * logged.
 */

/** Per sender, across all their conversations. */
export const SEND_LIMIT = 20;
export const SEND_WINDOW_MS = 10_000;

const MESSAGE_COLUMNS = "id, match_id, sender_id, body, created_at";

interface MessageRow {
  id: string;
  match_id: string;
  sender_id: string;
  body: string;
  /** Raw timestamptz text from PostgREST (microseconds kept; used for cursors and read markers). */
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/;

const NOT_FOUND = () => new HttpError("not_found", "Match not found");

function toMessage(row: MessageRow, viewerId: string): ChatMessage {
  // The sender id is reduced to `mine`; it never leaves the server.
  return {
    id: row.id,
    matchId: row.match_id,
    mine: row.sender_id === viewerId,
    body: row.body,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Cursor: base64url("<created_at>|<id>") of the oldest message on the page.
// Opaque to clients; validated strictly because it is interpolated into a
// PostgREST filter.
// ---------------------------------------------------------------------------

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: MessageRow): string {
  return Buffer.from(`${row.created_at}|${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  const invalid = new HttpError("invalid_request", "Invalid cursor");
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  const [createdAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !createdAt || !id) throw invalid;
  if (!PG_TIMESTAMP_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id)) throw invalid;
  return { createdAt, id };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * One page of the conversation, oldest first. Without a cursor: the newest
 * CHAT_PAGE_SIZE messages, and the viewer's read marker moves to the newest
 * message on that page (what they have now seen). With `before`: the page of
 * messages just older than the cursor; read markers are untouched.
 */
export async function listMessages(matchId: string, viewerId: string, before: string | null): Promise<MessageList> {
  if (!UUID_RE.test(matchId)) throw NOT_FOUND();
  const cursor = before === null ? null : decodeCursor(before);
  await requireActiveMatch(matchId, viewerId);

  let query = getAdminSupabase().from("chat_messages").select(MESSAGE_COLUMNS).eq("match_id", matchId);
  if (cursor) {
    query = query.or(
      `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt.${cursor.id})`,
    );
  }
  const rows = unwrap(
    await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(CHAT_PAGE_SIZE + 1),
  ) as MessageRow[];

  const hasOlder = rows.length > CHAT_PAGE_SIZE;
  const page = rows.slice(0, CHAT_PAGE_SIZE);

  if (!cursor && page.length > 0) await markRead(matchId, viewerId, page[0].created_at);

  return {
    messages: page.reverse().map((r) => toMessage(r, viewerId)),
    olderCursor: hasOlder ? encodeCursor(page[0]) : null,
  };
}

async function markRead(matchId: string, viewerId: string, seenUpTo: string): Promise<void> {
  const { error } = await getAdminSupabase()
    .from("chat_reads")
    .upsert({ match_id: matchId, user_id: viewerId, last_read_at: seenUpTo }, { onConflict: "match_id,user_id" });
  if (error?.code === "CUE03") throw NOT_FOUND(); // match ended meanwhile
  if (error) throw dbError(error);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendResult {
  message: ChatMessage;
  /** False when this clientId was already stored (a retry): the stored message is returned. */
  created: boolean;
}

/**
 * Store a message from `senderId`. Idempotent per (sender, clientId): a retry,
 * including one racing the original, returns the stored row and creates
 * nothing (the unique constraint decides the winner).
 */
export async function sendMessage(matchId: string, senderId: string, input: SendMessageInput): Promise<SendResult> {
  if (!UUID_RE.test(matchId)) throw NOT_FOUND();
  rateLimit(`chat:${senderId}`, SEND_LIMIT, SEND_WINDOW_MS);
  await requireActiveMatch(matchId, senderId);

  const db = getAdminSupabase();
  const { data, error } = await db
    .from("chat_messages")
    .insert({ match_id: matchId, sender_id: senderId, client_id: input.clientId, body: input.body })
    .select(MESSAGE_COLUMNS)
    .single();
  if (!error) return { message: toMessage(data as MessageRow, senderId), created: true };
  if (error.code === "CUE03") throw NOT_FOUND();
  if (error.code !== "23505") throw dbError(error);

  const existing = unwrap(
    await db
      .from("chat_messages")
      .select(MESSAGE_COLUMNS)
      .eq("sender_id", senderId)
      .eq("client_id", input.clientId)
      .maybeSingle(),
  ) as MessageRow | null;
  // Gone again (match ended between the two queries) or the id belongs to another conversation.
  if (!existing) throw NOT_FOUND();
  if (existing.match_id !== matchId) {
    throw new HttpError("invalid_request", "clientId was already used for another conversation");
  }
  return { message: toMessage(existing, senderId), created: false };
}

/** A database error without the request payload (message bodies must not reach logs). */
function dbError(error: PostgrestError): Error {
  return new Error(`database error ${error.code}`);
}
