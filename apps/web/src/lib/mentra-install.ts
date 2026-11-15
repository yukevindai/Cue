/**
 * Installing the Mentra Live mini app from this website.
 *
 * The site serves the same three files `mentra-miniapp release` serves from a
 * laptop (`miniapp.json`, `icon.png`, `bundle.zip`) under MENTRA_RELEASE_PATH.
 * The MentraOS phone app installs from a `miniapp://release?...` link whose
 * `url` is that base address. See apps/web/scripts/build-mentra-bundle.mjs.
 */
export const MENTRA_RELEASE_PATH = "/mentra";

export interface MentraManifest {
  packageName: string;
  version: string;
  name: string;
}

/** Picks the fields the install link needs out of `miniapp.json`; null if it is not usable. */
export function readMentraManifest(json: unknown): MentraManifest | null {
  if (typeof json !== "object" || json === null) return null;
  const { packageName, version, name } = json as Record<string, unknown>;
  if (typeof packageName !== "string" || !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(packageName)) return null;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) return null;
  return { packageName, version, name: typeof name === "string" && name ? name : packageName };
}

/** Where the phone downloads the release from: `<origin>/mentra`. */
export function mentraReleaseBase(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MENTRA_RELEASE_PATH}`;
}

/** The link the MentraOS app's QR scanner understands. Same shape the Mentra tool prints. */
export function mentraInstallLink(origin: string, m: MentraManifest): string {
  const q = (s: string) => encodeURIComponent(s);
  return `miniapp://release?url=${q(mentraReleaseBase(origin))}&package=${q(m.packageName)}&version=${q(m.version)}&name=${q(m.name)}`;
}
