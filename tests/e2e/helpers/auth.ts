import {
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
} from "@playwright/test";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { BASE_URL, stackEnv } from "./env";
import type { TestUser } from "./users";

/**
 * @supabase/ssr (0.7.x) cookie format, read from
 * apps/web/node_modules/@supabase/ssr/dist/main/{cookies,utils/chunker}.js:
 *
 *  - name:   `sb-<first label of the Supabase URL hostname>-auth-token`
 *            (supabase-js default storageKey; `sb-127-auth-token` for 127.0.0.1)
 *  - value:  "base64-" + base64url(JSON.stringify(session))   (cookieEncoding "base64url")
 *  - chunks: if encodeURIComponent(value).length > 3180 (MAX_CHUNK_SIZE) the
 *            value is split into `<name>.0`, `<name>.1`, ... along that limit.
 *            base64url is URL-safe, so encoded length == value length.
 *  - options: path "/", sameSite "lax", httpOnly false, maxAge 400 days.
 */
const BASE64_PREFIX = "base64-";
const MAX_CHUNK_SIZE = 3180;

export function authCookieName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

export interface Cookie {
  name: string;
  value: string;
}

/** The cookie(s) `@supabase/ssr` expects for this session. */
export function sessionCookies(session: Session, supabaseUrl = stackEnv().supabaseUrl): Cookie[] {
  const name = authCookieName(supabaseUrl);
  const value = BASE64_PREFIX + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  if (encodeURIComponent(value).length <= MAX_CHUNK_SIZE) return [{ name, value }];
  const chunks: Cookie[] = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK_SIZE, n++) {
    chunks.push({ name: `${name}.${n}`, value: value.slice(i, i + MAX_CHUNK_SIZE) });
  }
  return chunks;
}

/** A fresh supabase-js client signed in as the user (own JWT; RLS applies). */
export async function signInClient(user: TestUser): Promise<{ client: SupabaseClient; session: Session }> {
  const { supabaseUrl, anonKey } = stackEnv();
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error || !data.session) throw new Error(`sign-in failed for ${user.email}: ${error?.message}`);
  return { client, session: data.session };
}

function storageState(cookies: Cookie[]) {
  const host = new URL(BASE_URL).hostname;
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: host,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
    origins: [],
  };
}

/** A signed-in test user: API context for the Next app, plus a realtime-capable supabase-js client. */
export interface Actor {
  user: TestUser;
  session: Session;
  /** Cookie-authenticated request context for the Next app (baseURL = the e2e server). */
  ctx: APIRequestContext;
  /** supabase-js client signed in as this user (for realtime). */
  supabase: SupabaseClient;
  cookies: Cookie[];
  /** A new browser context carrying this user's session cookies (for UI specs). */
  browserContext(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext>;
  dispose(): Promise<void>;
}

export async function signInActor(user: TestUser): Promise<Actor> {
  const { client, session } = await signInClient(user);
  const cookies = sessionCookies(session);
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: storageState(cookies) });
  const browserContexts: BrowserContext[] = [];
  return {
    user,
    session,
    ctx,
    supabase: client,
    cookies,
    async browserContext(browser, options) {
      const bctx = await browser.newContext({ baseURL: BASE_URL, ...options, storageState: storageState(cookies) });
      browserContexts.push(bctx);
      return bctx;
    },
    async dispose() {
      await client.removeAllChannels();
      for (const c of browserContexts) await c.close().catch(() => undefined);
      await ctx.dispose();
    },
  };
}

/** Request context with no credentials at all. */
export function anonymousApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: BASE_URL });
}

/** Request context authenticated only with a device bearer token (no cookies). */
export function deviceApi(deviceToken: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${deviceToken}` },
  });
}
