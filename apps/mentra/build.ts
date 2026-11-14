/**
 * Builds the two-layer miniapp bundle into ./dist:
 *   dist/background/index.js  IIFE, SDK bundled in (the JS context has no module resolver)
 *   dist/ui/index.html + main.js
 *
 * Runs under Bun (`mentra-miniapp dev` calls `bun run build.ts`) and under
 * Node >= 22.18 (`pnpm miniapp:build`), so CI needs no Bun.
 * MENTRA_PUBLIC_CUE_SERVER_URL, if set, becomes the default Cue web origin.
 * Never put a secret in a MENTRA_PUBLIC_* variable: it is inlined in the bundle.
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "ui"), { recursive: true });

const define = {
  "process.env.MENTRA_PUBLIC_CUE_SERVER_URL": JSON.stringify(process.env.MENTRA_PUBLIC_CUE_SERVER_URL ?? ""),
};

await build({
  entryPoints: [resolve(root, "src/background/index.ts")],
  outfile: resolve(dist, "background/index.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  define,
  logLevel: "warning",
});

await build({
  entryPoints: [resolve(root, "src/ui/main.ts")],
  outfile: resolve(dist, "ui/main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  define,
  logLevel: "warning",
});

await cp(resolve(root, "src/ui/index.html"), resolve(dist, "ui/index.html"));
