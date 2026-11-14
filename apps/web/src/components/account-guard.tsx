"use client";

import { useEffect } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Tabs of one browser share a single login. If someone signs in as a different
 * account (or signs out) in another tab, this page would keep showing the old
 * account while every request it sends goes out as the new one. This guard
 * notices that the browser's login no longer matches the account the server
 * rendered this page for, and does a full reload so the page and the login
 * agree again.
 *
 * It checks when another tab announces an auth change, and whenever this tab
 * is shown or focused again (which is before the person can act in it).
 */
export function AccountGuard({ userId }: { userId: string }) {
  useEffect(() => {
    const supabase = getBrowserSupabase();
    let leaving = false;

    const leave = (signedOut: boolean) => {
      if (leaving) return;
      leaving = true;
      // Full navigation on purpose: server-rendered state must reset.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (signedOut) window.location.assign("/sign-in");
      else window.location.reload();
    };

    const check = async () => {
      if (leaving) return;
      // Reads the shared auth cookie, so it reflects what other tabs did.
      const { data, error } = await supabase.auth.getSession();
      if (error) return; // transient; the next focus or auth event checks again
      const current = data.session?.user.id ?? null;
      if (current === null) leave(true);
      else if (current !== userId) leave(false);
    };

    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        leave(true);
        return;
      }
      const current = session?.user.id ?? null;
      if (current !== null && current !== userId) leave(false);
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onFocus = () => void check();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onFocus);
    void check();

    return () => {
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onFocus);
    };
  }, [userId]);

  return null;
}
