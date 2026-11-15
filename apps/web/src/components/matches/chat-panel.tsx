"use client";

import Link from "next/link";
import { ARCHETYPES, CHAT_MESSAGE_MAX_LENGTH, type ChatMessage, type MatchCard } from "@cue/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, describeError, isApiError } from "@/lib/api";
import { buildTimeline, canSend, mergeMessages, timeLabel, type OutgoingMessage, type TimelineEntry } from "@/lib/chat";
import { chatDraft, withOpener } from "@/lib/chat-draft";
import { cx } from "@/lib/cx";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { useLive } from "@/components/live-provider";
import { Avatar, Button, Loading, Notice, Spinner } from "@/components/ui";
import { BackLink, Gone, MatchFallback, StepAway, useMatch } from "./match-common";

/** Poll while the chat is open: slow while realtime is healthy, quick while it is not. */
const POLL_LIVE_MS = 15_000;
const POLL_DEGRADED_MS = 4_000;
/** Within this many pixels of the bottom counts as "reading the newest". */
const NEAR_BOTTOM_PX = 140;

export function ChatView({ id }: { id: string }) {
  const m = useMatch(id);
  if (m.leaving || m.gone || !m.card) return <MatchFallback m={m} back={{ href: `/matches/${id}`, label: "Match" }} />;
  return (
    <ChatPanel
      key={m.card.id}
      match={m.card}
      onGone={m.markGone}
      onLeaving={() => m.setLeaving(true)}
      onLeaveFailed={() => m.setLeaving(false)}
    />
  );
}

function nearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
}
function scrollToBottom(smooth = false) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
}

/**
 * The conversation with one match. Messages are plain text, rendered as text
 * nodes only: no links, no markup, line breaks kept. Realtime events only mean
 * "something changed": the panel refetches through the API and never renders
 * a realtime row.
 */
