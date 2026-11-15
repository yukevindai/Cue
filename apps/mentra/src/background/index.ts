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

/** Served by the Cue web app from `apps/web/public/sounds/signal.mp3`. */
const SIGNAL_SOUND_PATH = "/sounds/signal.mp3";

registerMiniapp<Channels>(async (session) => {
  const logger = createLogger(consoleSink);

  let confirmedSignalSound: string | null = null;
  /** The "sent" clip on the current Cue server, or null to use the built-in beep. */
  async function signalSoundUrl(): Promise<string | null> {
    const serverUrl = bridge.status().serverUrl;
    if (serverUrl === null) return null;
    const url = `${serverUrl}${SIGNAL_SOUND_PATH}`;
    if (confirmedSignalSound === url) return url;
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) return null;
      confirmedSignalSound = url;
      return url;
    } catch {
      return null;
    }
  }

  // Mentra Live has speakers and no display. Audio is played by the phone and
  // reaches the glasses over Bluetooth audio when they are the active route.
  const feedback: FeedbackSink = {
    async play(cue: FeedbackCue) {
      const clip = cue === "signal_sent" ? await signalSoundUrl() : null;
      for (const audioUrl of clip ? [clip, cueDataUrl(cue)] : [cueDataUrl(cue)]) {
        try {
          await session.speaker.play({ audioUrl, stopOtherAudio: false });
          return;
        } catch (error) {
          logger.warn("clip playback failed", { cue, error });
        }
      }
      await session.speaker.speak(CUE_SPEECH[cue]);
    },
  };

  /** Speaks one line, waiting (briefly) for a cue that is still playing so the two do not overlap. */
  async function speakLine(text: string): Promise<void> {
    for (let waited = 0; session.speaker.isPlaying && waited < 3000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await session.speaker.speak(text);
  }

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
    speak: speakLine,
    // Only offered when the manifest declares MICROPHONE; the OS-level grant is not observable.
    transcription: session.permissions.has("microphone")
      ? { start: (onTranscript) => session.transcription.forLanguage("en-US", (data) => onTranscript(data)) }
      : undefined,
    openUrl: (url) => session.system.openUrl(url),
  });

  // Register UI handlers before any slow await (the host holds UI requests until startup settles).
  session.ui.onOpen(() => {
    bridge.screenOpened();
    bridge.publish();
  });
  session.ui.on("cue:refresh", () => void bridge.refresh().then(() => bridge.publish()));
  session.ui.on("cue:set-calibration", ({ on }) => void bridge.setCalibration(on));
  session.ui.on("cue:set-backward-gesture", ({ gestureName }) => void bridge.setBackwardGesture(gestureName));
  session.ui.on("cue:test-cue", ({ cue }) => void feedback.play(cue));
  session.ui.on("cue:unlink", () => void bridge.unlink());
  session.ui.handle("cue:set-server", ({ url }) => bridge.setServerUrl(url));
  session.ui.handle("cue:link", ({ code }) => bridge.linkWithCode(code));
  session.ui.handle("cue:open-guest", () => bridge.openGuestHandoff());

  // One subscription to the bare `touch_event` stream: all gestures arrive, so
  // calibration can print them and the pipeline can ignore everything but one.
  session.input.onTouch((data) => void bridge.handleTouch(data));

  await bridge.start();
});
