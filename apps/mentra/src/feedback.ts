import type { InterestAck } from "@cue/contracts";

/**
 * Wearer feedback. Mentra Live has speakers and no display, so every cue is
 * audio (or nothing); there is no overlay.
 *
 * Privacy: a cue is a function of the wearer's own `InterestAck` only. There
 * are exactly three, and none says anything about the other person beyond the
 * acknowledged states:
 *  - `signal_sent`: the server holds the wearer's signal (accepted, or a
 *    duplicate of one already pending). Identical whether or not the other
 *    person has signalled.
 *  - `match`: this signal completed a mutual match (`ack.matched`).
 *  - `not_sent`: the signal was not recorded (rejected for any reason, or the
 *    network failed). One cue for every reason, so e.g. a block is not audible.
 * Gestures that never leave the device (wrong gesture, encounter mode off,
 * debounced) are silent.
 */
export type FeedbackCue = "signal_sent" | "match" | "not_sent";

export interface FeedbackSink {
  /** Must not throw for an unsupported cue; resolve quietly instead. */
  play(cue: FeedbackCue): void | Promise<void>;
}

export function cueForAck(ack: InterestAck): FeedbackCue {
  if (ack.status === "rejected") return "not_sent";
  if (ack.matched) return "match";
  return "signal_sent";
}

export const silentFeedback: FeedbackSink = { play: () => {} };

/** Records cues; used by tests and the injection harness. */
export function recordingFeedback(): FeedbackSink & { cues: FeedbackCue[] } {
  const cues: FeedbackCue[] = [];
  return { cues, play: (cue) => void cues.push(cue) };
}
