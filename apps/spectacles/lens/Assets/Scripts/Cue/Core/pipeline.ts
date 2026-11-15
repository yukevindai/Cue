import type { SubmitResult } from "./api-client";
import { GESTURE, SOURCE } from "./config";
import { Debouncer } from "./double-pinch";
import type { ContextSnapshot } from "./encounter-context";
import { cueForAck, type FeedbackCue, type FeedbackSink } from "./feedback";
import { silentLogger, type Logger } from "./logger";
import type { InterestAck, InterestEvent } from "./wire";

/**
 * double pinch -> encounter gate -> debounce -> InterestEvent -> submit -> feedback.
 * Pure orchestration: every side effect is injected. Same shape as
 * apps/mentra/src/pipeline.ts, minus touch-event parsing (DoublePinchDetector
 * has already decided this was the gesture).
 */

export type IgnoreReason =
  | "unlinked"
  | "offline"
  | "context_stale"
  | "encounter_mode_off"
  | "debounced"
  | "submit_in_flight";

export type PipelineOutcome =
  | { kind: "ignored"; reason: IgnoreReason }
  | { kind: "submitted"; eventId: string; ack: InterestAck; cue: FeedbackCue }
  | { kind: "failed"; eventId: string; error: Exclude<SubmitResult, { ok: true }>["error"]; cue: FeedbackCue };

export interface PipelineDeps {
  context: () => ContextSnapshot;
  /** Sends the event; retries inside must reuse this exact event (same eventId). */
  submit: (event: InterestEvent) => Promise<SubmitResult>;
  feedback: FeedbackSink;
  newEventId: () => string;
  now?: () => number;
  logger?: Logger;
  debounceMs?: number;
}

const CONTEXT_IGNORE: Record<Exclude<ContextSnapshot["state"], "ready">, IgnoreReason> = {
  encounter_mode_off: "encounter_mode_off",
  unlinked: "unlinked",
  offline: "offline",
  stale: "context_stale",
};

export class InterestPipeline {
  private readonly debouncer: Debouncer;
  private readonly now: () => number;
  private readonly log: Logger;
  private inFlight = false;

  constructor(private readonly deps: PipelineDeps) {
    this.debouncer = new Debouncer(deps.debounceMs);
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? silentLogger;
  }

  /** Handle one recognised double pinch. Never throws. */
  async onDoublePinch(): Promise<PipelineOutcome> {
    const context = this.deps.context();
    if (context.state !== "ready") return this.ignore(CONTEXT_IGNORE[context.state]);
    if (this.inFlight) return this.ignore("submit_in_flight");
    if (!this.debouncer.tryAccept(this.now())) return this.ignore("debounced");

    // One fresh id per accepted gesture; the device clock stamps occurredAt
    // (informational only: the server's receipt time drives the match window).
    const event: InterestEvent = {
      eventId: this.deps.newEventId(),
      encounterSessionId: context.encounterSessionId,
      source: SOURCE,
      gesture: GESTURE,
      occurredAt: new Date(this.now()).toISOString(),
    };

    this.inFlight = true;
    let result: SubmitResult;
    try {
      result = await this.deps.submit(event);
    } catch {
      result = { ok: false, error: "network" };
    } finally {
      this.inFlight = false;
    }

    if (!result.ok) {
      // Dropped for good. The wearer must pinch again; nothing is kept for later.
      this.log.warn("interest not sent", { eventId: event.eventId, error: result.error });
      this.play("not_sent");
      return { kind: "failed", eventId: event.eventId, error: result.error, cue: "not_sent" };
    }

    const cue = cueForAck(result.ack);
    this.log.info("interest acknowledged", {
      eventId: event.eventId,
      status: result.ack.status,
      matched: result.ack.matched,
    });
    this.play(cue);
    return { kind: "submitted", eventId: event.eventId, ack: result.ack, cue };
  }

  private ignore(reason: IgnoreReason): PipelineOutcome {
    this.log.debug("gesture ignored", { reason });
    return { kind: "ignored", reason };
  }

  private play(cue: FeedbackCue): void {
    try {
      this.deps.feedback.play(cue);
    } catch (error) {
      this.log.warn("feedback failed", { cue, error });
    }
  }
}
