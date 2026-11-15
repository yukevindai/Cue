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
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

/** 3 ft in front of the wearer, in Lens Studio units (cm). */
const DIAMOND_DISTANCE_CM = 91.44;
const DIAMOND_SPIN_DEG_PER_SEC = 40;

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
  @allowUndefined
  @hint("3D object (e.g. a Box) that becomes the diamond. Pinch-tapping it sends the signal.")
  diamond: SceneObject;

  @input
  @allowUndefined
  @hint("Camera Object. The diamond is placed 3 ft in front of it when the Lens starts.")
  cameraObject: SceneObject;

  @input
  @allowUndefined
  @hint("Shown for a few seconds when there is a match (e.g. the Kevin, Ping-pong card). Start it disabled.")
  matchCard: SceneObject;

  @input
  @hint("How long the match card stays up, in seconds.")
  matchCardSeconds: number = 8;

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
  private matchCardToken = 0;

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
    if (this.matchCard) this.matchCard.enabled = false;
    this.ensureAudioListener();
    this.setUpDiamond();
  }

  /**
   * Adds an AudioListenerComponent to the camera if it has none (the Specs
   * Base Template camera has none). Lens docs say it is needed only for
   * spatial audio, but Spectacles developers report cues playing into silence
   * without one, so this is cheap insurance.
   */
  private ensureAudioListener(): void {
    if (!this.cameraObject) return;
    try {
      if (this.cameraObject.getComponent("Component.AudioListenerComponent") === null) {
        this.cameraObject.createComponent("Component.AudioListenerComponent");
      }
    } catch (e) {
      print(`Cue: could not add an audio listener: ${e}`);
    }
  }

  /** Builds the gem mesh, places it 3 ft ahead, spins it, and makes it tappable (SIK Interactable). */
  private setUpDiamond(): void {
    if (!this.diamond) return;
    const visual = this.diamond.getComponent("Component.RenderMeshVisual");
    if (visual) visual.mesh = buildDiamondMesh(6, 4, 8);
    const transform = this.diamond.getTransform();
    transform.setLocalScale(vec3.one());

    const collider = this.diamond.createComponent("Physics.ColliderComponent") as ColliderComponent;
    const shape = Shape.createSphereShape();
    shape.radius = 8;
    collider.shape = shape;

    const interactable = this.diamond.createComponent(Interactable.getTypeName()) as Interactable;
    interactable.onTriggerEnd.add(() => {
      void this.client?.onTap();
    });

    // Place once tracking has settled; world-locked after that, so the wearer can look around it.
    void this.sleep(500).then(() => this.placeDiamond());
    this.createEvent("UpdateEvent").bind(() => {
      const spin = quat.angleAxis(DIAMOND_SPIN_DEG_PER_SEC * MathUtils.DegToRad * getDeltaTime(), vec3.up());
      transform.setWorldRotation(spin.multiply(transform.getWorldRotation()));
    });
  }

  private placeDiamond(): void {
    if (!this.diamond || !this.cameraObject) return;
    const cam = this.cameraObject.getTransform();
    const ahead = cam.back; // a Lens Studio camera looks down its local -Z
    const flat = new vec3(ahead.x, 0, ahead.z);
    const dir = flat.length > 0.001 ? flat.normalize() : new vec3(0, 0, -1);
    this.diamond.getTransform().setWorldPosition(cam.getWorldPosition().add(dir.uniformScale(DIAMOND_DISTANCE_CM)));
  }

  private showMatchCard(): void {
    if (!this.matchCard) return;
    if (this.cameraObject) {
      // Card floats just above the diamond's line of sight, facing the wearer.
      const cam = this.cameraObject.getTransform();
      const pos = cam.getWorldPosition().add(cam.back.uniformScale(70)).add(vec3.up().uniformScale(8));
      const t = this.matchCard.getTransform();
      t.setWorldPosition(pos);
      t.setWorldRotation(cam.getWorldRotation());
    }
    this.matchCard.enabled = true;
    const token = ++this.matchCardToken;
    void this.sleep(this.matchCardSeconds * 1000).then(() => {
      if (token === this.matchCardToken && this.matchCard) this.matchCard.enabled = false;
    });
  }

  private listenForPinches(): void {
    const hands: [GestureModule.HandType, "left" | "right"][] = [
      [GestureModule.HandType.Left, "left"],
      [GestureModule.HandType.Right, "right"],
    ];
    for (const [handType, hand] of hands) {
      this.gestureModule.getPinchDownEvent(handType).add((args: PinchDownArgs) => {
        void this.client?.onPinchDown({ hand, timestampMs: Date.now(), confidence: (args as unknown as { confidence?: number }).confidence ?? 1 });
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
        if (cue === "match") this.showMatchCard();
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

/**
 * A brilliant-cut style gem: a ring of `sides` girdle points, a short crown
 * (top point) and a deeper pavilion (bottom point). Flat-shaded, so every
 * triangle gets its own three vertices and face normal.
 */
function buildDiamondMesh(radius: number, crown: number, pavilion: number, sides = 8): RenderMesh {
  const builder = new MeshBuilder([
    { name: "position", components: 3 },
    { name: "normal", components: 3, normalized: true },
  ]);
  builder.topology = MeshTopology.Triangles;
  builder.indexType = MeshIndexType.UInt16;
  const top = new vec3(0, crown, 0);
  const bottom = new vec3(0, -pavilion, 0);
  const ring: vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push(new vec3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  let index = 0;
  const tri = (a: vec3, b: vec3, c: vec3) => {
    const n = b.sub(a).cross(c.sub(a)).normalize();
    builder.appendVerticesInterleaved([a.x, a.y, a.z, n.x, n.y, n.z, b.x, b.y, b.z, n.x, n.y, n.z, c.x, c.y, c.z, n.x, n.y, n.z]);
    builder.appendIndices([index, index + 1, index + 2]);
    index += 3;
  };
  for (let i = 0; i < sides; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % sides];
    tri(top, b, a); // crown, counter-clockwise seen from outside
    tri(bottom, a, b); // pavilion
  }
  builder.updateMesh();
  return builder.getMesh();
}
