import {
  LOCATION_MAX_ACCURACY_M,
  LOCATION_MAX_AGE_SECONDS,
  LOCATION_REPORT_INTERVAL_MS,
  LOCATION_RETENTION_MINUTES,
  type LocationInput,
} from "@cue/contracts";

/**
 * Pure parts of phone-location reporting. The hook in
 * `components/use-location-reporter.ts` owns the browser watch, the timer and
 * the network calls.
 *
 * PRIVACY: coordinates only ever travel from the browser's geolocation to
 * POST /api/encounter/location. They are kept in memory while Encounter mode
 * is on and never written to storage, logs or the page.
 */

/** Never report more often than this, however much the position changes. */
export const LOCATION_MIN_GAP_MS = 3_000;
/** A move at least this far is worth an early report. */
export const LOCATION_MOVE_M = 10;
/** Give up waiting for a first position after this long (the browser keeps trying). */
export const LOCATION_TIMEOUT_MS = 20_000;
/** A cached position up to this old is fine for the watch. */
export const LOCATION_CACHE_MS = 10_000;

/** Where the browser's own location stands, as far as this page knows. */
export type GeoState =
  /** Encounter mode is off, or the page isn't watching. */
  | { kind: "off" }
  /** This browser has no geolocation (or the page isn't served securely). */
  | { kind: "unsupported" }
  /** Asked, waiting for the permission answer or a first position. */
  | { kind: "locating" }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  /** We have a position. */
  | { kind: "located"; accuracyM: number; fixAtMs: number };

export type GeoErrorKind = "denied" | "unavailable" | "timeout";

/** GeolocationPositionError.code -> kind (1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT). */
export function geoErrorKind(code: number): GeoErrorKind {
  if (code === 1) return "denied";
  if (code === 3) return "timeout";
  return "unavailable";
}

/** Minimal shape of a browser `GeolocationPosition`, so tests need no DOM. */
export interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number };
  timestamp: number;
}

/** Body for POST /api/encounter/location, or `null` for a position the contract would refuse. */
export function toLocationInput(p: PositionLike): LocationInput | null {
  const { latitude: lat, longitude: lng, accuracy } = p.coords;
  if (![lat, lng, accuracy].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracy < 0) return null;
  return { lat, lng, accuracyM: Math.min(accuracy, 1_000_000) };
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface ReportState {
  /** The newest position from the browser. */
  latest: LocationInput | null;
  /** What we last sent successfully, and when (ms, local clock). */
  lastSent: { input: LocationInput; atMs: number } | null;
  /** When we last tried to send, successful or not. */
  lastAttemptAtMs: number | null;
  inFlight: boolean;
}

/** Changed enough to tell the server before the regular interval. */
export function meaningfullyChanged(prev: LocationInput, next: LocationInput): boolean {
  if (distanceM(prev, next) >= LOCATION_MOVE_M) return true;
  const usable = (x: LocationInput) => x.accuracyM <= LOCATION_MAX_ACCURACY_M;
  if (usable(prev) !== usable(next)) return true;
  return Math.abs(prev.accuracyM - next.accuracyM) >= Math.max(10, prev.accuracyM * 0.25);
}

/**
 * Whether to POST the latest position now:
 * - right away for the first position;
 * - at least every LOCATION_REPORT_INTERVAL_MS while a position is known, even
 *   unchanged, because the server stops using a location after
 *   LOCATION_MAX_AGE_SECONDS;
 * - earlier when it changed meaningfully, but never within LOCATION_MIN_GAP_MS
 *   of the last attempt.
 */
export function shouldReport(s: ReportState, nowMs: number): boolean {
  if (!s.latest || s.inFlight) return false;
  if (s.lastAttemptAtMs !== null && nowMs - s.lastAttemptAtMs < LOCATION_MIN_GAP_MS) return false;
  if (!s.lastSent) return true;
  if (nowMs - s.lastSent.atMs >= LOCATION_REPORT_INTERVAL_MS) return true;
  return meaningfullyChanged(s.lastSent.input, s.latest);
}

/**
 * Stop re-sending a position the browser hasn't confirmed for this long (it
 * keeps being asked meanwhile). Matches how long the server keeps one.
 */
export const LOCATION_MAX_RESEND_AGE_MS = LOCATION_RETENTION_MINUTES * 60_000;

/** Ask the browser for a new position when the one we hold is older than this. */
export const LOCATION_REFRESH_AFTER_MS = (LOCATION_MAX_AGE_SECONDS * 1000) / 2;

/**
 * What this page's own geolocation says, in words. `null` when the server's
 * status says it better (we have a position, or nothing has been asked yet).
 */
export function geoProblemText(geo: GeoState): string | null {
  switch (geo.kind) {
    case "unsupported":
      return "This browser can't share its location with Cue. Check in with a venue code instead.";
    case "locating":
      return "Finding your location…";
    case "denied":
      return "Location is blocked for Cue in this browser. You can still check in with a venue code, or allow location in your browser's settings and try again.";
    case "unavailable":
      return "Your phone couldn't work out where it is. Check in with a venue code, or try again outside or near a window.";
    case "timeout":
      return "Your phone took too long to find its location. Try again, or check in with a venue code.";
    case "off":
    case "located":
      return null;
  }
}

export interface LocationLine {
  text: string;
  /** Offer "Try location again". */
  retry: boolean;
}

/**
 * The one location line on the Encounter page, combining this page's own
 * geolocation (permission, errors) with the server's status (fresh, stale,
 * inaccurate). Never shows coordinates.
 */
export function locationLine(
  encounterMode: boolean,
  geo: GeoState,
  serverText: string | null,
): LocationLine {
  if (!encounterMode) {
    return { text: "Location off. Cue only uses it while Encounter mode is on.", retry: false };
  }
  if (geo.kind === "unsupported" || geo.kind === "denied" || geo.kind === "unavailable" || geo.kind === "timeout") {
    return { text: geoProblemText(geo) ?? "", retry: geo.kind !== "unsupported" };
  }
  if (geo.kind === "located" && geo.accuracyM > LOCATION_MAX_ACCURACY_M && !serverText?.startsWith("Location too rough")) {
    return {
      text: `Location too rough to use: about ${geo.accuracyM} m. Cue needs ${LOCATION_MAX_ACCURACY_M} m or better.`,
      retry: false,
    };
  }
  if (serverText) return { text: serverText, retry: false };
  if (geo.kind === "located") return { text: "Location found. Sending it to Cue…", retry: false };
  return { text: geoProblemText({ kind: "locating" }) ?? "", retry: false };
}
