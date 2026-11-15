import { CONTEXT_MAX_AGE_MS } from "./config";
import type { DeviceContext } from "./wire";

/**
 * What the Lens currently knows about encounter mode. A double pinch is sent
 * only on `ready`. Every other state drops the gesture on the spot: nothing is
 * queued, so a gesture made while offline or while encounter mode is off can
 * never be replayed later (spec: "Do not replay offline interest").
 * Same semantics as apps/mentra/src/encounter-context.ts.
 */
export type ContextSnapshot =
  | { state: "ready" }
  | { state: "encounter_mode_off" }
  | { state: "no_place" }
  | { state: "unlinked" }
  | { state: "offline" }
  | { state: "stale" };

export type ContextFetchResult =
  | { ok: true; context: DeviceContext; reason?: undefined }
  | { ok: false; reason: "unlinked" | "offline"; context?: undefined };

/**
 * Holds the most recent GET /api/devices/me answer. The Lens calls `refresh()`
 * on a timer; the pipeline calls `snapshot()` per gesture. A failed refresh
 * takes effect immediately, and an answer older than `maxAgeMs` is stale.
 */
export class EncounterContextTracker {
  private last: { result: ContextFetchResult; at: number } | null = null;
  private generation = 0;

  constructor(
    private readonly fetchContext: () => Promise<ContextFetchResult>,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs: number = CONTEXT_MAX_AGE_MS,
  ) {}

  async refresh(): Promise<ContextSnapshot> {
    const generation = ++this.generation;
    let result: ContextFetchResult;
    try {
      result = await this.fetchContext();
    } catch {
      result = { ok: false, reason: "offline" };
    }
    // A slower, older request must not overwrite a newer answer.
    if (generation === this.generation) this.last = { result, at: this.now() };
    return this.snapshot();
  }

  /** Forget everything (after unlinking or re-pairing). */
  reset(): void {
    this.generation++;
    this.last = null;
  }

  snapshot(): ContextSnapshot {
    if (this.last === null) return { state: "stale" };
    const { result, at } = this.last;
    if (!result.ok) return { state: result.reason };
    if (this.now() - at > this.maxAgeMs) return { state: "stale" };
    const { encounterMode, ready } = result.context;
    if (!encounterMode) return { state: "encounter_mode_off" };
    // Encounter mode on, but the server does not know where the wearer is
    // (no venue check-in, no fresh phone location): a signal could not match.
    if (!ready) return { state: "no_place" };
    return { state: "ready" };
  }
}
