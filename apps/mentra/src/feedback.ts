import type { InterestAck } from "@cue/contracts";

/**
 * Wearer feedback. Mentra Live has speakers and no display, so every cue is
 * audio (or nothing); there is no overlay.
 *
 * Privacy: a cue is a function of the wearer's own `InterestAck` or the
 * wearer's own device context only. None says anything about another person
 * beyond the acknowledged states:
 *  - `signal_sent`: the server holds the wearer's signal (accepted, or a
 *    duplicate of one already pending). Identical whether or not the other
 *    person has signalled.
 *  - `match`: this signal completed a mutual match (`ack.matched`).
 *  - `not_sent`: the signal was not recorded (rejected for any reason, or the
 *    network failed). One cue for every reason, so e.g. a block is not audible.
 *  - `encounter_off`: encounter mode is off, so the swipe was not sent.
 *  - `no_place`: encounter mode is on but Cue does not know where the wearer
 *    is (open Cue on the phone or check into a venue). Also used when the
 *    server rejects a signal with `no_place`.
 * Other gestures that never leave the device (wrong gesture, debounced) are
 * silent.
 */
export type FeedbackCue = "signal_sent" | "match" | "not_sent" | "encounter_off" | "no_place";

export interface FeedbackSink {
  /** Must not throw for an unsupported cue; resolve quietly instead. */
  play(cue: FeedbackCue): void | Promise<void>;
}

export function cueForAck(ack: InterestAck): FeedbackCue {
  if (ack.status === "rejected") {
    if (ack.reason === "no_place") return "no_place";
    if (ack.reason === "encounter_mode_off") return "encounter_off";
    return "not_sent";
  }
  if (ack.matched) return "match";
  return "signal_sent";
}

export const silentFeedback: FeedbackSink = { play: () => {} };

/** Records cues; used by tests and the injection harness. */
export function recordingFeedback(): FeedbackSink & { cues: FeedbackCue[] } {
  const cues: FeedbackCue[] = [];
  return { cues, play: (cue) => void cues.push(cue) };
}
