import type { HypeLine } from "@cue/contracts";
import type { HypeResult } from "./api-client";
import { silentLogger, type Logger } from "./logger";

export interface MatchAnnouncerDeps {
  load(): Promise<string | null>;
  save(matchId: string): Promise<void>;
  request(matchId: string): Promise<HypeResult>;
  speak(text: string): void | Promise<void>;
  sleep(ms: number): Promise<void>;
  logger?: Logger;
}

/** Gives a cue (the swipe acknowledgement) time to finish before the line is spoken. */
export const HYPE_SPEAK_DELAY_MS = 1200;

/**
 * Speaks the wingman line once per match. The id is remembered (and persisted)
 * before the request, so a repeat poll, a restart or a failed request can never
 * make it speak the same match twice. A failed request is tried once more, then
 * dropped without a word.
 */
export class MatchAnnouncer {
  private announced: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly log: Logger;

  constructor(private readonly deps: MatchAnnouncerDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  async init(): Promise<void> {
    try {
      this.announced = await this.deps.load();
    } catch {
      this.announced = null;
    }
  }

  /** Resolves when any announcement in progress has finished (tests, shutdown). */
  settled(): Promise<void> {
    return this.pending;
  }

  /** Feed the latest `DeviceContext.latestMatchId` on every poll. */
  observe(matchId: string | null): void {
    if (matchId === null || matchId === this.announced) return;
    this.announced = matchId; // synchronously, before any await
    this.pending = this.pending.then(() => this.announce(matchId));
  }

  private async announce(matchId: string): Promise<void> {
    try {
      await this.deps.save(matchId);
    } catch {
      this.log.warn("could not remember the announced match");
    }
    const lineTask = this.fetchLine(matchId);
    const [line] = await Promise.all([lineTask, this.deps.sleep(HYPE_SPEAK_DELAY_MS)]);
    if (line === null) return;
    try {
      await this.deps.speak(line.text);
    } catch (error) {
      this.log.warn("speech failed", { error });
    }
  }

  private async fetchLine(matchId: string): Promise<HypeLine | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.deps.request(matchId).catch((): HypeResult => ({ ok: false, error: "network" }));
      if (result.ok) {
        // A line for some other match must never be spoken for this one.
        return result.line.matchId === matchId ? result.line : null;
      }
      this.log.debug("hype request failed", { attempt, error: result.error });
      if (result.error === "unauthorized") return null;
    }
    return null;
  }
}
