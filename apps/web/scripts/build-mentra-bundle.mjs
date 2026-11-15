/**
 * Builds the Mentra Live mini app and publishes its release files with the
 * website, so a phone can install it from the site instead of from a laptop
 * on the same network:
 *
 *   public/mentra/miniapp.json
 *   public/mentra/icon.png
 *   public/mentra/bundle.zip
 *   public/mentra/__mentra_release/health
 *
 * These are the files `mentra-miniapp release` serves from a laptop, and the
 * zip has the layout `mentra-miniapp pack` produces: the contents of
 * apps/mentra/dist at the root, plus miniapp.json and icon.png. The zip is
 * written here with node:zlib, so no `zip` program or Bun is needed.
 *
 * The mini app's default server address is MENTRA_PUBLIC_CUE_SERVER_URL if
 * set, else the Vercel production domain when building on Vercel, else none
 * (the wearer types it in the mini app's setup screen).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mentraRoot = resolve(webRoot, "../mentra");
const outDir = resolve(webRoot, "public/mentra");

const serverUrl =
  process.env.MENTRA_PUBLIC_CUE_SERVER_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

execFileSync("pnpm", ["--filter", "@cue/mentra", "build"], {
  cwd: resolve(webRoot, "../.."),
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", MENTRA_PUBLIC_CUE_SERVER_URL: serverUrl },
});

const manifestBytes = readFileSync(join(mentraRoot, "miniapp.json"));
const iconBytes = readFileSync(join(mentraRoot, "icon.png"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const distDir = join(mentraRoot, "dist");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

const files = new Map();
for (const abs of walk(distDir)) files.set(relative(distDir, abs).split(sep).join("/"), readFileSync(abs));
files.set("miniapp.json", manifestBytes);
files.set("icon.png", iconBytes);

for (const [label, rel] of Object.entries(manifest.entry ?? {})) {
  if (!files.has(rel)) throw new Error(`miniapp.json entry.${label} points at "${rel}", which the build did not produce`);
}

/** A plain zip archive: deflate, no encryption, fixed timestamp so builds are repeatable. */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "__mentra_release"), { recursive: true });
writeFileSync(join(outDir, "miniapp.json"), manifestBytes);
writeFileSync(join(outDir, "icon.png"), iconBytes);
writeFileSync(join(outDir, "bundle.zip"), zip(files));
writeFileSync(join(outDir, "__mentra_release", "health"), JSON.stringify({ ok: true }));

const kb = Math.round(statSync(join(outDir, "bundle.zip")).size / 1024);
console.log(
  `Mentra mini app ${manifest.packageName}@${manifest.version}: ${files.size} files, ${kb} KB -> public/mentra ` +
    `(default server: ${serverUrl || "none"})`,
);
