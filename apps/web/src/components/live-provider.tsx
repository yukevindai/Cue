"use client";

import type { EncounterStatus, MatchCard, OwnProfile } from "@cue/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiRequestError, isApiError } from "@/lib/api";
import { armChime, playChime } from "@/lib/chime";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { MatchMoment } from "@/components/match-moment";
import { useLocationReporter } from "@/components/use-location-reporter";
import type { GeoState } from "@/lib/location";

/**
 * One provider for everything that changes underneath the user:
 * the encounter status, the match list, and the realtime connection.
 *
 * Realtime (docs/architecture.md): we subscribe to Postgres changes on
 * `matches`, `interest_events` (own rows only) and `chat_messages` (RLS: only
 * active matches we are in, for unread counts), and treat every event purely
 * as "something changed, refetch through the API". No row data from realtime
 * is ever rendered.
 *
 * A missed event must still show up, so the same refetch also runs when the
 * channel (re)subscribes, when the tab becomes visible or focused, when the
 * network comes back, and on a slow safety-net interval. While encounter mode
 * is on, the encounter status is also polled lightly so `ready` and the
 * location status stay current.
 *
 * It also runs the phone-location reporter for the whole signed-in app, so a
 * person on Matches or in a chat stays findable while encounter mode is on.
 */

export type RealtimeState = "connecting" | "live" | "reconnecting";

interface LiveValue {
  userId: string;
  email: string | null;

  /** `undefined` while loading, `null` when the account has no profile yet. */
  profile: OwnProfile | null | undefined;
  setProfile: (p: OwnProfile) => void;

  /** `null` until the first response arrives. */
  encounter: EncounterStatus | null;
  encounterError: ApiRequestError | null;
  /** Apply the `EncounterStatus` a mutation returned, without waiting for a refetch. */
  applyEncounter: (status: EncounterStatus) => void;
  refreshEncounter: () => Promise<void>;
  /** Milliseconds to add to `Date.now()` to get the server clock. */
  clockOffsetMs: number;

  /** `null` until the first response arrives. */
  matches: MatchCard[] | null;
  matchesError: ApiRequestError | null;
  refreshMatches: () => Promise<void>;
  /** Drop a match locally right after unmatch/block succeeds. */
  forgetMatch: (id: string) => void;

  realtime: RealtimeState;

  /** This page's own geolocation (permission, accuracy). Coordinates are never exposed. */
  geo: GeoState;
  /** Ask the browser for the location again, e.g. after the person changed a permission. */
  retryLocation: () => void;
}

const LiveContext = createContext<LiveValue | null>(null);

export function useLive(): LiveValue {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive must be used inside <LiveProvider>");
  return v;
}

/** Matches older than this are never announced, only listed. */
const MOMENT_MAX_AGE_MS = 10 * 60 * 1000;
const POLL_LIVE_MS = 20_000;
const POLL_DEGRADED_MS = 4_000;
/** Encounter status refresh while encounter mode is on. */
const POLL_ENCOUNTER_MS = 10_000;

