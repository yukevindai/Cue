/**
 * Cue Lens entry point: the ONLY file that touches Lens Studio APIs.
 *
 * It adapts the Spectacles runtime to `CueHost` and hands everything else to
 * Core/ (plain TypeScript, unit-tested under Node in apps/spectacles/test):
 *   GestureModule pinch-downs  -> CueClient.onPinchDown (double-pinch detector)
 *   InternetModule.fetch       -> HttpTransport
 *   persistentStorageSystem    -> KeyValueStore (device token)
 *   TextInputSystem keyboard   -> requestPairingCode
 *   DelayedCallbackEvent       -> sleep
 *   Text + AudioComponent      -> FeedbackSink
 *
 * NOT VERIFIED ON REAL SPECTACLES. API names follow the Spectacles docs
 * (Gesture Module, Internet Access, Keyboard); see docs/spectacles-check.md.
 *
 * Setup in Lens Studio (5.3+, Spectacles project): put this script on a scene
 * object, set Server Url to the Cue web origin (https), and wire the inputs.
 */
import { CueClient, type CueHost } from "./Core/cue-client";
import { CUE_TEXT, type FeedbackCue, type FeedbackSink } from "./Core/feedback";
import { FEEDBACK_DISPLAY_MS } from "./Core/config";
import type { HttpRequest, HttpResponse } from "./Core/http";
import { createLogger } from "./Core/logger";
import type { KeyValueStore } from "./Core/account-link";

@component
export class CueLens extends BaseScriptComponent {
  @input
  @hint("Cue web origin, e.g. https://cue-gamma-five.vercel.app. Must be https for a published Lens.")
  serverUrl: string = "https://cue-gamma-five.vercel.app";

  @input
  @hint("Head-locked Text that shows the status line and cue messages (wearer only).")
  statusText: Text;

  @input
  @hint("AudioComponent used to play the three cues.")
  audio: AudioComponent;

  @input signalSentSound: AudioTrackAsset;
  @input matchSound: AudioTrackAsset;
  @input notSentSound: AudioTrackAsset;

  @input
  @hint("Development only: skip the keyboard and claim this pairing code on the first double pinch.")
  devPairingCode: string = "";

  @input
  @hint("Print debug lines (gesture ignored, context polls). Never prints the token.")
  verboseLogs: boolean = false;

  private readonly gestureModule: GestureModule = require("LensStudio:GestureModule");
  private readonly internetModule: InternetModule = require("LensStudio:InternetModule");
  private client: CueClient | null = null;
  private restingStatus = "";
  private feedbackToken = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("OnDestroyEvent").bind(() => this.client?.stop());
  }

  private onStart(): void {
    require("LensStudio:TextInputModule");
    const host: CueHost = {
      serverUrl: this.serverUrl,
      transport: (request) => this.httpFetch(request),
      sleep: (ms) => this.sleep(ms),
      store: this.storage(),
      feedback: this.feedbackSink(),
      requestPairingCode: () => this.requestPairingCode(),
      logger: createLogger((_level, line) => print(line), this.verboseLogs ? "debug" : "info"),
    };
    this.client = new CueClient(host);
    this.client.start();
    void this.client.run();
    this.listenForPinches();
  }

  private listenForPinches(): void {
    const hands: [GestureModule.HandType, "left" | "right"][] = [
      [GestureModule.HandType.Left, "left"],
      [GestureModule.HandType.Right, "right"],
    ];
    for (const [handType, hand] of hands) {
      this.gestureModule.getPinchDownEvent(handType).add((args: PinchDownArgs) => {
        void this.client?.onPinchDown({ hand, timestampMs: Date.now(), confidence: args.confidence });
      });
    }
  }

  private async httpFetch(request: HttpRequest): Promise<HttpResponse> {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method: request.method,
      headers: request.headers,
    };
    if (request.body !== null) init.body = request.body;
    const response = await this.internetModule.fetch(new Request(request.url, init));
    return { status: response.status, text: await response.text() };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const event = this.createEvent("DelayedCallbackEvent");
      event.bind(() => {
        resolve();
        this.removeEvent(event);
      });
      event.reset(ms / 1000);
    });
  }

  private storage(): KeyValueStore {
    const store = global.persistentStorageSystem.store;
    return {
      getString: (key) => (store.has(key) ? store.getString(key) : null),
      putString: (key, value) => store.putString(key, value),
      remove: (key) => store.remove(key),
    };
  }

  private feedbackSink(): FeedbackSink {
    const sounds: Record<FeedbackCue, AudioTrackAsset> = {
      signal_sent: this.signalSentSound,
      match: this.matchSound,
      not_sent: this.notSentSound,
    };
    return {
      play: (cue) => {
        const track = sounds[cue];
        if (this.audio && track) {
          this.audio.audioTrack = track;
          this.audio.play(1);
        }
        // Show the cue, then return to the resting status unless a newer cue arrived.
        const token = ++this.feedbackToken;
        this.setText(CUE_TEXT[cue]);
        void this.sleep(FEEDBACK_DISPLAY_MS).then(() => {
          if (token === this.feedbackToken) this.setText(this.restingStatus);
        });
      },
      status: (text) => {
        this.restingStatus = text;
        this.setText(text);
      },
    };
  }

  private setText(text: string): void {
    if (this.statusText) this.statusText.text = text;
  }

  /** System AR keyboard; resolves when the wearer presses return or closes it. */
  private requestPairingCode(): Promise<string | null> {
    if (this.devPairingCode.trim().length > 0) {
      const code = this.devPairingCode;
      this.devPairingCode = ""; // single use
      return Promise.resolve(code);
    }
    return new Promise((resolve) => {
      let typed = "";
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const options = new TextInputSystem.KeyboardOptions();
      options.enablePreview = true;
      options.keyboardType = TextInputSystem.KeyboardType.Text;
      options.returnKeyType = TextInputSystem.ReturnKeyType.Done;
      options.onTextChanged = (text: string) => {
        typed = text;
      };
      options.onReturnKeyPressed = () => finish(typed);
      options.onKeyboardStateChanged = (isOpen: boolean) => {
        if (!isOpen) finish(typed.length > 0 ? typed : null);
      };
      this.setText("Type the 6-character code from Cue on your phone");
      global.textInputSystem.requestKeyboard(options);
    });
  }
}
