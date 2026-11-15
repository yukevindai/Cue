import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

/**
 * In-app texting between the two people of an ACTIVE match. Messages are
 * private to the pair, are never sent to Claude, and are deleted when the match
 * ends (unmatch, block, demo reset). Bodies are plain text: clients must render
 * them as text only, with no links, previews or markup.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 1000;
export const CHAT_PAGE_SIZE = 50;

export const ChatMessage = z.object({
  id: Uuid,
  matchId: Uuid,
  /** True when the signed-in user sent it. The other person's id is not repeated here. */
  mine: z.boolean(),
  body: z.string(),
  createdAt: IsoDateTime,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Body of POST /api/matches/[id]/messages. */
export const SendMessageInput = z
  .object({
    /** Client-generated idempotency key: re-sending the same id returns the stored message. */
    clientId: Uuid,
    body: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
  })
  .strict();
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/**
 * GET /api/matches/[id]/messages[?before=<cursor>] -> newest page, oldest first.
 * Fetching the newest page (no cursor) marks the conversation as read.
 */
export const MessageList = z.object({
  messages: z.array(ChatMessage),
  /** Pass as `before` to load older messages; null when there are none. */
  olderCursor: z.string().nullable(),
});
export type MessageList = z.infer<typeof MessageList>;

/**
 * Realtime: clients subscribe to Postgres changes on `public.chat_messages`
 * (RLS limits rows to participants of the active match) and refetch through
 * the API on any event. Row contents from realtime are never rendered.
 */
export const ChatRealtimeRow = z.object({ id: Uuid, match_id: Uuid });
export type ChatRealtimeRow = z.infer<typeof ChatRealtimeRow>;
