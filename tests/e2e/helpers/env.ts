import fs from "node:fs";
import path from "node:path";

export const WEB_PORT = 3100;
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

const ENV_FILE = path.resolve(__dirname, "../../../apps/web/.env.local");

function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found. Start the local stack first: pnpm stack:start`);
  }
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export interface StackEnv {
  supabaseUrl: string;
  anonKey: string;
  /** Local-stack service-role key. Only ever used by test helpers, never sent to the web app. */
  serviceRoleKey: string;
}

let cached: StackEnv | undefined;

/** Local Supabase credentials written by `pnpm stack:start` into apps/web/.env.local. */
export function stackEnv(): StackEnv {
  if (cached) return cached;
  const env = parseEnvFile(ENV_FILE);
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} missing from ${ENV_FILE}. Run: pnpm stack:start`);
    return v;
  };
  cached = {
    supabaseUrl: need("NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    serviceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  };
  return cached;
}
