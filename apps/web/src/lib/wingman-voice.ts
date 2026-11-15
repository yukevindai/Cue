import type { DeviceStatus } from "@cue/contracts";

/**
 * The wingman's spoken line on a new match: whether to speak it, the per-
 * browser "Wingman voice" setting, and which matches this tab has already
 * announced.
 */

export const WINGMAN_VOICE_STORAGE_KEY = "socialeyes.wingman-voice";
export const ANNOUNCED_HYPE_STORAGE_KEY = "socialeyes.hype-announced";
/** Mentra glasses seen this recently speak the line themselves. */
export const GLASSES_RECENT_MS = 30_000;

export function parseVoicePref(raw: string | null): boolean {
  return raw !== "off";
}

/** True when linked Mentra glasses checked in within the last 30 s. */
export function glassesRecentlySeen(device: DeviceStatus | null | undefined, nowMs: number): boolean {
  if (!device?.linked || !device.lastSeenAt) return false;
  const seen = Date.parse(device.lastSeenAt);
  if (Number.isNaN(seen)) return false;
  return nowMs - seen < GLASSES_RECENT_MS;
}

/** Speak on this page only when the setting is on and the glasses' own app won't. */
export function shouldSpeakHype(opts: {
  voiceOn: boolean;
  device: DeviceStatus | null | undefined;
  nowMs: number;
}): boolean {
  return opts.voiceOn && !glassesRecentlySeen(opts.device, opts.nowMs);
}

export function parseAnnounced(raw: string | null): string[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/* ---------- Browser state (client only) ---------- */

let memoryPref: boolean | null = null;
const prefListeners = new Set<() => void>();

export function readVoicePref(): boolean {
  if (memoryPref === null) {
    try {
      memoryPref = parseVoicePref(window.localStorage.getItem(WINGMAN_VOICE_STORAGE_KEY));
    } catch {
      memoryPref = true;
    }
  }
  return memoryPref;
}

export function writeVoicePref(on: boolean): void {
  memoryPref = on;
  try {
    window.localStorage.setItem(WINGMAN_VOICE_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // storage unavailable: the setting lasts until the page reloads
  }
  for (const fn of prefListeners) fn();
}

export function subscribeVoicePref(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WINGMAN_VOICE_STORAGE_KEY) {
      memoryPref = parseVoicePref(e.newValue);
      fn();
    }
  };
  prefListeners.add(fn);
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function wasAnnounced(matchId: string): boolean {
  try {
    return parseAnnounced(window.sessionStorage.getItem(ANNOUNCED_HYPE_STORAGE_KEY)).includes(matchId);
  } catch {
    return false;
  }
}

export function markAnnounced(matchId: string): void {
  try {
    const list = parseAnnounced(window.sessionStorage.getItem(ANNOUNCED_HYPE_STORAGE_KEY));
    if (list.includes(matchId)) return;
    list.push(matchId);
    window.sessionStorage.setItem(ANNOUNCED_HYPE_STORAGE_KEY, JSON.stringify(list.slice(-100)));
  } catch {
    // storage unavailable: worst case the line is asked for again after a reload
  }
}
