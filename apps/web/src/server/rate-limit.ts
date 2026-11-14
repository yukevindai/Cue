import "server-only";

import { HttpError } from "@/server/http";

/**
 * Fixed-window in-memory limiter. Good enough for a single-process demo
 * server; a multi-instance deployment needs a shared store.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export function rateLimit(key: string, limit: number, windowMs: number): void {
  if (!hit(key, limit, windowMs)) throw new HttpError("rate_limited", "Too many requests");
}
