/**
 * Runtime entry point: the background layer of a MentraOS local miniapp
 * (@mentra/miniapp 3.4.0). The Mentra phone app loads this bundle in a
 * per-miniapp JS context that stays alive while the app process is alive,
 * whether or not the miniapp's UI is open.
 *
 * This file is the only place that touches the Mentra SDK. It adapts the
 * session to `BridgeHost` and forwards EVERY touch-strip event, untouched, to
 * the bridge; which gesture counts is decided in touch-events.ts/config.ts.
 */
import { registerMiniapp } from "@mentra/miniapp/background";
import { CueBridge } from "../bridge";
import type { FeedbackCue, FeedbackSink } from "../feedback";
import { consoleSink, createLogger } from "../logger";
import type { Channels } from "../shared/channels";
import { CUE_SPEECH, cueDataUrl } from "../tones";

declare const process: { env: Record<string, string | undefined> };

registerMiniapp<Channels>(async (session) => {
  const logger = createLogger(consoleSink);

  // Mentra Live has speakers and no display. Audio is played by the phone and
  // reaches the glasses over Bluetooth audio when they are the active route.
  const feedback: FeedbackSink = {
    async play(cue: FeedbackCue) {
      try {
        await session.speaker.play({ audioUrl: cueDataUrl(cue), stopOtherAudio: false });
      } catch (error) {
        logger.warn("clip playback failed, falling back to speech", { cue, error });
        await session.speaker.speak(CUE_SPEECH[cue]);
      }
    },
  };

  const bridge = new CueBridge({
    storage: {
      get: (key) => session.storage.get(key),
      set: (key, value) => session.storage.set(key, value),
      delete: async (key) => {
        await session.storage.delete(key);
      },
    },
    feedback,
    logger,
    mentraUserId: () => session.auth.mentraUserId || session.userId || null,
    onStatus: (status) => session.ui.send("cue:status", status),
    defaultServerUrl: process.env.MENTRA_PUBLIC_CUE_SERVER_URL ?? null,
  });

  // Register UI handlers before any slow await (the host holds UI requests until startup settles).
  session.ui.onOpen(() => bridge.publish());
  session.ui.on("cue:refresh", () => void bridge.refresh().then(() => bridge.publish()));
  session.ui.on("cue:set-calibration", ({ on }) => void bridge.setCalibration(on));
  session.ui.on("cue:set-backward-gesture", ({ gestureName }) => void bridge.setBackwardGesture(gestureName));
  session.ui.on("cue:test-cue", ({ cue }) => void feedback.play(cue));
  session.ui.on("cue:unlink", () => void bridge.unlink());
  session.ui.handle("cue:set-server", ({ url }) => bridge.setServerUrl(url));
  session.ui.handle("cue:link", ({ code }) => bridge.linkWithCode(code));

  // One subscription to the bare `touch_event` stream: all gestures arrive, so
  // calibration can print them and the pipeline can ignore everything but one.
  session.input.onTouch((data) => void bridge.handleTouch(data));

  await bridge.start();
});
