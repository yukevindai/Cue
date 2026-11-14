"use client";

import { useEffect, useState } from "react";

/**
 * Server-clock "now" in milliseconds, re-read every `intervalMs`.
 * `clockOffsetMs` comes from `useLive()`; countdowns must use the server clock
 * because expiry is decided by server receipt time, not this device's clock.
 */
export function useServerNow(clockOffsetMs: number, intervalMs: number): number {
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setLocalNow(Date.now());
    const id = window.setInterval(tick, intervalMs);
    // Timers are throttled in background tabs; catch up the moment we're back.
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);

  return localNow + clockOffsetMs;
}
