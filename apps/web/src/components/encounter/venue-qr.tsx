"use client";

import type { CheckIn } from "@cue/contracts";
import QRCode from "qrcode";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import { spellCode, venueCheckInUrl } from "@/lib/encounter";

const noopSubscribe = () => () => {};
const getOrigin = () => window.location.origin;

/**
 * A venue's QR code (opens `<origin>/v/<code>` in the phone's camera app), the
 * code in large type for typing in, and a copy-link button. Rendered locally
 * from the code; nothing is sent anywhere to draw it.
 */
export function VenueQr({ checkIn, onHide }: { checkIn: CheckIn; onHide: () => void }) {
  const origin = useSyncExternalStore(noopSubscribe, getOrigin, () => "");
  const url = origin ? venueCheckInUrl(origin, checkIn.code) : "";
  const [svg, setSvg] = useState<{ url: string; markup: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // Opened from "Show QR code" or "Host this place": bring it into view.
  useEffect(() => {
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((markup) => {
        if (!cancelled) setSvg({ url, markup });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let note: string;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      note = "Link copied";
    } catch {
      note = "Couldn't copy from here. Share the code instead.";
    }
    setCopyNote(note);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopyNote(null), 3000);
  }

  const ready = svg !== null && svg.url === url;

  return (
    <section
      ref={sectionRef}
      aria-labelledby="venue-qr-title"
      className="animate-rise scroll-mt-20 rounded-2xl border border-line bg-sunk px-4 py-5 text-center"
    >
      <h3 id="venue-qr-title" className="font-display text-xl leading-tight break-words">
        Check in at {checkIn.name}
      </h3>
      <p className="mt-1 text-sm text-ink-soft">
        Point a phone camera at the code, or type the code into the SocialEyes Encounter page.
      </p>

      <div className="mx-auto mt-4 grid aspect-square w-full max-w-64 place-items-center rounded-xl bg-white p-3">
        {ready ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local data URL, not a remote image
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.markup)}`}
            alt={`QR code that opens ${url}`}
            className="h-full w-full"
          />
        ) : failed ? (
          <p className="text-sm text-ink-soft">Couldn&apos;t draw the QR code. Share the code below.</p>
        ) : (
          <span className="sr-only">Drawing the QR code…</span>
        )}
      </div>

      <p className="mt-4 text-sm font-medium text-ink-soft">Venue code</p>
      <p className="mt-1 font-mono text-5xl font-semibold leading-none tracking-[0.14em] sm:text-6xl">
        <span aria-hidden>{checkIn.code}</span>
        <span className="sr-only">{spellCode(checkIn.code)}</span>
      </p>
      {url ? <p className="mt-3 text-sm break-all text-ink-soft">{url}</p> : null}

      <div className="mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
        <Button variant="secondary" onClick={copy} disabled={!url}>
          Copy link
        </Button>
        <Button variant="quiet" onClick={onHide}>
          Hide QR code
        </Button>
      </div>
      <p role="status" className="mt-2 text-sm text-ink-soft empty:hidden">
        {copyNote}
      </p>
    </section>
  );
}
