/**
 * DEVELOPMENT HARNESS. NOT A SWIPE.
 *
 * Feeds a hand-written raw touch payload into the real bridge (same pipeline,
 * API client and account link the miniapp runs) against a real Cue server, to
 * prove the device-token path: claim -> /api/devices/me -> /api/interest.
 * It proves nothing about the glasses. The spec's checkpoint ("an actual
 * backward swipe reaches the server") can only be met on the hardware; see
 * docs/hardware-check.md.
 *
 *   pnpm inject -- --server http://localhost:3000 --code ABC123 --gesture backward_swipe
 *   pnpm inject -- --server http://localhost:3000 --gesture forward_swipe --gesture single_tap
 *
 * The device token is kept in ./.cue-inject-token (git-ignored, mode 0600).
 */
import { parseArgs } from "node:util";
import { CueBridge } from "../bridge";
import { STORAGE_KEYS } from "../config";
import { recordingFeedback } from "../feedback";
import { createLogger, type LogSink } from "../logger";
import { fileTokenStore } from "../token-store-node";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    code: { type: "string" },
    gesture: { type: "string", multiple: true },
    "gap-ms": { type: "string", default: "0" },
    calibration: { type: "boolean", default: false },
    "token-file": { type: "string", default: ".cue-inject-token" },
  },
});

const out: LogSink = (_level, line) => process.stdout.write(`${line}\n`);
const logger = createLogger(out);

if (!values.server) {
  logger.error("usage: pnpm inject -- --server <origin> [--code <pairing code>] [--gesture <raw name>]...");
  process.exit(2);
}

logger.warn("SIMULATED INPUT: these events are injected by a script, not produced by a touch strip.");

const tokens = fileTokenStore(values["token-file"]);
const memory = new Map<string, string>([
  [STORAGE_KEYS.serverUrl, values.server],
  [STORAGE_KEYS.calibration, values.calibration ? "1" : "0"],
]);
const feedback = recordingFeedback();

const bridge = new CueBridge({
  storage: {
    get: async (key) => (key === STORAGE_KEYS.deviceToken ? tokens.load() : (memory.get(key) ?? null)),
    set: async (key, value) => (key === STORAGE_KEYS.deviceToken ? tokens.save(value) : void memory.set(key, value)),
    delete: async (key) => (key === STORAGE_KEYS.deviceToken ? tokens.clear() : void memory.delete(key)),
  },
  feedback,
  logger,
  mentraUserId: () => null,
});

await bridge.start({ poll: false });

if (values.code) {
  const linked = await bridge.linkWithCode(values.code);
  logger.info("pairing", linked);
  if (!linked.ok) process.exit(1);
}

const gapMs = Number(values["gap-ms"]);
for (const gestureName of values.gesture ?? []) {
  await bridge.refresh();
  const outcome = await bridge.handleTouch({ type: "touch_event", gestureName, timestamp: Date.now(), source: "inject-script" });
  logger.info(`injected "${gestureName}"`, { context: bridge.status().context, outcome });
  if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
}

logger.info("done", { status: { ...bridge.status(), recentGestures: undefined }, cues: feedback.cues });
