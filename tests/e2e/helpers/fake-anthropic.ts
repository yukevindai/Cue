import http from "node:http";
import type { Socket } from "node:net";

/**
 * Fake Anthropic Messages API for the wingman tests.
 *
 * Runs in the Playwright runner process (global-setup). Tests run in a worker
 * process, so they steer it over HTTP through the `/__control` endpoints; use
 * the `fakeAnthropic` client below.
 *
 * Modes for `POST /v1/messages`:
 *   - ok:    200 with a valid non-streaming Messages response whose single
 *            text block is the JSON string the test supplied.
 *   - error: 500 with an Anthropic-style JSON error body (default).
 *   - hang:  accept the request and never answer.
 *
 * Two kinds of call reach it: the grounded wingman's ("wingman") and the
 * spoken wingman line's ("hype", recognised by its system prompt). Each kind
 * has its own mode and text, so a test can answer the two differently. The
 * plain `setMode` / `respondWith` set both kinds, as before; `kind` picks one.
 */
export const FAKE_ANTHROPIC_PORT = 3199;
export const FAKE_ANTHROPIC_URL = `http://127.0.0.1:${FAKE_ANTHROPIC_PORT}`;
/** The only API key value the web server is given in e2e. */
export const DUMMY_API_KEY = "e2e-dummy-key";

export type FakeMode = "ok" | "error" | "hang";
export type CallKind = "wingman" | "hype";
export type KindSelector = CallKind | "all";
const KINDS: CallKind[] = ["wingman", "hype"];

export interface RecordedRequest {
  method: string;
  path: string;
  /** Header values; credentials other than the dummy key are redacted. */
  headers: Record<string, string>;
  /** Raw request body text. */
  rawBody: string;
  /** Parsed JSON body, or null if it was not JSON. */
  body: unknown;
  /** Which pipeline sent it, told apart by the system prompt. */
  kind: CallKind;
}

interface State {
  modes: Record<CallKind, { mode: FakeMode; text: string }>;
  requests: RecordedRequest[];
}

const freshModes = (): State["modes"] => ({
  wingman: { mode: "error", text: "{}" },
  hype: { mode: "error", text: "{}" },
});

/** The hype pipeline's system prompt opens with this persona; the wingman's does not. */
function kindOf(body: unknown): CallKind {
  const system = body && typeof body === "object" && "system" in body ? JSON.stringify((body as { system: unknown }).system) : "";
  return system.includes("Gen Z friend") ? "hype" : "wingman";
}

const SENSITIVE = new Set(["x-api-key", "authorization"]);

function redact(name: string, value: string): string {
  if (!SENSITIVE.has(name)) return value;
  return value === DUMMY_API_KEY || value === `Bearer ${DUMMY_API_KEY}` ? value : "[redacted-non-dummy-credential]";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface FakeAnthropicServer {
  close(): Promise<void>;
}

export async function startFakeAnthropic(port = FAKE_ANTHROPIC_PORT): Promise<FakeAnthropicServer> {
  const state: State = { modes: freshModes(), requests: [] };
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;

    // Control plane (used by tests).
    if (path === "/__control" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { mode: FakeMode; text?: string; kind?: KindSelector };
      for (const k of body.kind && body.kind !== "all" ? [body.kind] : KINDS) {
        state.modes[k].mode = body.mode;
        if (body.text !== undefined) state.modes[k].text = body.text;
      }
      return json(res, 200, { modes: state.modes });
    }
    if (path === "/__reset" && req.method === "POST") {
      state.modes = freshModes();
      state.requests = [];
      return json(res, 200, { modes: state.modes });
    }
    if (path === "/__requests" && req.method === "GET") {
      return json(res, 200, { requests: state.requests });
    }

    // Anthropic Messages API (the SDK may append ?beta=true).
    if (path === "/v1/messages" && req.method === "POST") {
      const rawBody = await readBody(req);
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        /* keep null */
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = redact(k, Array.isArray(v) ? v.join(",") : (v ?? ""));
      }
      const kind = kindOf(body);
      state.requests.push({ method: req.method, path: req.url ?? path, headers, rawBody, body, kind });
      const { mode, text } = state.modes[kind];

      if (mode === "hang") return; // never respond; socket is destroyed on close
      if (mode === "error") {
        return json(res, 500, {
          type: "error",
          error: { type: "api_error", message: "fake anthropic: simulated upstream failure" },
        });
      }
      const model =
        body && typeof body === "object" && "model" in body && typeof body.model === "string"
          ? body.model
          : "fake-model";
      return json(res, 200, {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }

    json(res, 404, { type: "error", error: { type: "not_found_error", message: `${req.method} ${path}` } });
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${port} is in use; the fake Anthropic server needs it. Stop whatever holds it.`)
          : err,
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Test-side control client (works from any process). */
export const fakeAnthropic = {
  async reset(): Promise<void> {
    const r = await fetch(`${FAKE_ANTHROPIC_URL}/__reset`, { method: "POST" });
    if (!r.ok) throw new Error(`fake anthropic reset failed: ${r.status}`);
  },
  async setMode(mode: FakeMode, text?: string, kind: KindSelector = "all"): Promise<void> {
    const r = await fetch(`${FAKE_ANTHROPIC_URL}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, text, kind }),
    });
    if (!r.ok) throw new Error(`fake anthropic control failed: ${r.status}`);
  },
  /** Answer every model call with this JSON value as the single text block. */
  async respondWith(output: unknown): Promise<void> {
    await this.setMode("ok", JSON.stringify(output));
  },
  /** Answer the spoken wingman line's call with `{ line }`; the grounded wingman's mode is untouched. */
  async hypeSays(line: string): Promise<void> {
    await this.setMode("ok", JSON.stringify({ line }), "hype");
  },
  /** Every call received, or only those of one kind. */
  async requests(kind?: CallKind): Promise<RecordedRequest[]> {
    const r = await fetch(`${FAKE_ANTHROPIC_URL}/__requests`);
    if (!r.ok) throw new Error(`fake anthropic requests failed: ${r.status}`);
    const all = ((await r.json()) as { requests: RecordedRequest[] }).requests;
    return kind ? all.filter((q) => q.kind === kind) : all;
  },
};
