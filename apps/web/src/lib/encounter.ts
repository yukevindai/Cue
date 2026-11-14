import {
  MATCH_WINDOW_SECONDS,
  type EncounterStatus,
  type InterestEvent,
  type InterestRejectReason,
  type InterestSource,
  type PendingSignal,
} from "@cue/contracts";

/**
 * Pure helpers for the Encounter view.
 *
 * Privacy rule (spec §2/§4): everything here is derived from the caller's OWN
 * pending signal, own mode, and session membership. Nothing in this module
 * knows, or may ever be given, anything about the other person's signal.
 */

/* ---------- Join code / venue label ---------- */

export const JOIN_CODE_MIN = 4;
export const JOIN_CODE_MAX = 12;
export const VENUE_LABEL_MAX = 80;

/** Uppercase and drop all whitespace, so "ab c1 " typed on a phone becomes "ABC1". */
export function normalizeJoinCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** `null` when the (normalised) code can be submitted, else what to fix. */
export function joinCodeProblem(code: string): string | null {
  if (code.length === 0) return "Enter the code from the other person's screen.";
  if (code.length < JOIN_CODE_MIN) return `Codes are at least ${JOIN_CODE_MIN} characters.`;
  if (code.length > JOIN_CODE_MAX) return `Codes are at most ${JOIN_CODE_MAX} characters.`;
  return null;
}

/** `null` when the venue label can be submitted, else what to fix. */
export function venueLabelProblem(raw: string): string | null {
  const label = raw.trim();
  if (label.length === 0) return "Type where you are, for example “Hackathon main hall”.";
  if (label.length > VENUE_LABEL_MAX) return `Keep it to ${VENUE_LABEL_MAX} characters or fewer.`;
  return null;
}

/* ---------- Session occupancy (membership, not interest) ---------- */

export function isSessionFull(session: { memberCount: number; capacity: number }): boolean {
  return session.memberCount >= session.capacity;
}

export function occupancyText(session: { memberCount: number; capacity: number }): string {
  return isSessionFull(session)
    ? "Both of you are here."
    : "Just you so far. Share the code with one other person.";
}

/* ---------- Own signal ---------- */

/**
 * The pending signal to render. Normally the server's. Right after our own
 * POST is accepted we hold the ack as a short-lived optimistic signal so the
 * panel does not flash idle before the refetch lands; it is dropped as soon
 * as any encounter status fetched at or after the ack arrives, whatever that
 * status says (pending, consumed by a match, or cleared by a reset).
 */
export function effectivePendingSignal(
  encounter: EncounterStatus,
  optimistic: PendingSignal | null,
): PendingSignal | null {
  if (encounter.pendingSignal) return encounter.pendingSignal;
  if (!optimistic) return null;
  const serverSaw = new Date(encounter.serverTime).getTime();
  const acked = new Date(optimistic.receivedAt).getTime();
  return serverSaw < acked ? optimistic : null;
}

export type SignalView =
  | { kind: "no_session" }
  | { kind: "paused" }
  | {
      kind: "pending";
      eventId: string;
      source: InterestSource;
      /** Whole seconds left, at least 1 while pending. */
      secondsLeft: number;
      /** 1 at the start of the window, approaching 0 at expiry. */
      fraction: number;
    }
  | { kind: "waiting_for_partner" }
  | { kind: "idle" };

/**
 * What the signal panel shows. `serverNowMs` is `Date.now() + clockOffsetMs`.
 * A pending signal whose `expiresAt` has passed is treated as gone straight
 * away, without waiting for the server to stop returning it.
 */
export function deriveSignalView(
  encounter: EncounterStatus,
  serverNowMs: number,
  optimistic: PendingSignal | null = null,
): SignalView {
  const { session } = encounter;
  if (!session) return { kind: "no_session" };
  if (!encounter.encounterMode) return { kind: "paused" };

  const signal = effectivePendingSignal(encounter, optimistic);
  if (signal) {
    const expiresMs = new Date(signal.expiresAt).getTime();
    const remainingMs = expiresMs - serverNowMs;
    if (remainingMs > 0) {
      const receivedMs = new Date(signal.receivedAt).getTime();
      const windowMs =
        expiresMs > receivedMs ? expiresMs - receivedMs : MATCH_WINDOW_SECONDS * 1000;
      return {
        kind: "pending",
        eventId: signal.eventId,
        source: signal.source,
        secondsLeft: Math.ceil(remainingMs / 1000),
        fraction: Math.min(1, Math.max(0, remainingMs / windowMs)),
      };
    }
  }

  if (!isSessionFull(session)) return { kind: "waiting_for_partner" };
  return { kind: "idle" };
}

export function signalSourceText(source: InterestSource): string {
  return source === "mentra_touch" ? "Sent from your glasses" : "Sent from this page";
}

/** The exact body of POST /api/interest for the web button. The schema is strict. */
export function buildInterestEvent(
  encounterSessionId: string,
  eventId: string = crypto.randomUUID(),
  now: Date = new Date(),
): InterestEvent {
  return {
    eventId,
    encounterSessionId,
    source: "web_demo",
    gesture: "web_confirm",
    occurredAt: now.toISOString(),
  };
}

export interface RejectionCopy {
  text: string;
  /** Refetch the encounter status: our picture of the session is out of date. */
  refresh: boolean;
  /** Offer a link to /matches. */
  matchesLink: boolean;
}

export function rejectionCopy(reason: InterestRejectReason | null): RejectionCopy {
  switch (reason) {
    case "not_in_session":
      return { text: "You're not in this session any more.", refresh: true, matchesLink: false };
    case "session_inactive":
      return {
        text: "This session has ended. Start or join a new one.",
        refresh: true,
        matchesLink: false,
      };
    case "encounter_mode_off":
      return {
        text: "Encounter mode is paused. Resume to signal.",
        refresh: true,
        matchesLink: false,
      };
    case "blocked":
      return {
        text: "Signals aren't available in this session.",
        refresh: false,
        matchesLink: false,
      };
    case "already_matched":
      return {
        text: "You two have already matched. Their card is in Matches.",
        refresh: false,
        matchesLink: true,
      };
    default:
      return {
        text: "That signal didn't go through. Nothing was sent. Please try again.",
        refresh: true,
        matchesLink: false,
      };
  }
}

/* ---------- Pairing code ---------- */

/** "ABC123" -> "ABC 123" for display. */
export function groupPairingCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`.trim();
}

/** "ABC123" -> "A B C 1 2 3", so a screen reader spells it out. */
export function spellCode(code: string): string {
  return code.split("").join(" ");
}

/** Seconds as "m:ss". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
