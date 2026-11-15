import type { ChatMessage } from "@cue/contracts";

/**
 * Pure helpers for the conversation view: merging pages, the local outbox,
 * and turning a list of messages into day separators and sender runs.
 */

/** A message the person has sent that the server has not confirmed yet. */
export interface OutgoingMessage {
  /** Idempotency key. The SAME id is reused when the person retries. */
  clientId: string;
  body: string;
  /** Local time the person pressed send. */
  createdAt: string;
  status: "sending" | "failed";
  /** Plain reason shown with "Try again". */
  error?: string;
}

const time = (iso: string) => new Date(iso).getTime();

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Union by id, oldest first. Incoming copies replace stored ones. */
export function mergeMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(compareMessages);
}

export type TimelineEntry =
  | { kind: "day"; key: string; label: string }
  | {
      kind: "message";
      key: string;
      mine: boolean;
      body: string;
      createdAt: string;
      /** First message of a run from the same sender. */
      runStart: boolean;
      /** Last message of a run: where the time label goes. */
      runEnd: boolean;
      outgoing?: OutgoingMessage;
    };

/** Messages from one sender within this gap read as one run. */
const RUN_GAP_MS = 5 * 60 * 1000;

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", "Monday" (this past week), then "Nov 12" or "Nov 12, 2025". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** "3:42 PM", in the viewer's locale. */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Confirmed messages (oldest first) followed by the outbox, with a day label
 * wherever the calendar day changes and run boundaries for spacing and times.
 */
export function buildTimeline(
  messages: readonly ChatMessage[],
  outbox: readonly OutgoingMessage[] = [],
  now: Date = new Date(),
): TimelineEntry[] {
  type Item = { key: string; mine: boolean; body: string; createdAt: string; outgoing?: OutgoingMessage };
  const items: Item[] = [
    ...messages.map((m) => ({ key: m.id, mine: m.mine, body: m.body, createdAt: m.createdAt })),
    ...outbox.map((o) => ({ key: `out-${o.clientId}`, mine: true, body: o.body, createdAt: o.createdAt, outgoing: o })),
  ];

  const out: TimelineEntry[] = [];
  let lastDay: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const prev = items[i - 1];
    const next = items[i + 1];
    const day = dayStart(new Date(it.createdAt));
    const newDay = day !== lastDay;
    if (newDay) {
      out.push({ kind: "day", key: `day-${day}`, label: dayLabel(it.createdAt, now) });
      lastDay = day;
    }
    const sameRun = (a: Item | undefined, b: Item | undefined) =>
      !!a &&
      !!b &&
      a.mine === b.mine &&
      dayStart(new Date(a.createdAt)) === dayStart(new Date(b.createdAt)) &&
      Math.abs(time(b.createdAt) - time(a.createdAt)) <= RUN_GAP_MS &&
      // A failed message always stands on its own so its "Try again" is clear.
      a.outgoing?.status !== "failed" &&
      b.outgoing?.status !== "failed";
    out.push({
      kind: "message",
      key: it.key,
      mine: it.mine,
      body: it.body,
      createdAt: it.createdAt,
      runStart: newDay || !sameRun(prev, it),
      runEnd: !sameRun(it, next),
      outgoing: it.outgoing,
    });
  }
  return out;
}

/** Plain-text check for the composer: something to send, within the limit. */
export function canSend(body: string, max: number): boolean {
  const t = body.trim();
  return t.length > 0 && t.length <= max;
}
