"use client";

import QRCode from "qrcode";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Card, Notice } from "@/components/ui";
import { buttonClass } from "@/components/ui";
import { MENTRA_RELEASE_PATH, mentraInstallLink, readMentraManifest, type MentraManifest } from "@/lib/mentra-install";

const noopSubscribe = () => () => {};
const getOrigin = () => window.location.origin;

type Load = { state: "loading" } | { state: "ready"; manifest: MentraManifest } | { state: "missing" };

/**
 * Installs the Cue mini app into the MentraOS phone app from this website: a
 * QR code for the Mentra app's scanner, and the same link to tap when this
 * page is open on the phone that has the Mentra app. Drawn locally.
 */
export function MentraInstall() {
  const origin = useSyncExternalStore(noopSubscribe, getOrigin, () => "");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [svg, setSvg] = useState<{ link: string; markup: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${MENTRA_RELEASE_PATH}/miniapp.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (cancelled) return;
        const manifest = readMentraManifest(json);
        setLoad(manifest ? { state: "ready", manifest } : { state: "missing" });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const link = origin && load.state === "ready" ? mentraInstallLink(origin, load.manifest) : "";

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((markup) => {
        if (!cancelled) setSvg({ link, markup });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [link]);

  if (load.state === "missing") {
    return (
      <Notice tone="error">
        The mini app isn&apos;t available from this site right now. It can still be installed from a
        laptop: see the Mentra section of the project README.
      </Notice>
    );
  }

  const ready = svg !== null && svg.link === link;

  return (
    <div className="space-y-5">
      <Card aria-labelledby="mentra-scan-title">
        <h2 id="mentra-scan-title" className="font-display text-2xl leading-tight tracking-tight">
          Scan with the Mentra app
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-ink-soft">
          <li>Open the Mentra app on the phone your glasses are paired with.</li>
          <li>Go to Settings, then Developer settings, then Mini App Development.</li>
          <li>Tap Scan Mini App QR Code and point it at this code.</li>
        </ol>
        <div className="mx-auto mt-4 grid aspect-square w-full max-w-64 place-items-center rounded-xl bg-white p-3">
          {ready ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local data URL, not a remote image
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.markup)}`}
              alt="QR code that installs the Cue mini app in the Mentra app"
              className="h-full w-full"
            />
          ) : (
            <span className="sr-only">Drawing the QR code…</span>
          )}
        </div>
        {load.state === "ready" ? (
          <p className="mt-3 text-center text-sm text-ink-soft">
            {load.manifest.name} mini app, version {load.manifest.version}
          </p>
        ) : null}
        <p className="mt-3 text-sm text-ink-soft">
          The code has to be on a different screen from the phone that scans it. Open this page on a
          computer or a second phone.
        </p>
      </Card>

      <Card aria-labelledby="mentra-tap-title">
        <h2 id="mentra-tap-title" className="font-display text-2xl leading-tight tracking-tight">
          Or, on the phone with the Mentra app
        </h2>
        <p className="mt-3 text-ink-soft">
          If you&apos;re reading this on that phone, this opens the Mentra app and installs the mini
          app directly. If nothing happens, use the QR code above from another screen.
        </p>
        {link ? (
          <a href={link} className={`${buttonClass("secondary")} mt-4 max-sm:w-full`}>
            Open in the Mentra app
          </a>
        ) : null}
      </Card>

      <Card aria-labelledby="mentra-next-title">
        <h2 id="mentra-next-title" className="font-display text-2xl leading-tight tracking-tight">
          After it installs
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-ink-soft">
          <li>In Cue, open Encounter and tap Link glasses to get a pairing code.</li>
          <li>Enter that code in the Cue mini app.</li>
          <li>Turn on Encounter mode and check into a venue, then swipe backward on the temple.</li>
        </ol>
        <p className="mt-3 text-sm text-ink-soft">
          No laptop or shared Wi-Fi is needed. Install again from this page to get a newer version.
        </p>
      </Card>
    </div>
  );
}
