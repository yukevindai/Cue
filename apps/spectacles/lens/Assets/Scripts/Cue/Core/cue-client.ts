import { AccountLink, type KeyValueStore } from "./account-link";
import { CueApiClient } from "./api-client";
import { CONTEXT_REFRESH_INTERVAL_MS } from "./config";
import { DoublePinchDetector, type PinchDown } from "./double-pinch";
import { EncounterContextTracker, type ContextSnapshot } from "./encounter-context";
import { statusText, type FeedbackSink, type LinkState } from "./feedback";
import type { HttpTransport, Sleep } from "./http";
import { silentLogger, type Logger } from "./logger";
import { InterestPipeline, type PipelineOutcome } from "./pipeline";
import { uuidV4, type RandomBytes } from "./uuid";

/** Everything the Lens runtime provides. CueLens.ts implements it; tests fake it. */
export interface CueHost {
  serverUrl: string;
  transport: HttpTransport;
  sleep: Sleep;
  store: KeyValueStore;
  feedback: FeedbackSink;
  /** Opens the system keyboard; resolves with what the wearer typed, or null if dismissed. */
  requestPairingCode: () => Promise<string | null>;
  now?: () => number;
  random?: RandomBytes;
  logger?: Logger;
}

export type PinchOutcome =
  | { kind: "not_double" }
  | { kind: "pairing"; linked: boolean }
  | PipelineOutcome;

/**
 * The whole Lens behaviour, independent of Lens Studio:
 * - Not linked: a double pinch opens the keyboard for the pairing code.
 * - Linked: polls GET /api/devices/me; a double pinch while encounter mode is
 *   on sends one InterestEvent and plays the cue for the ack.
 * - Any unauthorized answer (device unlinked or revoked in the web app) clears
 *   the token and returns to the pairing state.
 */
export class CueClient {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly api: CueApiClient;
  private readonly account: AccountLink;
  private readonly context: EncounterContextTracker;
  private readonly detector = new DoublePinchDetector();
  private readonly pipeline: InterestPipeline;
  private linkState: LinkState = "unlinked";
  private lastStatus: string | null = null;
  private running = false;

  constructor(private readonly host: CueHost) {
    this.log = host.logger ?? silentLogger;
    this.now = host.now ?? Date.now;
    this.api = new CueApiClient({
      baseUrl: host.serverUrl,
      getToken: () => this.account.getToken(),
      transport: host.transport,
      sleep: host.sleep,
      now: this.now,
      logger: this.log,
    });
    this.account = new AccountLink(host.store, (code) => this.api.claimDevice(code), this.log);
    this.context = new EncounterContextTracker(() => this.api.getDeviceContext(), this.now);
    this.pipeline = new InterestPipeline({
      context: () => this.context.snapshot(),
      submit: async (event) => {
        const result = await this.api.submitInterest(event);
        if (!result.ok && result.error === "unauthorized") this.onUnauthorized();
        return result;
      },
      feedback: host.feedback,
      newEventId: () => uuidV4(host.random),
      now: this.now,
      logger: this.log,
    });
  }

  /** Load the stored token and show the first status line. Call once from onAwake. */
  start(): void {
    this.account.init();
    this.linkState = this.account.isLinked() ? "linked" : "unlinked";
    this.renderStatus();
  }

  /**
   * Poll loop. Runs until `stop()`. The Lens calls it once after `start()`;
   * tests drive `refreshOnce()` instead.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      await this.refreshOnce();
      await this.host.sleep(CONTEXT_REFRESH_INTERVAL_MS);
    }
  }

  stop(): void {
    this.running = false;
  }

  async refreshOnce(): Promise<ContextSnapshot> {
    if (this.linkState !== "linked") {
      this.renderStatus();
      return { state: "unlinked" };
    }
    const snapshot = await this.context.refresh();
    if (snapshot.state === "unlinked") this.onUnauthorized();
    this.renderStatus();
    return snapshot;
  }

  /** Feed every pinch-down from both hands. */
  async onPinchDown(pinch: PinchDown): Promise<PinchOutcome> {
    if (!this.detector.feed(pinch)) return { kind: "not_double" };
    if (this.linkState === "linking") return { kind: "pairing", linked: false };
    if (this.linkState === "unlinked") return { kind: "pairing", linked: await this.pair() };
    return this.pipeline.onDoublePinch();
  }

  /** Asks for a code, claims it, and starts polling with the new token. */
  async pair(): Promise<boolean> {
    if (this.linkState !== "unlinked") return this.linkState === "linked";
    const code = await this.host.requestPairingCode();
    if (code === null || code.trim().length === 0) return false;

    this.linkState = "linking";
    this.renderStatus();
    const result = await this.account.link(code);
    this.context.reset();
    this.linkState = result.ok ? "linked" : "unlinked";
    if (!result.ok) this.host.feedback.play("not_sent");
    await this.refreshOnce();
    return result.ok;
  }

  getLinkState(): LinkState {
    return this.linkState;
  }

  private onUnauthorized(): void {
    if (this.linkState !== "linked") return;
    this.account.unlink();
    this.context.reset();
    this.detector.reset();
    this.linkState = "unlinked";
  }

  private renderStatus(): void {
    const text = statusText(this.linkState, this.linkState === "linked" ? this.context.snapshot() : { state: "unlinked" });
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.host.feedback.status(text);
  }
}
