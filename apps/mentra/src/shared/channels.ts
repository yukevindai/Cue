import type { MentraTyped, Rpc } from "@mentra/miniapp/ui";
import type { FeedbackCue } from "../feedback";

import type { BridgeStatus, LinkResponse } from "../status";

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
}

declare global {
  var mentra: MentraTyped<Channels>;
}
