"use client";

import { LOCATION_MAX_AGE_SECONDS, type EncounterStatus, type LocationInput } from "@cue/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, isApiError } from "@/lib/api";
import {
  geoErrorKind,
  LOCATION_CACHE_MS,
  LOCATION_MAX_RESEND_AGE_MS,
  LOCATION_REFRESH_AFTER_MS,
  LOCATION_TIMEOUT_MS,
  shouldReport,
  toLocationInput,
  type GeoState,
  type ReportState,
} from "@/lib/location";

/** How often the reporter looks at whether a report is due. */
const TICK_MS = 1_000;

function subscribeVisibility(fn: () => void) {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}
const isVisible = () => document.visibilityState === "visible";
const noopSubscribe = () => () => {};
const hasGeolocation = () => typeof navigator !== "undefined" && "geolocation" in navigator;

/** What the browser last told us: a position or an error. `null`: still waiting. */
type GeoReading = Extract<GeoState, { kind: "located" | "denied" | "unavailable" | "timeout" }>;

const emptyReport = (): ReportState => ({
  latest: null,
  lastSent: null,
  lastAttemptAtMs: null,
  inFlight: false,
});

/**
 * While `enabled` (encounter mode on) and this tab is visible, watches the
 * phone's position and reports it to the server: on a meaningful change (at
 * most every few seconds) and at least every LOCATION_REPORT_INTERVAL_MS, re-
 * sending the last known position so it never goes stale on the server while
 * the page is open. When `enabled` turns off it stops watching and tells the
 * server to forget the location.
 *
 * Mounted once for the signed-in app (in LiveProvider), so it keeps working on
 * Matches and in a chat, not only on Encounter.
 *
 * PRIVACY: coordinates live only in a ref here and in the request body. They
 * are never put in React state, storage or logs.
 */
export function useLocationReporter({
  enabled,
  onStatus,
  onUnauthenticated,
  onOutOfDate,
}: {
  enabled: boolean;
  /** The EncounterStatus a report returned. */
  onStatus: (status: EncounterStatus) => void;
  onUnauthenticated: () => void;
  /** The server disagreed with us (for example encounter mode is already off): refetch. */
  onOutOfDate: () => void;
}): { geo: GeoState; retry: () => void } {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => true);
  const supported = useSyncExternalStore(noopSubscribe, hasGeolocation, () => true);
  const [reading, setReading] = useState<GeoReading | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Encounter mode went off: forget what the browser told us (during render,
  // so the next "on" starts from "locating").
  const [readingFor, setReadingFor] = useState(enabled);
  if (readingFor !== enabled) {
    setReadingFor(enabled);
    if (!enabled) setReading(null);
  }

  const geo: GeoState = !enabled
    ? { kind: "off" }
    : !supported
      ? { kind: "unsupported" }
      : (reading ?? { kind: "locating" });

  const report = useRef<ReportState>(emptyReport());
  /** Bumped when reporting stops, so a late answer from before is ignored. */
  const generation = useRef(0);
  const fixAtMs = useRef<number | null>(null);
  const wasEnabled = useRef(false);
  const callbacks = useRef({ onStatus, onUnauthenticated, onOutOfDate });
  useEffect(() => {
    callbacks.current = { onStatus, onUnauthenticated, onOutOfDate };
  });

  const send = useCallback((input: LocationInput) => {
    const st = report.current;
    const gen = generation.current;
    const at = Date.now();
    st.inFlight = true;
    st.lastAttemptAtMs = at;
    api
      .reportLocation(input)
      .then((status) => {
        if (gen !== generation.current) return;
        st.lastSent = { input, atMs: at };
        callbacks.current.onStatus(status);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        if (isApiError(err, "unauthenticated")) callbacks.current.onUnauthenticated();
        else if (isApiError(err, "encounter_mode_off")) callbacks.current.onOutOfDate();
        else if (isApiError(err, "rate_limited")) st.lastSent = { input, atMs: at };
        // Anything else: try again on a later tick (never sooner than the minimum gap).
      })
      .finally(() => {
        if (gen === generation.current) st.inFlight = false;
      });
  }, []);

  const maybeSend = useCallback(() => {
    const st = report.current;
    const at = fixAtMs.current;
    if (at === null || Date.now() - at > LOCATION_MAX_RESEND_AGE_MS) return;
    if (st.latest && shouldReport(st, Date.now())) send(st.latest);
  }, [send]);

  // Turning encounter mode off: forget the location on the server too.
  useEffect(() => {
    if (enabled) {
      wasEnabled.current = true;
      return;
    }
    generation.current += 1;
    report.current = emptyReport();
    fixAtMs.current = null;
    if (wasEnabled.current) {
      wasEnabled.current = false;
      api
        .forgetLocation()
        .then((status) => callbacks.current.onStatus(status))
        .catch((err: unknown) => {
          if (isApiError(err, "unauthenticated")) callbacks.current.onUnauthenticated();
          // Otherwise the server drops it anyway: mode is off and it goes stale.
        });
    }
  }, [enabled]);

  // Watching: only while enabled and visible. A hidden tab stops watching; the
  // server lets the location go stale by itself.
  useEffect(() => {
    if (!enabled || !visible || !supported) return;
    const geolocation = navigator.geolocation;
    let disposed = false;
    let refreshing = false;
    // Back from a hidden tab: a position from before then is no longer worth sending.
    if (fixAtMs.current !== null && Date.now() - fixAtMs.current > LOCATION_MAX_AGE_SECONDS * 1000) {
      report.current.latest = null;
      fixAtMs.current = null;
    }

    const onPosition = (p: GeolocationPosition) => {
      if (disposed) return;
      const input = toLocationInput(p);
      if (!input) return;
      report.current.latest = input;
      fixAtMs.current = Date.now();
      const accuracyM = Math.round(input.accuracyM);
      setReading((prev) =>
        prev?.kind === "located" && prev.accuracyM === accuracyM
          ? prev
          : { kind: "located", accuracyM, fixAtMs: Date.now() },
      );
      maybeSend();
    };
    const onError = (e: GeolocationPositionError) => {
      if (disposed) return;
      const kind = geoErrorKind(e.code);
      // A watch can time out while the phone sits still; keep the position we have.
      if (kind !== "denied" && report.current.latest) return;
      if (kind === "denied") {
        report.current.latest = null;
        fixAtMs.current = null;
      }
      setReading({ kind });
    };

    const watchId = geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: LOCATION_CACHE_MS,
      timeout: LOCATION_TIMEOUT_MS,
    });

    const tick = window.setInterval(() => {
      maybeSend();
      // A phone that isn't moving may not get new watch callbacks: ask once in a while.
      const at = fixAtMs.current;
      if (at !== null && Date.now() - at > LOCATION_REFRESH_AFTER_MS && !refreshing) {
        refreshing = true;
        geolocation.getCurrentPosition(
          (p) => {
            refreshing = false;
            onPosition(p);
          },
          () => {
            refreshing = false;
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: LOCATION_TIMEOUT_MS },
        );
      }
    }, TICK_MS);

    return () => {
      disposed = true;
      geolocation.clearWatch(watchId);
      window.clearInterval(tick);
    };
  }, [enabled, visible, supported, attempt, maybeSend]);

  const retry = useCallback(() => {
    setReading(null);
    setAttempt((n) => n + 1);
  }, []);

  return { geo, retry };
}