export function ChatPanel({
  match,
  onGone,
  onLeaving,
  onLeaveFailed,
}: {
  match: MatchCard;
  onGone: () => void;
  onLeaving: () => void;
  onLeaveFailed: () => void;
}) {
  const matchId = match.id;
  const name = match.other.displayName;
  const character = match.other.archetype ? ARCHETYPES[match.other.archetype] : null;
  const { refreshMatches } = useLive();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutgoingMessage[]>([]);
  const [gone, setGone] = useState(false);
  const [live, setLive] = useState(false);
  const [unseenBelow, setUnseenBelow] = useState(false);

  const pagedOlder = useRef(false);
  const stick = useRef(true);
  const prependFrom = useRef<number | null>(null);

  const markGone = useCallback(() => {
    setGone(true);
    onGone();
  }, [onGone]);

  // ---- Fetch the newest page (coalesced: one in flight, at most one queued) ----
  const fetchState = useRef<{ inFlight: boolean; again: boolean }>({ inFlight: false, again: false });
  const fetchNewest = useCallback(async () => {
    const st = fetchState.current;
    if (st.inFlight) {
      st.again = true;
      return;
    }
    st.inFlight = true;
    try {
      do {
        st.again = false;
        try {
          const page = await api.listMessages(matchId);
          stick.current = stick.current || nearBottom();
          setMessages((prev) => {
            const next = mergeMessages(prev, page.messages);
            if (!stick.current && next.length > prev.length && next[next.length - 1]?.mine === false) {
              setUnseenBelow(true);
            }
            return next;
          });
          if (!pagedOlder.current) setOlderCursor(page.olderCursor);
          setLoaded(true);
          setLoadError(null);
          // The newest page marks the conversation read; let the badges catch up.
          void refreshMatches();
        } catch (err) {
          if (isApiError(err, "not_found") || isApiError(err, "forbidden")) {
            markGone();
            return;
          }
          setLoadError(describeError(err));
        }
      } while (st.again);
    } finally {
      st.inFlight = false;
    }
  }, [matchId, markGone, refreshMatches]);

  // ---- Realtime: any change on this match's messages means "refetch" ----
  useEffect(() => {
    const supabase = getBrowserSupabase();
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    void fetchNewest();
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (disposed) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (disposed) return;
      channel = supabase
        .channel(`cue-chat-${matchId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "chat_messages", filter: `match_id=eq.${matchId}` },
          () => void fetchNewest(),
        )
        .subscribe((status) => {
          if (disposed) return;
          if (status === "SUBSCRIBED") {
            setLive(true);
            void fetchNewest();
          } else {
            setLive(false);
          }
        });
    })();
    return () => {
      disposed = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [matchId, fetchNewest]);

  // ---- Catch up when the tab comes back, and poll as a safety net ----
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchNewest();
    };
    const onFocus = () => void fetchNewest();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [fetchNewest]);
  useEffect(() => {
    const id = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void fetchNewest();
      },
      live ? POLL_LIVE_MS : POLL_DEGRADED_MS,
    );
    return () => window.clearInterval(id);
  }, [live, fetchNewest]);

  // ---- Scrolling: follow the newest unless the person scrolled up ----
  useEffect(() => {
    const onScroll = () => {
      stick.current = nearBottom();
      if (stick.current) setUnseenBelow(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const timeline = useMemo(() => buildTimeline(messages, outbox), [messages, outbox]);
  useLayoutEffect(() => {
    if (prependFrom.current !== null) {
      // Keep the message the person was looking at in place after older ones load above it.
      window.scrollBy(0, document.documentElement.scrollHeight - prependFrom.current);
      prependFrom.current = null;
      return;
    }
    if (stick.current) scrollToBottom();
  }, [timeline]);

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.listMessages(matchId, { before: olderCursor });
      pagedOlder.current = true;
      prependFrom.current = document.documentElement.scrollHeight;
      stick.current = false;
      setMessages((prev) => mergeMessages(prev, page.messages));
      setOlderCursor(page.olderCursor);
    } catch (err) {
      if (isApiError(err, "not_found") || isApiError(err, "forbidden")) markGone();
      else setOlderError(describeError(err));
    } finally {
      setLoadingOlder(false);
    }
  }

  // ---- Sending: optimistic, idempotent retry with the same clientId ----
  async function deliver(o: OutgoingMessage) {
    setOutbox((box) => box.map((x) => (x.clientId === o.clientId ? { ...x, status: "sending", error: undefined } : x)));
    try {
      const sent = await api.sendMessage(matchId, { clientId: o.clientId, body: o.body });
      setMessages((prev) => mergeMessages(prev, [sent]));
      setOutbox((box) => box.filter((x) => x.clientId !== o.clientId));
    } catch (err) {
      if (isApiError(err, "not_found") || isApiError(err, "forbidden")) {
        markGone();
        return;
      }
      const error = isApiError(err, "rate_limited")
        ? "Slow down a little. Wait a moment, then try again."
        : isApiError(err, "invalid_request")
          ? err.message || describeError(err)
          : describeError(err);
      setOutbox((box) => box.map((x) => (x.clientId === o.clientId ? { ...x, status: "failed", error } : x)));
    }
  }

  function send(body: string) {
    const o: OutgoingMessage = {
      clientId: crypto.randomUUID(),
      body: body.trim(),
      createdAt: new Date().toISOString(),
      status: "sending",
    };
    stick.current = true;
    setUnseenBelow(false);
    setOutbox((box) => [...box, o]);
    void deliver(o);
  }

  if (gone) return <Gone />;

  const empty = loaded && messages.length === 0 && outbox.length === 0;

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem-2rem)] flex-col sm:min-h-[calc(100dvh-3.5rem-6.5rem)]">
      <header className="pb-4">
        <BackLink href={`/matches/${matchId}`}>{`${name}'s card`}</BackLink>
        <div className="flex items-center gap-3">
          <Avatar name={name} src={match.other.photoUrl} size={52} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-3xl leading-tight tracking-tight break-words">{name}</h1>
            {character ? <p className="font-display text-lg italic leading-snug text-ink-soft">{character.name}</p> : null}
          </div>
        </div>
        <div className="mt-4 flex gap-2.5 rounded-2xl border border-line bg-sunk px-4 py-3 text-[0.95rem]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-moss">
            <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
            <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p>
            You&rsquo;re talking inside Cue. Your phone number and socials stay private unless you choose to share
            them.
          </p>
        </div>
        <div className="mt-1 -ml-3">
          <StepAway match={match} compact onGone={markGone} onLeaving={onLeaving} onLeaveFailed={onLeaveFailed} />
        </div>
      </header>

      <section aria-label={`Conversation with ${name}`} className="flex flex-1 flex-col">
        {olderCursor ? (
          <div className="mb-4 text-center">
            <Button variant="secondary" busy={loadingOlder} onClick={() => void loadOlder()}>
              Load earlier
            </Button>
            {olderError ? (
              <p role="alert" className="mt-2 text-sm font-medium text-ember-deep">
                {olderError}
              </p>
            ) : null}
          </div>
        ) : null}

        {!loaded && !loadError ? <Loading label="Opening your conversation…" /> : null}
        {loadError && !loaded ? (
          <Notice
            tone="error"
            title="Couldn't load your conversation"
            action={
              <Button variant="secondary" onClick={() => void fetchNewest()}>
                Try again
              </Button>
            }
          >
            {loadError}
          </Notice>
        ) : null}
        {loadError && loaded ? (
          <Notice tone="warn" className="mb-4">
            Couldn&apos;t check for new messages just now. {loadError}
          </Notice>
        ) : null}

        {empty ? (
          <div className="my-auto px-2 py-10 text-center">
            <p className="font-display text-2xl italic leading-snug">Of everyone there, you noticed each other.</p>
            <p className="mx-auto mt-2 max-w-sm text-ink-soft">
              Say hello to {name}. If you&rsquo;d like a way in,{" "}
              <Link href={`/matches/${matchId}`} className="font-medium text-ink underline underline-offset-4">
                find common ground on their card
              </Link>
              .
            </p>
          </div>
        ) : null}

        <ol role="log" aria-label="Messages" aria-live="polite" className="mt-auto flex flex-col">
          {timeline.map((e) => (
            <TimelineRow key={e.key} entry={e} name={name} onRetry={(o) => void deliver(o)} />
          ))}
        </ol>
      </section>

      <div className="sticky bottom-0 z-20 -mx-5 mt-4 border-t border-line bg-paper/95 px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0 sm:rounded-t-card sm:border-x sm:bg-surface/95 sm:px-4 sm:pb-4">
        {unseenBelow ? (
          <div className="pointer-events-none absolute inset-x-0 -top-14 flex justify-center">
            <button
              type="button"
              onClick={() => {
                stick.current = true;
                setUnseenBelow(false);
                scrollToBottom(true);
              }}
              className="pointer-events-auto min-h-11 rounded-full bg-ink px-4 text-sm font-semibold text-paper shadow-card"
            >
              New message below
            </button>
          </div>
        ) : null}
        <Composer
          matchId={matchId}
          name={name}
          disabled={!loaded}
          onSend={send}
        />
      </div>
    </div>
  );
}

function TimelineRow({
  entry,
  name,
  onRetry,
}: {
  entry: TimelineEntry;
  name: string;
  onRetry: (o: OutgoingMessage) => void;
}) {
  if (entry.kind === "day") {
    return (
      <li className="my-4 flex items-center gap-3 text-sm text-ink-soft" aria-label={entry.label}>
        <span aria-hidden className="h-px flex-1 bg-line" />
        <span>{entry.label}</span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </li>
    );
  }
  const o = entry.outgoing;
  const failed = o?.status === "failed";
  const sending = o?.status === "sending";
  return (
    <li className={cx("flex flex-col", entry.mine ? "items-end" : "items-start", entry.runStart ? "mt-3" : "mt-1")}>
      <span className="sr-only">{entry.mine ? "You:" : `${name}:`}</span>
      <p
        className={cx(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[1.0625rem] leading-snug sm:max-w-[75%]",
          entry.mine ? "bg-ink text-paper" : "border border-line bg-surface text-ink",
          entry.mine && entry.runEnd && "rounded-br-md",
          !entry.mine && entry.runEnd && "rounded-bl-md",
          sending && "opacity-70",
          failed && "bg-ember-soft! text-ink! ring-1 ring-ember/50",
        )}
      >
        {entry.body}
      </p>
      {failed ? (
        <div role="alert" className="mt-1 flex flex-wrap items-center justify-end gap-x-2 text-sm">
          <span className="font-medium text-ember-deep">Not sent. {o.error}</span>
          <Button variant="quiet" className="min-h-10 px-2 text-sm" onClick={() => onRetry(o)}>
            Try again
          </Button>
        </div>
      ) : sending ? (
        <p className="mt-1 text-xs text-ink-soft">Sending…</p>
      ) : entry.runEnd ? (
        <p className="mt-1 text-xs text-ink-soft">
          <time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)}</time>
        </p>
      ) : null}
    </li>
  );
}

