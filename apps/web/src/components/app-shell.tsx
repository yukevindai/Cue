"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { useLive } from "@/components/live-provider";
import { Wordmark } from "@/components/ui";

const NAV = [
  { href: "/encounter", label: "Encounter", icon: EncounterIcon },
  { href: "/matches", label: "Matches", icon: MatchesIcon },
  { href: "/profile", label: "Profile", icon: ProfileIcon },
] as const;

/**
 * Signed-in frame: wordmark, three destinations (top bar on wide screens, a
 * thumb-reach tab bar on phones), and the main column. The only badge is
 * unread messages on Matches. In a conversation the phone tab bar steps aside
 * so the message box sits at the bottom of the screen.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, realtime, matches } = useLive();

  // A conversation that is open right now counts as read.
  const openChat = /^\/matches\/([^/]+)\/chat/.exec(pathname)?.[1] ?? null;
  const unread = (matches ?? []).reduce((n, m) => (m.id === openChat ? n : n + m.unreadCount), 0);
  const inChat = openChat !== null;

  // New accounts land on profile setup before anything else.
  const needsSetup = profile === null;
  useEffect(() => {
    if (needsSetup && !pathname.startsWith("/profile")) router.replace("/profile");
  }, [needsSetup, pathname, router]);

  return (
    <div className="flex min-h-dvh flex-col">
      <span id="unread-summary" hidden>
        {unread === 1 ? "1 unread message" : `${unread} unread messages`}
      </span>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5">
          <Link href="/encounter" aria-label="SocialEyes, go to Encounter" className="rounded-md">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="hidden sm:block">
            <ul className="flex items-center gap-1">
              {NAV.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      aria-describedby={item.href === "/matches" && unread > 0 ? "unread-summary" : undefined}
                      className={cx(
                        "inline-flex items-center gap-1.5 rounded-full px-4 py-2 font-medium transition-colors",
                        active ? "bg-ink text-paper" : "text-ink-soft hover:bg-sunk hover:text-ink",
                      )}
                    >
                      {item.label}
                      {item.href === "/matches" ? <UnreadBadge count={unread} /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          {realtime === "reconnecting" ? (
            <p role="status" className="text-sm text-ink-soft sm:hidden">
              Reconnecting…
            </p>
          ) : null}
        </div>
        {realtime === "reconnecting" ? (
          <p
            role="status"
            className="hidden border-t border-line bg-sunk px-5 py-1 text-center text-sm text-ink-soft sm:block"
          >
            Reconnecting to live updates. SocialEyes keeps checking in the meantime.
          </p>
        ) : null}
      </header>

      <main
        id="main"
        className={cx(
          "mx-auto w-full max-w-3xl flex-1 px-5 pt-8 sm:pt-10",
          inChat ? "pb-0 sm:pb-6" : "pb-32 sm:pb-16",
        )}
      >
        {children}
      </main>

      <nav
        aria-label="Main"
        className={cx(
          "fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden",
          inChat && "hidden",
        )}
      >
        <ul className="mx-auto flex max-w-md">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-describedby={item.href === "/matches" && unread > 0 ? "unread-summary" : undefined}
                  className={cx(
                    "flex min-h-16 flex-col items-center justify-center gap-0.5 text-sm font-medium",
                    active ? "text-ember-deep" : "text-ink-soft",
                  )}
                >
                  <span className="relative">
                    <Icon active={active} />
                    {item.href === "/matches" ? <UnreadBadge count={unread} floating /> : null}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * Unread messages across all matches. The count is announced as a description,
 * so the link's name stays "Matches".
 */
function UnreadBadge({ count, floating = false }: { count: number; floating?: boolean }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className={cx(
          "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ember px-1.5 text-xs font-semibold tabular-nums leading-none text-white",
          floating && "absolute -right-2.5 -top-1 ring-2 ring-surface",
        )}
      >
        {count > 99 ? "99+" : count}
      </span>
    </>
  );
}

function EncounterIcon({ active }: { active: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
      <circle cx="13" cy="13" r="4" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" />
      <circle cx="13" cy="13" r="9.5" stroke="currentColor" strokeWidth="1.8" strokeOpacity={active ? 1 : 0.7} />
    </svg>
  );
}
function MatchesIcon({ active }: { active: boolean }) {
  return (
    <svg width="30" height="26" viewBox="0 0 30 26" fill="none" aria-hidden>
      <circle cx="11" cy="13" r="8" stroke="currentColor" strokeWidth="1.8" />
      <circle
        cx="19"
        cy="13"
        r="8"
        stroke="currentColor"
        strokeWidth="1.8"
        fill={active ? "currentColor" : "none"}
        fillOpacity="0.25"
      />
    </svg>
  );
}
function ProfileIcon({ active }: { active: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
      <circle cx="13" cy="9.5" r="4.5" stroke="currentColor" strokeWidth="1.8" fill={active ? "currentColor" : "none"} fillOpacity="0.25" />
      <path d="M4.5 22c1.2-4 4.5-6 8.5-6s7.3 2 8.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
