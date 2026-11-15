import {
  GESTURE_DEBOUNCE_MS,
  InterestEvent,
  type InterestAck,
  type InterestGesture,
} from "@cue/contracts";
import { rejectionCopy } from "./encounter";

/**
 * Headset remote: turn one media command, received by this page from whatever
 * Bluetooth headset is the phone's audio route, into an interest signal.
 *
 * Pure logic only. The card in `components/encounter/headset-remote-card.tsx`
 * owns the audio element, the Media Session handlers and the network call.
 *
 * Mirrors the Mentra pipeline (apps/mentra/src/pipeline.ts): command ->
 * choice gate -> session / mode gate -> pending gate -> debounce ->
 * InterestEvent. Every command that does not become a signal gets a reason the
 * wearer can read; nothing is dropped silently.
 *
 * PRIVACY: every input here is the wearer's OWN state (listening, own session
 * membership, own mode, own pending signal). Nothing about the other person.
 */

/** Media Session actions this page listens for. */
export const MEDIA_COMMANDS = ["play", "pause", "nexttrack", "previoustrack"] as const;
export type MediaCommand = (typeof MEDIA_COMMANDS)[number];

/** Where a command came from: a Media Session action handler, or the audio element pausing itself. */
export type CommandOrigin = "handler" | "element";

/**
 * What the wearer chose as their signal. Play and pause are one choice: a
 * single tap may arrive as either, depending on what the phone thinks is
 * playing.
 */
export const SIGNAL_CHOICES = ["playpause", "nexttrack", "previoustrack"] as const;
export type SignalChoice = (typeof SIGNAL_CHOICES)[number];

export const DEFAULT_SIGNAL_CHOICE: SignalChoice = "nexttrack";
export const SIGNAL_CHOICE_STORAGE_KEY = "cue.headset-signal-choice";
/** How many received commands the card lists. */
export const RECENT_COMMANDS_MAX = 5;

export function choiceForCommand(command: MediaCommand): SignalChoice {
  return command === "play" || command === "pause" ? "playpause" : command;
}

export function gestureForCommand(command: MediaCommand): InterestGesture {
  switch (command) {
    case "play":
    case "pause":
      return "media_play_pause";
    case "nexttrack":
      return "media_next_track";
    case "previoustrack":
      return "media_previous_track";
  }
}

export function isMediaCommand(value: unknown): value is MediaCommand {
  return typeof value === "string" && (MEDIA_COMMANDS as readonly string[]).includes(value);
}

/** Stored value -> choice; anything unknown falls back to the default (double tap). */
export function parseSignalChoice(raw: string | null | undefined): SignalChoice {
  return typeof raw === "string" && (SIGNAL_CHOICES as readonly string[]).includes(raw)
    ? (raw as SignalChoice)
    : DEFAULT_SIGNAL_CHOICE;
}

/* ---------- Copy ---------- */

export function commandLabel(command: MediaCommand): string {
  switch (command) {
    case "play":
      return "Play (single tap)";
    case "pause":
      return "Pause (single tap)";
    case "nexttrack":
      return "Next track (double tap)";
    case "previoustrack":
      return "Previous track (triple tap)";
  }
}

/** "Double tap (next track)". */
export function choiceLabel(choice: SignalChoice): string {
  switch (choice) {
    case "playpause":
      return "Single tap (play/pause)";
    case "nexttrack":
      return "Double tap (next track)";
    case "previoustrack":
      return "Triple tap (previous track)";
  }
}

/** "Double tap the temple of your glasses". */
export function choiceInstruction(choice: SignalChoice): string {
  switch (choice) {
    case "playpause":
      return "Tap the temple of your glasses once";
    case "nexttrack":
      return "Double tap the temple of your glasses";
    case "previoustrack":
      return "Triple tap the temple of your glasses";
  }
}

/* ---------- Decision ---------- */

export type IgnoreReason =
  | "not_listening"
  | "not_chosen"
  | "no_session"
  | "session_not_full"
  | "encounter_mode_off"
  | "already_pending"
  | "debounced";

/** The wearer's own state at the moment a command arrives. */
export interface HeadsetState {
  listening: boolean;
  choice: SignalChoice;
  session: { id: string; memberCount: number; capacity: number } | null;
  encounterMode: boolean;
  /** Own signal already out, or a send still in flight. */
  pending: boolean;
  /** When the last signal was sent from this card (ms), or null. */
  lastSentAtMs: number | null;
}

export type HeadsetDecision =
  | { kind: "send"; event: InterestEvent }
  | { kind: "ignored"; reason: IgnoreReason };

