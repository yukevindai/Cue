import { InterestEvent, type InterestAck } from "@cue/contracts";
import type { ContextSnapshot } from "./encounter-context";
import { cueForAck, type FeedbackCue, type FeedbackSink } from "./feedback";
import { silentLogger, type Logger } from "./logger";
import { classifyGesture, Debouncer, normalizeTouchEvent, type GestureMapping } from "./touch-events";

/**
 * raw event -> normalize -> classify -> mode gate -> debounce -> InterestEvent
 * -> submit -> feedback. Pure orchestration: every side effect is injected.
 */

/** Result of sending one InterestEvent (including its retries, which reuse the same eventId). */
export type SubmitResult =
  | { ok: true; ack: InterestAck }
  | { ok: false; error: "network" | "unauthorized" | "server" | "invalid_response" };

export type IgnoreReason =
  | "malformed_event"
  | "calibration_mode"
  | "not_backward_swipe"
  | "unlinked"
  | "offline"
  | "context_stale"
  | "encounter_mode_off"
  | "no_place"
  | "debounced"
  | "submit_in_flight";

export type PipelineOutcome =
  | { kind: "ignored"; reason: IgnoreReason; gestureName: string | null }
  | { kind: "submitted"; eventId: string; ack: InterestAck; cue: FeedbackCue }
  | { kind: "failed"; eventId: string; error: Exclude<SubmitResult, { ok: true }>["error"]; cue: FeedbackCue };

export interface PipelineDeps {
  mapping: GestureMapping;
  /** Calibration mode prints every raw gesture name and never submits. */
  calibration: boolean;
  context: () => ContextSnapshot;
  /** Sends the event; retries inside must reuse this exact event (same eventId). */
  submit: (event: InterestEvent) => Promise<SubmitResult>;
  feedback: FeedbackSink;
  now?: () => number;
  newEventId?: () => string;
  logger?: Logger;
  debounceMs?: number;
}

const CONTEXT_IGNORE: Record<Exclude<ContextSnapshot["state"], "ready">, IgnoreReason> = {
  encounter_mode_off: "encounter_mode_off",
  no_place: "no_place",
  unlinked: "unlinked",
  offline: "offline",
  stale: "context_stale",
};

export class GesturePipeline {
  private readonly debouncer: Debouncer;
  private readonly now: () => number;
  private readonly newEventId: () => string;
  private readonly log: Logger;
  private inFlight = false;

  constructor(private readonly deps: PipelineDeps) {
    this.debouncer = new Debouncer(deps.debounceMs);
    this.now = deps.now ?? Date.now;
    this.newEventId = deps.newEventId ?? (() => crypto.randomUUID());
    this.log = deps.logger ?? silentLogger;
  }

  /** Feed one raw runtime touch payload. Never throws. */
  async handleRawEvent(input: unknown): Promise<PipelineOutcome> {
    const raw = normalizeTouchEvent(input);
    if (raw === null) return this.ignore("malformed_event", null);

    if (this.deps.calibration) {
      // Printed at info level so the person holding the glasses can read it.
      this.log.info(`CALIBRATION raw gesture: "${raw.gestureName}"`, {
        gestureName: raw.gestureName,
        timestampMs: raw.timestampMs,
        configuredBackward: this.deps.mapping.backwardSwipeGestureName,
      });
      return { kind: "ignored", reason: "calibration_mode", gestureName: raw.gestureName };
    }

    if (classifyGesture(raw, this.deps.mapping) !== "backward_swipe") {
      return this.ignore("not_backward_swipe", raw.gestureName);
    }

    const context = this.deps.context();
    if (context.state !== "ready") {
      const outcome = this.ignore(CONTEXT_IGNORE[context.state], raw.gestureName);
      // Tell the wearer why nothing was sent. Nothing is queued or replayed.
      if (context.state === "encounter_mode_off") await this.play("encounter_off");
      else if (context.state === "no_place") await this.play("no_place");
      return outcome;
    }

    if (this.inFlight) return this.ignore("submit_in_flight", raw.gestureName);
    if (!this.debouncer.tryAccept(this.now())) return this.ignore("debounced", raw.gestureName);

    // One fresh id per accepted gesture; the device clock stamps occurredAt.
    const event = InterestEvent.parse({
      eventId: this.newEventId(),
      source: "mentra_touch",
      gesture: "backward_swipe",
      occurredAt: new Date(this.now()).toISOString(),
    });

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
      // Dropped for good. The wearer must swipe again; nothing is kept for later.
      this.log.warn("interest not sent", { eventId: event.eventId, error: result.error });
      await this.play("not_sent");
      return { kind: "failed", eventId: event.eventId, error: result.error, cue: "not_sent" };
    }

    const cue = cueForAck(result.ack);
    this.log.info("interest acknowledged", {
      eventId: event.eventId,
      status: result.ack.status,
      matched: result.ack.matched,
      reason: result.ack.reason,
    });
    await this.play(cue);
    return { kind: "submitted", eventId: event.eventId, ack: result.ack, cue };
  }

  private ignore(reason: IgnoreReason, gestureName: string | null): PipelineOutcome {
    this.log.debug("gesture ignored", { reason, gestureName });
    return { kind: "ignored", reason, gestureName };
  }

  private async play(cue: FeedbackCue): Promise<void> {
    try {
      await this.deps.feedback.play(cue);
    } catch (error) {
      this.log.warn("feedback failed", { cue, error });
    }
  }
}
