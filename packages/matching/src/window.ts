import { MATCH_WINDOW_SECONDS } from "@cue/contracts";

/** A signal's deadline: server receipt time plus the match window. */
export function expiresAt(receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + MATCH_WINDOW_SECONDS * 1000);
}

/** Alive only while expiresAt > now; expired at exactly expiresAt (SQL: `expires_at <= now`). */
export function isExpired(signal: { expiresAt: Date }, now: Date): boolean {
  return signal.expiresAt.getTime() <= now.getTime();
}
