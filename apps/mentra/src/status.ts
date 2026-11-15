/** What the phone UI shows. Never contains the device token or anything about another user. */
export interface BridgeStatus {
  serverUrl: string | null;
  linked: boolean;
  /** ready | encounter_mode_off | no_place | unlinked | offline | stale */
  context: string;
  calibration: boolean;
  backwardGestureName: string | null;
  mentraUserId: string | null;
  /** Listening through the glasses' microphone for a spoken name (unlinked only). */
  listening: boolean;
  /** Display name of the guest account these glasses belong to, if they were set up by voice. */
  guestName: string | null;
  /** Most recent raw gestures, newest first. `at` is the phone clock (epoch ms). */
  recentGestures: { gestureName: string; at: number }[];
  /** Human-readable result of the last backward swipe, e.g. "submitted: accepted". */
  lastOutcome: string | null;
}

export type LinkResponse = { ok: true } | { ok: false; error: string };

/** Answer to "open Cue as the guest": the URL only (it is one-time; never the device token). */
export type HandoffResponse = { ok: true; url: string } | { ok: false; error: string };
