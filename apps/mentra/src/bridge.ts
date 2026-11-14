import { AccountLink, keyValueTokenStore } from "./account-link";
import { CueApiClient } from "./api-client";
import {
  BACKWARD_GESTURE_DISABLED,
  DEFAULT_BACKWARD_SWIPE_GESTURE_NAME,
  DEVICE_LABEL,
  normalizeServerUrl,
  STORAGE_KEYS,
} from "./config";
import { CONTEXT_REFRESH_INTERVAL_MS, EncounterContextTracker, type ContextFetchResult } from "./encounter-context";
import type { FeedbackSink } from "./feedback";
import type { Logger } from "./logger";
import { GesturePipeline, type PipelineDeps, type PipelineOutcome } from "./pipeline";
import type { BridgeStatus, LinkResponse } from "./status";
import { normalizeTouchEvent } from "./touch-events";

/**
 * Everything the bridge needs from its host, and nothing Mentra-specific.
 * `background/index.ts` adapts a MiniappSession to this; the injection harness
 * and the tests provide plain fakes.
 */
export interface BridgeHost {
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  feedback: FeedbackSink;
  logger: Logger;
  /** Wearer id reported by the Mentra runtime, if any. Unverified by Cue; a label only. */
  mentraUserId(): string | null;
  /** Called whenever the status shown in the phone UI may have changed. */
  onStatus?(status: BridgeStatus): void;
  fetch?: typeof fetch;
  /** Build-time default for the Cue web origin, if any. */
  defaultServerUrl?: string | null;
  now?: () => number;
}

const RECENT_GESTURES = 12;

