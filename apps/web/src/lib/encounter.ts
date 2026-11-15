import {
  CreateVenueInput,
  LOCATION_MAX_ACCURACY_M,
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
 * pending signal, own mode and own place (check-in, location status). Nothing
 * in this module knows, or may ever be given, anything about another person.
 */

/* ---------- Venue code / venue name ---------- */

export const VENUE_CODE_LENGTH = 6;
export const VENUE_NAME_MAX = 80;

/**
 * Uppercase and drop whitespace and dashes, so "ab3 k-7q " typed on a phone
 * becomes "AB3K7Q". Never longer than a code.
 */
export function normalizeVenueCode(raw: string): string {
  return raw
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .slice(0, VENUE_CODE_LENGTH);
}

/** `null` when the (normalised) code can be submitted, else what to fix. */
export function venueCodeProblem(code: string): string | null {
  if (code.length === 0) return "Enter the 6-character code from the place's sign.";
  if (!/^[A-Z0-9]*$/.test(code)) return "Codes use only letters and numbers.";
  if (code.length !== VENUE_CODE_LENGTH) return "Venue codes are 6 characters.";
  return null;
}

/** `null` when the name can be submitted, else what to fix. Mirrors `CreateVenueInput`. */
export function venueNameProblem(raw: string): string | null {
  if (raw.trim().length === 0) return "Give the place a name, for example “Hackathon main hall”.";
  if (!CreateVenueInput.safeParse({ name: raw }).success) {
    return `Keep it to ${VENUE_NAME_MAX} characters or fewer.`;
  }
  return null;
}

/** `https://cue.example/v/AB3K7Q`: what a venue's QR code opens. */
export function venueCheckInUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/v/${encodeURIComponent(code)}`;
}

/* ---------- Place ---------- */

export type PlaceTone = "ready" | "not_ready" | "off";

export interface PlaceSummary {
  tone: PlaceTone;
  /** One short headline, e.g. "Ready to signal". */
  headline: string;
  /** One plain sentence on what that means or what to do next. */
  detail: string;
}

/**
 * The headline for "where Cue thinks you are". Driven by the server's `ready`
 * flag, which is the only thing that decides whether a signal can match.
 */
export function placeSummary(encounter: EncounterStatus): PlaceSummary {
  if (!encounter.encounterMode) {
    return {
      tone: "off",
      headline: "Encounter mode is off",
      detail: "Turn it on to signal. Nobody can match with you while it is off.",
    };
  }
  if (encounter.ready) {
    return {
      tone: "ready",
      headline: "Ready to signal",
      detail: encounter.checkIn
        ? `A signal can match with someone checked in at ${encounter.checkIn.name}, or close by.`
        : "A signal can match with someone close to you.",
    };
  }
  return {
    tone: "not_ready",
    headline: "Cue doesn't know where you are yet",
    detail: "Allow location, or check in with a venue code, so a signal can match.",
  };
}

/** The server's view of the phone location, in words. `null` when there is nothing to say. */
export function serverLocationText(encounter: EncounterStatus): string | null {
  const { location } = encounter;
  const acc = location.accuracyM === null ? null : Math.round(location.accuracyM);
  switch (location.status) {
    case "fresh":
      return acc === null ? "Location on" : `Location on, accurate to about ${acc} m`;
    case "inaccurate":
      return `Location too rough to use: about ${acc ?? "?"} m. Cue needs ${LOCATION_MAX_ACCURACY_M} m or better.`;
    case "stale":
      return "Location out of date. Keep Cue open so your phone can update it.";
    case "none":
      return null;
  }
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
  | { kind: "paused" }
  | { kind: "no_place" }
  | {
      kind: "pending";
      eventId: string;
      source: InterestSource;
      /** Whole seconds left, at least 1 while pending. */
      secondsLeft: number;
      /** 1 at the start of the window, approaching 0 at expiry. */
      fraction: number;
    }
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

  if (!encounter.ready) return { kind: "no_place" };
  return { kind: "idle" };
}

/** Both kinds of glasses read the same to the wearer; only the web button is "this page". */
export function signalSourceText(source: InterestSource): string {
  return source === "mentra_touch" || source === "headset_remote"
    ? "Sent from your glasses"
    : "Sent from this page";
}

/** The exact body of POST /api/interest for the web button. The schema is strict. */
export function buildInterestEvent(
  eventId: string = crypto.randomUUID(),
  now: Date = new Date(),
): InterestEvent {
  return {
    eventId,
    source: "web_demo",
    gesture: "web_confirm",
    occurredAt: now.toISOString(),
  };
}

export interface RejectionCopy {
  text: string;
  /** Refetch the encounter status: our picture of mode or place is out of date. */
  refresh: boolean;
}

export function rejectionCopy(reason: InterestRejectReason | null): RejectionCopy {
  switch (reason) {
    case "encounter_mode_off":
      return {
        text: "Encounter mode is off. Turn it on to signal.",
        refresh: true,
      };
    case "no_place":
      return {
        text: "Cue doesn't know where you are yet. Allow location, or check in with a venue code, then try again.",
        refresh: true,
      };
    default:
      return {
        text: "That signal didn't go through. Nothing was sent. Please try again.",
        refresh: true,
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

/* ---------- Return path after sign-in ---------- */

/**
 * A same-origin path to go to after signing in, or `fallback`. Only plain
 * absolute paths ("/v/AB3K7Q") are accepted: never another origin,
 * protocol-relative ("//evil"), backslash tricks or control characters.
 */
export function safeReturnPath(raw: string | null | undefined, fallback = "/encounter"): string {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const base = "https://cue.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    if (url.pathname.startsWith("/sign-in") || url.pathname.startsWith("/sign-up")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
