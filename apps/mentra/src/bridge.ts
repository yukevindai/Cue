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
import { GuestIntro, type TranscriptionSource } from "./guest-intro";
import { MatchAnnouncer } from "./match-hype";
import { GUEST_FAILURE_LINE, guestWelcomeLine } from "./speech";
import type { Logger } from "./logger";
import { GesturePipeline, type PipelineDeps, type PipelineOutcome } from "./pipeline";
import type { BridgeStatus, HandoffResponse, LinkResponse } from "./status";
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
  /** Speak a line through the glasses. Optional: without it nothing is spoken. */
  speak?(text: string): void | Promise<void>;
  /** The glasses' microphone as text. Undefined when unavailable or not permitted. */
  transcription?: TranscriptionSource;
  /** Open an https URL in the phone's browser. */
  openUrl?(url: string): void;
  sleep?: (ms: number) => Promise<void>;
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
  private guestName: string | null = null;
  private readonly guestIntro: GuestIntro;
  private readonly announcer: MatchAnnouncer;
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
    const speak = async (text: string) => {
      await host.speak?.(text);
    };
    this.guestIntro = new GuestIntro({
      source: host.transcription,
      create: async (intro) => {
        if (this.api === null) return { ok: false as const, error: "network" as const };
        const input: { intro: string; deviceLabel: string; mentraUserId?: string } = {
          intro,
          deviceLabel: DEVICE_LABEL,
        };
        const mentraUserId = host.mentraUserId();
        if (mentraUserId) input.mentraUserId = mentraUserId;
        return this.api.createGuestDevice(input);
      },
      onCreated: async (result) => {
        await this.link.adopt(result.deviceToken, result.deviceId);
        this.guestName = result.displayName;
        await this.persistGuestName(result.displayName);
        this.tracker.reset();
        await this.refresh();
        this.publish();
      },
      speak,
      welcomeLine: guestWelcomeLine,
      failureLine: GUEST_FAILURE_LINE,
      now: this.now,
      logger: host.logger,
    });
    this.announcer = new MatchAnnouncer({
      load: () => host.storage.get(STORAGE_KEYS.lastHypeMatch),
      save: (id) => host.storage.set(STORAGE_KEYS.lastHypeMatch, id),
      request: async (matchId) =>
        this.api === null ? { ok: false as const, error: "network" as const } : this.api.requestHype(matchId),
      speak,
      sleep: host.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      logger: host.logger,
    });
  }

  /** Resolves when a spoken match line in progress is done (tests). */
  settled(): Promise<void> {
    return this.announcer.settled();
  }

  /** The setup screen was opened: a failure cap from earlier is lifted. */
  screenOpened(): void {
    this.guestIntro.resetFailures();
  }

  /** Listening is on exactly while there is a server and no linked account. */
  private syncListening(): void {
    const before = this.guestIntro.listening;
    this.guestIntro.sync(this.serverUrl !== null && !this.link.isLinked());
    if (before !== this.guestIntro.listening) this.publish();
  }

  private async persistGuestName(name: string | null): Promise<void> {
    try {
      if (name === null) await this.host.storage.delete(STORAGE_KEYS.guestName);
      else await this.host.storage.set(STORAGE_KEYS.guestName, name);
    } catch {
      this.host.logger.warn("guest name not persisted");
    }
  }

  /** Asks the server for a one-time sign-in link for the guest account and opens it on the phone. */
  async openGuestHandoff(): Promise<HandoffResponse> {
    if (this.api === null || !this.link.isLinked()) return { ok: false, error: "These glasses are not linked." };
    const result = await this.api.requestGuestHandoff();
    if (!result.ok) {
      if (result.error === "not_guest") {
        this.guestName = null;
        await this.persistGuestName(null);
        this.publish();
        return { ok: false, error: "This is not a guest account. Open Cue in your browser and sign in." };
      }
      if (result.error === "unauthorized") {
        await this.dropRevokedToken();
        return { ok: false, error: "These glasses are no longer linked." };
      }
      return {
        ok: false,
        error: result.error === "network" ? "Could not reach the server." : "Could not open Cue. Try again.",
      };
    }
    const { path } = result.handoff;
    // The path is a one-time sign-in link: keep it out of every log.
    this.host.logger.addSecret(path);
    if (!path.startsWith("/") || path.startsWith("//") || this.serverUrl === null) {
      return { ok: false, error: "Unexpected server response." };
    }
    const url = `${this.serverUrl}${path}`;
    try {
      this.host.openUrl?.(url);
    } catch {
      this.host.logger.warn("could not open the browser");
    }
    return { ok: true, url };
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
    this.guestName = this.link.isLinked() ? await this.loadGuestName() : null;
    await this.announcer.init();
    this.host.logger.info("bridge started", {
      serverUrl: this.serverUrl,
      linked: this.link.isLinked(),
      backwardGestureName: this.pipelineDeps.mapping.backwardSwipeGestureName,
      calibration: this.pipelineDeps.calibration,
    });
    await this.refresh();
    this.syncListening();
    if (options.poll !== false) {
      this.timer = setInterval(() => void this.refresh(), CONTEXT_REFRESH_INTERVAL_MS);
    }
  }

  stop(): void {
    this.guestIntro.stop();
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
    this.announcer.observe(this.tracker.latestMatchId());
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
    this.syncListening();
    this.publish();
    return { ok: true };
  }

  async linkWithCode(code: string): Promise<LinkResponse> {
    if (this.api === null) return { ok: false, error: "Set the server URL first" };
    const result = await this.link.link(code);
    this.tracker.reset();
    if (result.ok) {
      this.guestName = null;
      await this.persistGuestName(null);
    }
    await this.refresh();
    this.syncListening();
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
    this.guestName = null;
    await this.persistGuestName(null);
    this.tracker.reset();
    await this.refresh();
    this.syncListening();
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
    // Choosing the gesture is the end of calibrating: leave calibration mode so
    // the next swipe is sent instead of only being listed.
    if (value !== null && this.pipelineDeps.calibration) {
      await this.setCalibration(false);
      return;
    }
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
      listening: this.guestIntro.listening,
      guestName: this.link.isLinked() ? this.guestName : null,
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
    this.guestName = null;
    await this.persistGuestName(null);
    this.syncListening();
    this.publish();
  }

  private async loadGuestName(): Promise<string | null> {
    try {
      const name = await this.host.storage.get(STORAGE_KEYS.guestName);
      return name !== null && name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }
}