export class CueBridge {
  private readonly link: AccountLink;
  private readonly tracker: EncounterContextTracker;
  private readonly pipeline: GesturePipeline;
  /** Held by reference by the pipeline; calibration and mapping are flipped here. */
  private readonly pipelineDeps: PipelineDeps;
  private api: CueApiClient | null = null;
  private serverUrl: string | null = null;
  private recent: BridgeStatus["recentGestures"] = [];
  private lastOutcome: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly host: BridgeHost) {
    this.now = host.now ?? Date.now;
    this.link = new AccountLink({
      store: keyValueTokenStore(
        {
          getItem: (k) => host.storage.get(k),
          setItem: (k, v) => host.storage.set(k, v),
          removeItem: (k) => host.storage.delete(k),
        },
        STORAGE_KEYS.deviceToken,
      ),
      claim: (input) =>
        this.api ? this.api.claimDevice(input) : Promise.resolve({ ok: false as const, error: "network" as const }),
      logger: host.logger,
      deviceLabel: DEVICE_LABEL,
      mentraUserId: () => host.mentraUserId(),
    });
    this.tracker = new EncounterContextTracker(() => this.fetchContext(), this.now);
    this.pipelineDeps = {
      mapping: { backwardSwipeGestureName: DEFAULT_BACKWARD_SWIPE_GESTURE_NAME },
      calibration: false,
      context: () => this.tracker.snapshot(),
      submit: async (event) => {
        if (this.api === null) return { ok: false as const, error: "network" as const };
        const result = await this.api.submitInterest(event);
        if (!result.ok && result.error === "unauthorized") {
          await this.dropRevokedToken();
          this.tracker.reset();
        }
        return result;
      },
      feedback: host.feedback,
      now: this.now,
      logger: host.logger,
    };
    this.pipeline = new GesturePipeline(this.pipelineDeps);
  }

  /** Load persisted settings and start keeping DeviceContext fresh. */
  async start(options: { poll?: boolean } = {}): Promise<void> {
    const { storage } = this.host;
    this.setServer(normalizeServerUrl(await storage.get(STORAGE_KEYS.serverUrl)) ?? normalizeServerUrl(this.host.defaultServerUrl));
    const storedGesture = await storage.get(STORAGE_KEYS.backwardGesture);
    if (storedGesture !== null && storedGesture.length > 0) {
      this.pipelineDeps.mapping.backwardSwipeGestureName =
        storedGesture === BACKWARD_GESTURE_DISABLED ? null : storedGesture;
    }
    this.pipelineDeps.calibration = (await storage.get(STORAGE_KEYS.calibration)) === "1";
    await this.link.init();
    this.host.logger.info("bridge started", {
      serverUrl: this.serverUrl,
      linked: this.link.isLinked(),
      backwardGestureName: this.pipelineDeps.mapping.backwardSwipeGestureName,
      calibration: this.pipelineDeps.calibration,
    });
    await this.refresh();
    if (options.poll !== false) {
      this.timer = setInterval(() => void this.refresh(), CONTEXT_REFRESH_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The SDK binding calls this for every touch-strip event, whatever the gesture. */
  async handleTouch(raw: unknown): Promise<PipelineOutcome> {
    const normalized = normalizeTouchEvent(raw);
    if (normalized !== null) {
      this.recent = [{ gestureName: normalized.gestureName, at: this.now() }, ...this.recent].slice(0, RECENT_GESTURES);
      this.publish();
    }
    const outcome = await this.pipeline.handleRawEvent(raw);
    if (outcome.kind !== "ignored" || outcome.reason !== "not_backward_swipe") {
      this.lastOutcome =
        outcome.kind === "ignored"
          ? `ignored: ${outcome.reason}`
          : outcome.kind === "failed"
            ? `failed: ${outcome.error}`
            : `submitted: ${outcome.ack.status}${outcome.ack.matched ? " (match)" : ""}`;
      this.publish();
    }
    return outcome;
  }

  async refresh(): Promise<void> {
    const before = this.tracker.snapshot().state;
    const after = (await this.tracker.refresh()).state;
    if (before !== after) {
      this.host.logger.info("encounter context", { state: after });
      this.publish();
    }
  }

  async setServerUrl(url: string): Promise<LinkResponse> {
    const normalized = normalizeServerUrl(url);
    if (normalized === null) return { ok: false, error: "Enter the web app origin, e.g. https://cue.example.com" };
    await this.host.storage.set(STORAGE_KEYS.serverUrl, normalized);
    this.setServer(normalized);
    await this.refresh();
    this.publish();
    return { ok: true };
  }

  async linkWithCode(code: string): Promise<LinkResponse> {
    if (this.api === null) return { ok: false, error: "Set the server URL first" };
    const result = await this.link.link(code);
    this.tracker.reset();
    await this.refresh();
    this.publish();
    if (result.ok) return { ok: true };
    const messages: Record<typeof result.error, string> = {
      invalid_code: "Code not accepted. Get a fresh code in the web app.",
      network: "Could not reach the server.",
      server: "Server error. Try again.",
      invalid_response: "Unexpected server response.",
    };
    return { ok: false, error: messages[result.error] };
  }

  async unlink(): Promise<void> {
    await this.link.unlink();
    this.tracker.reset();
    await this.refresh();
    this.publish();
  }

  async setCalibration(on: boolean): Promise<void> {
    this.pipelineDeps.calibration = on;
    await this.host.storage.set(STORAGE_KEYS.calibration, on ? "1" : "0");
    this.host.logger.info(`calibration mode ${on ? "ON: gestures are printed, nothing is submitted" : "OFF"}`);
    this.publish();
  }

  async setBackwardGesture(gestureName: string | null): Promise<void> {
    const value = gestureName !== null && gestureName.trim().length > 0 ? gestureName.trim() : null;
    this.pipelineDeps.mapping.backwardSwipeGestureName = value;
    await this.host.storage.set(STORAGE_KEYS.backwardGesture, value ?? BACKWARD_GESTURE_DISABLED);
    this.host.logger.info("backward swipe mapping changed", { backwardGestureName: value });
    this.publish();
  }

  status(): BridgeStatus {
    return {
      serverUrl: this.serverUrl,
      linked: this.link.isLinked(),
      context: this.tracker.snapshot().state,
      calibration: this.pipelineDeps.calibration,
      backwardGestureName: this.pipelineDeps.mapping.backwardSwipeGestureName,
      mentraUserId: this.host.mentraUserId(),
      recentGestures: this.recent,
      lastOutcome: this.lastOutcome,
    };
  }

  publish(): void {
    try {
      this.host.onStatus?.(this.status());
    } catch {
      /* the UI is optional */
    }
  }

  private setServer(url: string | null): void {
    this.serverUrl = url;
    this.api =
      url === null
        ? null
        : new CueApiClient({
            baseUrl: url,
            getToken: () => this.link.getToken(),
            fetch: this.host.fetch,
            logger: this.host.logger,
          });
    this.tracker.reset();
  }

  private async fetchContext(): Promise<ContextFetchResult> {
    if (!this.link.isLinked()) return { ok: false, reason: "unlinked" };
    if (this.api === null) return { ok: false, reason: "offline" };
    const result = await this.api.getDeviceContext();
    // The server no longer accepts the token (unlinked from the web app, or
    // replaced by another device): forget it so the UI asks to pair again.
    if (!result.ok && result.reason === "unlinked") await this.dropRevokedToken();
    return result;
  }

  private async dropRevokedToken(): Promise<void> {
    if (!this.link.isLinked()) return;
    this.host.logger.warn("device token rejected by the server; pair again");
    await this.link.unlink();
    this.publish();
  }
}
