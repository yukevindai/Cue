import type { MentraTyped, Rpc } from "@mentra/miniapp/ui";
import type { FeedbackCue } from "../feedback";

import type { BridgeStatus, HandoffResponse, LinkResponse } from "../status";

export interface Channels {
  // background -> UI
  "cue:status": BridgeStatus;
  // UI -> background
  "cue:refresh": Record<string, never>;
  "cue:set-calibration": { on: boolean };
  "cue:set-backward-gesture": { gestureName: string | null };
  "cue:test-cue": { cue: FeedbackCue };
  "cue:unlink": Record<string, never>;
  "cue:set-server": Rpc<{ url: string }, LinkResponse>;
  "cue:link": Rpc<{ code: string }, LinkResponse>;
  /** Background opens the guest sign-in link in the phone browser and returns the URL as a fallback link. */
  "cue:open-guest": Rpc<Record<string, never>, HandoffResponse>;
}

declare global {
  var mentra: MentraTyped<Channels>;
}
