/**
 * Demo-only guest accounts are on unless CUE_GUESTS_ENABLED is "off", "false"
 * or "0" (any case). When off, every guest route and /g/[token] answers 404.
 * No `@/` imports so it can be unit-tested.
 */
export function guestsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.CUE_GUESTS_ENABLED?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

/** Per client address, for each guest route. */
export const GUEST_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;
/** Guest accounts created in any rolling 24 hours, counted from Supabase Auth. */
export const GUEST_DAILY_CAP = 300;
/**
 * Lifetime of a handoff link. Supabase decides it (Auth "Email OTP
 * Expiration", `[auth.email] otp_expiry` in supabase/config.toml, 3600 s by
 * default and locally); this only reports it to the caller.
 */
export const HANDOFF_TTL_SECONDS = 3600;
