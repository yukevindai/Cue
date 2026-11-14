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
 * thumb-reach tab bar on phones), and the main column. No counts or badges.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, realtime } = useLive();

  // New accounts land on profile setup before anything else.
  const needsSetup = profile === null;
  useEffect(() => {
    if (needsSetup && !pathname.startsWith("/profile")) router.replace("/profile");
  }, [needsSetup, pathname, router]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5">
          <Link href="/encounter" aria-label="Cue, go to Encounter" className="rounded-md">
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
                      className={cx(
                        "rounded-full px-4 py-2 font-medium transition-colors",
                        active ? "bg-ink text-paper" : "text-ink-soft hover:bg-sunk hover:text-ink",
                      )}
                    >
                      {item.label}
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
            Reconnecting to live updates. Cue keeps checking in the meantime.
          </p>
        ) : null}
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-5 pb-32 pt-8 sm:pb-16 sm:pt-10">
        {children}
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
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
                  className={cx(
                    "flex min-h-16 flex-col items-center justify-center gap-0.5 text-sm font-medium",
                    active ? "text-ember-deep" : "text-ink-soft",
                  )}
                >
                  <Icon active={active} />
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
