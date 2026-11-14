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
 */
export const FAKE_ANTHROPIC_PORT = 3199;
export const FAKE_ANTHROPIC_URL = `http://127.0.0.1:${FAKE_ANTHROPIC_PORT}`;
/** The only API key value the web server is given in e2e. */
export const DUMMY_API_KEY = "e2e-dummy-key";

export type FakeMode = "ok" | "error" | "hang";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Header values; credentials other than the dummy key are redacted. */
  headers: Record<string, string>;
  /** Raw request body text. */
  rawBody: string;
  /** Parsed JSON body, or null if it was not JSON. */
  body: unknown;
}

interface State {
  mode: FakeMode;
  text: string;
  requests: RecordedRequest[];
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
  const state: State = { mode: "error", text: "{}", requests: [] };
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;

    // Control plane (used by tests).
    if (path === "/__control" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { mode: FakeMode; text?: string };
      state.mode = body.mode;
      if (body.text !== undefined) state.text = body.text;
      return json(res, 200, { mode: state.mode });
    }
    if (path === "/__reset" && req.method === "POST") {
      state.mode = "error";
      state.text = "{}";
      state.requests = [];
      return json(res, 200, { mode: state.mode });
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
      state.requests.push({ method: req.method, path: req.url ?? path, headers, rawBody, body });

      if (state.mode === "hang") return; // never respond; socket is destroyed on close
      if (state.mode === "error") {
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
        content: [{ type: "text", text: state.text }],
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
  async setMode(mode: FakeMode, text?: string): Promise<void> {
    const r = await fetch(`${FAKE_ANTHROPIC_URL}/__control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, text }),
    });
    if (!r.ok) throw new Error(`fake anthropic control failed: ${r.status}`);
  },
  /** Answer every model call with this JSON value as the single text block. */
  async respondWith(output: unknown): Promise<void> {
    await this.setMode("ok", JSON.stringify(output));
  },
  async requests(): Promise<RecordedRequest[]> {
    const r = await fetch(`${FAKE_ANTHROPIC_URL}/__requests`);
    if (!r.ok) throw new Error(`fake anthropic requests failed: ${r.status}`);
    return ((await r.json()) as { requests: RecordedRequest[] }).requests;
  },
};
