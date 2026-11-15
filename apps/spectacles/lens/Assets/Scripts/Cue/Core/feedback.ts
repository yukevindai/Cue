import type { ContextSnapshot } from "./encounter-context";
import type { InterestAck } from "./wire";

/**
 * Wearer feedback. Spectacles have a display and speakers, so each cue is a
 * short sound plus a line of text that only the wearer can see.
 *
 * Privacy: a cue is a function of the wearer's own InterestAck only, and there
 * are exactly three (the same three as apps/mentra/src/feedback.ts):
 *  - `signal_sent`: the server holds the wearer's signal (accepted, or a
 *    duplicate of one already pending). Identical whether or not the other
 *    person has signalled.
 *  - `match`: THIS signal completed a mutual match (`ack.matched`). The person
 *    who signalled first learns of the match in the web app, not here.
 *  - `not_sent`: the signal was not recorded (rejected for any reason, or the
 *    network failed). One cue for every reason, so e.g. a block is not visible.
 * Gestures that never leave the device are silent.
 */
export type FeedbackCue = "signal_sent" | "match" | "not_sent";

export function cueForAck(ack: InterestAck): FeedbackCue {
  if (ack.status === "rejected") return "not_sent";
  if (ack.matched) return "match";
  return "signal_sent";
}

/** Text shown for a cue. Never names the other person or a reason. */
export const CUE_TEXT: Record<FeedbackCue, string> = {
  signal_sent: "Signal sent",
  match: "It's a match. Check Cue on your phone",
  not_sent: "Not sent. Try again",
};

/** Resting status line, from the link and encounter state. */
export type LinkState = "unlinked" | "linking" | "linked";

export function statusText(link: LinkState, context: ContextSnapshot): string {
  if (link === "linking") return "Linking...";
  if (link === "unlinked" || context.state === "unlinked") {
    return "Not linked. Get a code in Cue on your phone, then double pinch to enter it";
  }
  switch (context.state) {
    case "ready":
      return "Encounter on. Double pinch to signal";
    case "no_place":
      return "Encounter on. Open Cue on your phone or check in to a venue";
    case "encounter_mode_off":
      return "Linked. Turn on encounter mode in Cue";
    case "offline":
      return "Can't reach Cue";
    case "stale":
      return "Connecting...";
  }
}

/** What the Lens adapter renders: a sound and a line of text. */
export interface FeedbackSink {
  /** Plays the cue's sound and shows its text for a moment. Must not throw. */
  play(cue: FeedbackCue): void;
  /** Sets the resting status line. */
  status(text: string): void;
}

export function recordingFeedback(): FeedbackSink & { cues: FeedbackCue[]; statuses: string[] } {
  const cues: FeedbackCue[] = [];
  const statuses: string[] = [];
  return {
    cues,
    statuses,
    play: (cue) => void cues.push(cue),
    status: (text) => void statuses.push(text),
  };
}
