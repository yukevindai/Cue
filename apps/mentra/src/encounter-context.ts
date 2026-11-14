import type { DeviceContext } from "@cue/contracts";

/**
 * What the device currently knows about encounter mode. A swipe is forwarded
 * only on `ready`. Every other state drops the swipe on the spot: nothing is
 * queued, so a swipe made while offline or while encounter mode is off can
 * never be replayed later (spec section 3: "Do not replay offline interest").
 */
export type ContextSnapshot =
  | { state: "ready"; encounterSessionId: string }
  | { state: "encounter_mode_off" }
  | { state: "unlinked" }
  | { state: "offline" }
  | { state: "stale" };

export type ContextFetchResult =
  | { ok: true; context: DeviceContext }
  | { ok: false; reason: "unlinked" | "offline" };

/** How long a fetched DeviceContext may be used. The refresh interval must be well below this. */
export const CONTEXT_MAX_AGE_MS = 6000;
export const CONTEXT_REFRESH_INTERVAL_MS = 2000;

/**
 * Holds the most recent `GET /api/devices/me` result. The runtime calls
 * `refresh()` on a timer; the pipeline calls `snapshot()` per gesture.
 * A failed refresh takes effect immediately (no grace period).
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
    const { encounterMode, encounterSessionId } = result.context;
    if (!encounterMode || encounterSessionId === null) return { state: "encounter_mode_off" };
    return { state: "ready", encounterSessionId };
  }
}
