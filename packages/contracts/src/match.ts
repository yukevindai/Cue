import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { VenueLabelSource } from "./encounter";
import { SharedProfile } from "./profile";

/** A match as seen by one participant. */
export const MatchCard = z.object({
  id: Uuid,
  /** The other person's approved profile fields. */
  other: SharedProfile,
  /** Server receipt time of the first signal of the pair. */
  encounterAt: IsoDateTime,
  venueLabel: z.string(),
  venueLabelSource: VenueLabelSource,
  createdAt: IsoDateTime,
  /** Messages from the other person that arrived after the viewer last opened the chat. */
  unreadCount: z.number().int().nonnegative().default(0),
  /** When the newest chat message was sent, by either person; null when there are none. */
  lastMessageAt: IsoDateTime.nullable().default(null),
});
export type MatchCard = z.infer<typeof MatchCard>;

/** GET /api/matches */
export const MatchList = z.object({ matches: z.array(MatchCard) });
export type MatchList = z.infer<typeof MatchList>;

/** POST /api/blocks */
export const BlockInput = z.object({ userId: Uuid });
export type BlockInput = z.infer<typeof BlockInput>;

/**
 * Realtime: clients subscribe to Postgres changes on `public.matches`
 * (RLS limits rows to participants) and refetch GET /api/matches on any event.
 * Row shape as delivered by Supabase Realtime (snake_case DB columns).
 */
export const MatchRealtimeRow = z.object({
  id: Uuid,
  user_a: Uuid,
  user_b: Uuid,
  status: z.enum(["active", "ended"]),
});
export type MatchRealtimeRow = z.infer<typeof MatchRealtimeRow>;