function seenKey(userId: string) {
  return `cue.seen-matches.${userId}`;
}
function readSeen(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(seenKey(userId));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeSeen(userId: string, seen: Set<string>) {
  try {
    window.localStorage.setItem(seenKey(userId), JSON.stringify([...seen].slice(-200)));
  } catch {
    // storage unavailable: worst case a match is announced again after reload
  }
}

/**
 * Wraps an async loader so that concurrent calls share one request and a call
 * made while one is in flight triggers exactly one trailing run afterwards.
 */
function useCoalesced(run: () => Promise<void>): () => Promise<void> {
  const state = useRef<{ inFlight: Promise<void> | null; again: boolean }>({
    inFlight: null,
    again: false,
  });
  return useCallback(() => {
    const st = state.current;
    const start = (): Promise<void> => {
      st.inFlight = run().finally(() => {
        st.inFlight = null;
        if (st.again) {
          st.again = false;
          void start();
        }
      });
      return st.inFlight;
    };
    if (st.inFlight) {
      st.again = true;
      return st.inFlight;
    }
    return start();
  }, [run]);
}

export function LiveProvider({
  userId,
  email,
  children,
}: {
  userId: string;
  email: string | null;
  children: ReactNode;
}) {
  const [profile, setProfileState] = useState<OwnProfile | null | undefined>(undefined);
  const [encounter, setEncounter] = useState<EncounterStatus | null>(null);
  const [encounterError, setEncounterError] = useState<ApiRequestError | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [matches, setMatches] = useState<MatchCard[] | null>(null);
  const [matchesError, setMatchesError] = useState<ApiRequestError | null>(null);
  const [realtime, setRealtime] = useState<RealtimeState>("connecting");
  const [momentQueue, setMomentQueue] = useState<MatchCard[]>([]);

  // Bumped whenever encounter state is written, so a slower, older GET is dropped.
  const encounterSeq = useRef(0);
  const seen = useRef<Set<string> | null>(null);

  const onUnauthenticated = useCallback(() => {
    // Full navigation on purpose: server state must reset after sign-out.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/sign-in");
  }, []);

  const applyEncounter = useCallback((status: EncounterStatus) => {
    encounterSeq.current += 1;
    setEncounter(status);
    setEncounterError(null);
    setClockOffsetMs(new Date(status.serverTime).getTime() - Date.now());
  }, []);

  const ingestMatches = useCallback(
    (list: MatchCard[]) => {
      seen.current ??= readSeen(userId);
      const known = seen.current;
      const fresh: MatchCard[] = [];
      for (const m of list) {
        if (known.has(m.id)) continue;
        known.add(m.id);
        if (Date.now() - new Date(m.createdAt).getTime() <= MOMENT_MAX_AGE_MS) fresh.push(m);
      }
      writeSeen(userId, known);
      const liveIds = new Set(list.map((m) => m.id));
      setMatches(list);
      setMatchesError(null);
      // Queue new moments; drop any queued moment whose match no longer exists
      // (the other person unmatched, or the demo was reset).
      setMomentQueue((q) => {
        const kept = q.filter((m) => liveIds.has(m.id));
        const queued = new Set(kept.map((m) => m.id));
        const added = fresh.filter((m) => !queued.has(m.id));
        return added.length === 0 && kept.length === q.length ? q : [...kept, ...added];
      });
    },
    [userId],
  );

  const loadEncounter = useCallback(async () => {
    const seq = encounterSeq.current;
    try {
      const status = await api.getEncounter();
      if (seq !== encounterSeq.current) return; // a mutation landed meanwhile
      applyEncounter(status);
    } catch (err) {
      if (isApiError(err, "unauthenticated")) return onUnauthenticated();
      if (err instanceof ApiRequestError) setEncounterError(err);
    }
  }, [applyEncounter, onUnauthenticated]);
  const loadMatches = useCallback(async () => {
    try {
      const { matches: list } = await api.getMatches();
      ingestMatches(list);
    } catch (err) {
      if (isApiError(err, "unauthenticated")) return onUnauthenticated();
      if (err instanceof ApiRequestError) setMatchesError(err);
    }
  }, [ingestMatches, onUnauthenticated]);
  const refreshEncounter = useCoalesced(loadEncounter);
  const refreshMatches = useCoalesced(loadMatches);

  const refreshAll = useCallback(() => {
    void refreshMatches();
    void refreshEncounter();
  }, [refreshEncounter, refreshMatches]);

  // Profile: loaded once; the shell sends accounts without one to setup.
  useEffect(() => {
    let cancelled = false;
    api
      .getProfile()
      .then((p) => !cancelled && setProfileState(p))
      .catch((err) => {
        if (isApiError(err, "unauthenticated")) onUnauthenticated();
        // Leave `undefined` otherwise; the profile view has its own load + retry.
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthenticated]);

  // Realtime subscription. Every (re)subscribe refetches, which covers any
  // event missed while the socket was down.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    refreshAll();

    void (async () => {
      // Make sure the socket carries the user's JWT before joining, so RLS
      // lets our own rows through.
      const { data } = await supabase.auth.getSession();
      if (disposed) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (disposed) return;

      channel = supabase
        .channel(`cue-live-${userId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => {
          // A match appearing or ending also changes the pending signal.
          refreshAll();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, () => {
          // A new message changes unread counts and ordering in the match list.
          void refreshMatches();
        })
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "interest_events", filter: `user_id=eq.${userId}` },
          () => void refreshEncounter(),
        )
        .subscribe((status) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            setRealtime("live");
            refreshAll();
          } else {
            // CHANNEL_ERROR / TIMED_OUT / CLOSED: supabase-js rejoins on its
            // own; meanwhile the faster poll below keeps us honest.
            setRealtime("reconnecting");
          }
        });
    })();

    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") onUnauthenticated();
    });

    return () => {
      disposed = true;
      authSub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId, refreshAll, refreshEncounter, refreshMatches, onUnauthenticated]);

  // A backgrounded tab or a phone waking up: catch up immediately.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshAll);
    window.addEventListener("online", refreshAll);
    window.addEventListener("pageshow", refreshAll);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshAll);
      window.removeEventListener("online", refreshAll);
      window.removeEventListener("pageshow", refreshAll);
    };
  }, [refreshAll]);

  // Safety net: slow while realtime is healthy, quick while it is not.
  useEffect(() => {
    const every = realtime === "live" ? POLL_LIVE_MS : POLL_DEGRADED_MS;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, every);
    return () => window.clearInterval(id);
  }, [realtime, refreshAll]);

  // `ready` and the location status change with time (a location goes stale,
  // a check-in expires) and are not pushed, so look again now and then.
  const encounterMode = encounter?.encounterMode ?? false;
  useEffect(() => {
    if (!encounterMode) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshEncounter();
    }, POLL_ENCOUNTER_MS);
    return () => window.clearInterval(id);
  }, [encounterMode, refreshEncounter]);

  const { geo, retry: retryLocation } = useLocationReporter({
    enabled: encounterMode,
    onStatus: applyEncounter,
    onUnauthenticated,
    onOutOfDate: refreshEncounter,
  });

  // Browsers need one user gesture before they will play the match sound.
  useEffect(() => {
    const arm = () => armChime();
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("keydown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  // Sound once per match, when its moment reaches the front of the queue.
  const current = momentQueue[0] ?? null;
  const chimedFor = useRef<string | null>(null);
  useEffect(() => {
    if (current && chimedFor.current !== current.id) {
      chimedFor.current = current.id;
      playChime();
    }
  }, [current]);

  const dismissMoment = useCallback(() => setMomentQueue((q) => q.slice(1)), []);

  const forgetMatch = useCallback((id: string) => {
    setMatches((list) => (list ? list.filter((m) => m.id !== id) : list));
    setMomentQueue((q) => q.filter((m) => m.id !== id));
  }, []);

  const value = useMemo<LiveValue>(
    () => ({
      userId,
      email,
      profile,
      setProfile: setProfileState,
      encounter,
      encounterError,
      applyEncounter,
      refreshEncounter,
      clockOffsetMs,
      matches,
      matchesError,
      refreshMatches,
      forgetMatch,
      realtime,
      geo,
      retryLocation,
    }),
    [
      userId,
      email,
      profile,
      encounter,
      encounterError,
      applyEncounter,
      refreshEncounter,
      clockOffsetMs,
      matches,
      matchesError,
      refreshMatches,
      forgetMatch,
      realtime,
      geo,
      retryLocation,
    ],
  );

  return (
    <LiveContext.Provider value={value}>
      {children}
      {current ? <MatchMoment key={current.id} match={current} onDismiss={dismissMoment} /> : null}
    </LiveContext.Provider>
  );
}
