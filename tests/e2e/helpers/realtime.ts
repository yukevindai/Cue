import type { RealtimeChannel } from "@supabase/supabase-js";
import type { Actor } from "./auth";

export interface RealtimeEvent {
  /** Local receipt time (Date.now()). */
  at: number;
  eventType: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

export interface TableWatcher {
  events: RealtimeEvent[];
  /** Resolves with the first (already received or future) matching event, or null on timeout. */
  waitFor(timeoutMs: number, predicate?: (e: RealtimeEvent) => boolean): Promise<RealtimeEvent | null>;
  close(): Promise<void>;
}

/**
 * Subscribes to Postgres changes on `public.<table>` using the actor's own JWT
 * (RLS applies), and resolves only once the channel is SUBSCRIBED.
 */
export async function watchTable(actor: Actor, table: string): Promise<TableWatcher> {
  const events: RealtimeEvent[] = [];
  const waiters: Array<() => void> = [];
  await actor.supabase.realtime.setAuth(actor.session.access_token);

  const channel: RealtimeChannel = actor.supabase
    .channel(`e2e-${table}-${actor.user.marker}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      events.push({
        at: Date.now(),
        eventType: payload.eventType,
        new: (payload.new ?? {}) as Record<string, unknown>,
        old: (payload.old ?? {}) as Record<string, unknown>,
      });
      for (const w of waiters.splice(0)) w();
    });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`realtime subscribe to ${table} timed out`)), 15_000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        reject(new Error(`realtime subscribe to ${table} failed: ${status} ${err?.message ?? ""}`));
      }
    });
  });

  return {
    events,
    async waitFor(timeoutMs, predicate = () => true) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) return hit;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    async close() {
      await actor.supabase.removeChannel(channel);
    },
  };
}