function Composer({
  matchId,
  name,
  disabled,
  onSend,
}: {
  matchId: string;
  name: string;
  disabled: boolean;
  onSend: (body: string) => void;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [fromOpener, setFromOpener] = useState(false);
  const [enterSends, setEnterSends] = useState(false);

  // Restore the unsent draft, and take an opener handed over from the match page.
  useEffect(() => {
    const saved = chatDraft.load(matchId);
    const opener = chatDraft.takeOpener(matchId);
    const next = opener ? withOpener(saved, opener) : saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser storage
    setDraft(next);
    if (opener) {
      setFromOpener(true);
      chatDraft.save(matchId, next);
      requestAnimationFrame(() => {
        const el = area.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [matchId]);

  // Enter sends where there is a real keyboard; on touch screens Enter is a new line.
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setEnterSends(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Grow with the text, up to about six lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  const ok = canSend(draft, CHAT_MESSAGE_MAX_LENGTH) && !disabled;
  const left = CHAT_MESSAGE_MAX_LENGTH - draft.length;

  function update(v: string) {
    setDraft(v);
    chatDraft.save(matchId, v);
    if (!v) setFromOpener(false);
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!ok) return;
    onSend(draft);
    update("");
    area.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    if (!enterSends && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    submit();
  }

  return (
    <form onSubmit={submit} noValidate>
      {fromOpener ? (
        <p className="mb-2 text-sm text-ink-soft">Suggested opener added. Edit it as you like; it is only sent when you press Send.</p>
      ) : null}
      <label htmlFor={id} className="sr-only">
        Message {name}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          id={id}
          rows={1}
          value={draft}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          placeholder={`Write to ${name}`}
          aria-describedby={`${id}-hint`}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-[168px] min-h-12 w-full min-w-0 flex-1 resize-none rounded-3xl border border-line-strong bg-white px-4 py-3 text-base leading-snug text-ink placeholder:text-ink-soft/70 focus:border-ember focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember"
        />
        <button
          type="submit"
          disabled={!ok}
          aria-label="Send message"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ember text-white transition-colors hover:bg-ember-deep disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-surface"
        >
          {disabled ? (
            <Spinner size={18} />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
      <p id={`${id}-hint`} className="mt-1.5 flex justify-between gap-3 px-1 text-xs text-ink-soft">
        <span>{enterSends ? "Enter to send, Shift+Enter for a new line." : "Plain text only. Links aren't clickable."}</span>
        {left <= 200 ? (
          <span className={cx("tabular-nums", left <= 0 && "font-semibold text-ember-deep")} aria-live="polite">
            {draft.length} / {CHAT_MESSAGE_MAX_LENGTH}
          </span>
        ) : null}
      </p>
    </form>
  );
}