export function decideCommand(
  command: MediaCommand,
  state: HeadsetState,
  nowMs: number,
  newEventId: () => string = () => crypto.randomUUID(),
  debounceMs: number = GESTURE_DEBOUNCE_MS,
): HeadsetDecision {
  if (!state.listening) return { kind: "ignored", reason: "not_listening" };
  if (choiceForCommand(command) !== state.choice) return { kind: "ignored", reason: "not_chosen" };
  const { session } = state;
  if (!session) return { kind: "ignored", reason: "no_session" };
  if (session.memberCount < session.capacity) return { kind: "ignored", reason: "session_not_full" };
  if (!state.encounterMode) return { kind: "ignored", reason: "encounter_mode_off" };
  if (state.pending) return { kind: "ignored", reason: "already_pending" };
  if (state.lastSentAtMs !== null && nowMs - state.lastSentAtMs < debounceMs) {
    return { kind: "ignored", reason: "debounced" };
  }
  const event = InterestEvent.parse({
    eventId: newEventId(),
    encounterSessionId: session.id,
    source: "headset_remote",
    gesture: gestureForCommand(command),
    occurredAt: new Date(nowMs).toISOString(),
  });
  return { kind: "send", event };
}

export function ignoreReasonText(reason: IgnoreReason, choice: SignalChoice): string {
  switch (reason) {
    case "not_listening":
      return "this page isn't listening.";
    case "not_chosen":
      return `not your signal. Yours is ${choiceLabel(choice).toLowerCase()}.`;
    case "no_session":
      return "you're not in a session.";
    case "session_not_full":
      return "the second person hasn't joined yet.";
    case "encounter_mode_off":
      return "encounter mode is paused. Resume to signal.";
    case "already_pending":
      return "your signal is already out.";
    case "debounced":
      return "too soon after your last signal.";
  }
}

/* ---------- Echoes ---------- */

export interface ReceivedCommand {
  id: number;
  command: MediaCommand;
  origin: CommandOrigin;
  atMs: number;
}

/**
 * One single tap can reach the page twice: the `pause` action handler and the
 * audio element's own `pause` event. Treat a play/pause from the other origin
 * within the debounce window as the same tap, so it is listed once and never
 * counted twice.
 */
export function isEcho(
  previous: ReceivedCommand | null,
  command: MediaCommand,
  origin: CommandOrigin,
  nowMs: number,
  windowMs: number = GESTURE_DEBOUNCE_MS,
): boolean {
  if (!previous) return false;
  return (
    choiceForCommand(previous.command) === "playpause" &&
    choiceForCommand(command) === "playpause" &&
    previous.origin !== origin &&
    nowMs - previous.atMs < windowMs
  );
}

/** Newest first, at most `max`. */
export function pushRecent<T>(list: readonly T[], item: T, max: number = RECENT_COMMANDS_MAX): T[] {
  return [item, ...list].slice(0, max);
}

/* ---------- Outcome of the most recent command ---------- */

export type CommandOutcome =
  | { kind: "sending" }
  | { kind: "sent"; ack: InterestAck }
  /** The request failed before the server answered; `detail` says why. */
  | { kind: "failed"; detail: string }
  /** The request timed out or the answer was unreadable: it may or may not have landed. */
  | { kind: "unconfirmed" }
  | { kind: "ignored"; reason: IgnoreReason };

export function outcomeText(outcome: CommandOutcome, choice: SignalChoice): string {
  switch (outcome.kind) {
    case "sending":
      return "Sending your signal…";
    case "failed":
      return `Not sent. ${outcome.detail}`;
    case "unconfirmed":
      return "Not confirmed. If your signal went out it will show above in a moment; if not, try again.";
    case "ignored":
      return `Ignored: ${ignoreReasonText(outcome.reason, choice)}`;
    case "sent": {
      const { ack } = outcome;
      if (ack.status === "rejected") return `Not sent. ${rejectionCopy(ack.reason).text}`;
      if (ack.matched) return "Sent. It's a match.";
      if (ack.status === "duplicate") return "Sent, but your signal was already out.";
      return "Sent. Your signal is out.";
    }
  }
}

export type FeedbackTone = "sent" | "not_sent";

/**
 * Which short tone to play in the wearer's ear. A match plays the global match
 * chime instead; other people's commands and stray taps stay silent.
 */
export function toneForOutcome(outcome: CommandOutcome): FeedbackTone | null {
  switch (outcome.kind) {
    case "sending":
      return null;
    case "failed":
    case "unconfirmed":
      return "not_sent";
    case "ignored":
      return outcome.reason === "not_chosen" ||
        outcome.reason === "not_listening" ||
        outcome.reason === "debounced"
        ? null
        : "not_sent";
    case "sent":
      if (outcome.ack.status === "rejected") return "not_sent";
      if (outcome.ack.matched) return null;
      return "sent";
  }
}

/* ---------- The quiet track ---------- */

/**
 * A mono 16-bit WAV as a data URL: a low tone at about -50 dBFS. Quiet, but not
 * digitally silent, because iOS can drop a silent track from Now Playing. The
 * tone fits a whole number of cycles so the loop has no click.
 */
export function buildQuietWavDataUrl({
  seconds = 2,
  sampleRate = 22050,
  frequency = 220,
  dbfs = -50,
}: { seconds?: number; sampleRate?: number; frequency?: number; dbfs?: number } = {}): string {
  const samples = Math.round(seconds * sampleRate);
  const cycles = Math.max(1, Math.round((frequency * samples) / sampleRate));
  const amplitude = Math.round(32767 * Math.pow(10, dbfs / 20));
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples; i++) {
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * cycles * i) / samples));
    v.setInt16(44 + i * 2, s, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/wav;base64,${btoa(bin)}`;
}
