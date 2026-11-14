import "server-only";

/**
 * Per-user sliding window, in memory. Enough for the single Next server of the
 * MVP; a multi-instance deployment needs a shared store.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true, or returns false when the user is over the limit. */
  take(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(cutoff);
    return true;
  }

  private prune(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }
}

/** Any request to the route, cached or not. */
export const REQUESTS_PER_MINUTE = 30;
/** Requests that reach the model. */
export const MODEL_CALLS_PER_MINUTE = 6;
