import { parseIntroName } from "@cue/contracts";
import type { GuestCreateResult } from "./api-client";
import { silentLogger, type Logger } from "./logger";

/** A speech-to-text source (the glasses' microphone). `start` returns the stop function. */
export interface TranscriptionSource {
  start(onTranscript: (data: { text: string; isFinal: boolean }) => void): () => void;
}

export interface GuestIntroDeps {
  /** Undefined when the runtime has no transcription or the permission is missing. */
  source: TranscriptionSource | undefined;
  create(intro: string): Promise<GuestCreateResult>;
  /** Called with the created account; the caller stores the token and refreshes. */
  onCreated(result: Extract<GuestCreateResult, { ok: true }>["result"]): Promise<void>;
  /** Speak through the glasses. Must not throw. */
  speak(text: string): void | Promise<void>;
  welcomeLine(displayName: string): string;
  failureLine: string;
  now?: () => number;
  logger?: Logger;
}

/** At most one attempt per this long. */
export const GUEST_ATTEMPT_COOLDOWN_MS = 5000;
/** After this many failed attempts, stop until the screen is reopened. */
export const GUEST_MAX_FAILURES = 5;

/**
 * Always-on listening while the glasses are not linked: a FINAL transcript that
 * is a real introduction ("my name is Sam", "I'm Sam") creates a guest account.
 * Only that one transcript is sent, once, and nothing is kept; no transcript is
 * logged above debug level.
 */
export class GuestIntro {
  private stopFn: (() => void) | null = null;
  private inFlight = false;
  private lastAttemptAt: number | null = null;
  private failures = 0;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: GuestIntroDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? silentLogger;
  }

  get listening(): boolean {
    return this.stopFn !== null;
  }

  /** Start or stop listening to match `wanted`. Returns true when the state changed. */
  sync(wanted: boolean): boolean {
    if (wanted && this.stopFn === null) return this.start();
    if (!wanted && this.stopFn !== null) {
      this.stop();
      return true;
    }
    return false;
  }

  stop(): void {
    const stop = this.stopFn;
    this.stopFn = null;
    if (stop === null) return;
    try {
      stop();
    } catch {
      this.log.warn("could not stop listening");
    }
  }

  /** The setup screen was reopened: allow attempts again after the failure cap. */
  resetFailures(): void {
    this.failures = 0;
  }

  private start(): boolean {
    if (this.deps.source === undefined) return false;
    try {
      this.stopFn = this.deps.source.start((data) => void this.handle(data));
    } catch (error) {
      this.log.warn("could not start listening", { error });
      this.stopFn = null;
      return false;
    }
    this.log.info("listening for a spoken name");
    return true;
  }

  private async handle(data: { text: string; isFinal: boolean }): Promise<void> {
    if (!data.isFinal || this.stopFn === null) return;
    if (typeof data.text !== "string") return;
    this.log.debug("transcript", { text: data.text });
    const name = parseIntroName(data.text, { requireLeadIn: true });
    if (name === null) return;
    if (this.inFlight || this.failures >= GUEST_MAX_FAILURES) return;
    const now = this.now();
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < GUEST_ATTEMPT_COOLDOWN_MS) return;
    this.lastAttemptAt = now;
    this.inFlight = true;
    try {
      const result = await this.deps.create(data.text);
      if (result.ok) {
        // Linked by other means (listening stopped) while the request was in flight:
        // keep the existing account, drop this token.
        if (this.stopFn === null) {
          this.log.warn("guest created after listening stopped; ignored");
          return;
        }
        this.stop();
        await this.deps.onCreated(result.result);
        await this.say(this.deps.welcomeLine(result.result.displayName));
        return;
      }
      if (result.error === "no_name") return; // silent
      this.failures++;
      this.log.warn("guest create failed", { error: result.error, failures: this.failures });
      await this.say(this.deps.failureLine);
    } finally {
      this.inFlight = false;
    }
  }

  private async say(text: string): Promise<void> {
    try {
      await this.deps.speak(text);
    } catch (error) {
      this.log.warn("speech failed", { error });
    }
  }
}
