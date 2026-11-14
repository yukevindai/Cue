import { GESTURE_DEBOUNCE_MS, InterestEvent, type InterestAck } from "@cue/contracts";
import { describe, expect, it, vi } from "vitest";
import { EncounterContextTracker, type ContextFetchResult, type ContextSnapshot } from "./encounter-context";
import { cueForAck, recordingFeedback } from "./feedback";
import { GesturePipeline, type SubmitResult } from "./pipeline";
import { DEVICE_ID, SESSION_ID, ack } from "./testing";
import { CueApiClient } from "./api-client";
import { fakeFetch, json } from "./testing";

const BACK = "swipe_backward";

function harness(opts: { context?: ContextSnapshot; backward?: string | null; calibration?: boolean; result?: SubmitResult } = {}) {
  const state = {
    now: 1_800_000_000_000,
    context: opts.context ?? ({ state: "ready", encounterSessionId: SESSION_ID } as ContextSnapshot),
  };
  const submit = vi.fn<(e: InterestEvent) => Promise<SubmitResult>>(async () => opts.result ?? { ok: true, ack: ack() });
  const feedback = recordingFeedback();
  const pipeline = new GesturePipeline({
    mapping: { backwardSwipeGestureName: opts.backward === undefined ? BACK : opts.backward },
    calibration: opts.calibration ?? false,
    context: () => state.context,
    submit,
    feedback,
    now: () => state.now,
  });
  return { state, submit, feedback, pipeline };
}

const swipe = (name = BACK) => ({ gestureName: name });

describe("pipeline: accepted swipe", () => {
  it("submits exactly one contract-valid event and plays signal_sent", async () => {
    const h = harness();
    const out = await h.pipeline.handleRawEvent(swipe());
    expect(h.submit).toHaveBeenCalledTimes(1);
    const event = h.submit.mock.calls[0]![0];
    expect(InterestEvent.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      source: "mentra_touch",
      gesture: "backward_swipe",
      encounterSessionId: SESSION_ID,
      occurredAt: new Date(h.state.now).toISOString(),
    });
    expect(out.kind).toBe("submitted");
    expect(h.feedback.cues).toEqual(["signal_sent"]);
  });

  it("matched ack plays match", async () => {
    const h = harness({ result: { ok: true, ack: ack({ matched: true, expiresAt: null }) } });
    await h.pipeline.handleRawEvent(swipe());
    expect(h.feedback.cues).toEqual(["match"]);
  });

  it("rejected and duplicate acks give not_sent and signal_sent", async () => {
    const r = harness({ result: { ok: true, ack: ack({ status: "rejected", reason: "blocked", expiresAt: null }) } });
    await r.pipeline.handleRawEvent(swipe());
    expect(r.feedback.cues).toEqual(["not_sent"]);
    const d = harness({ result: { ok: true, ack: ack({ status: "duplicate" }) } });
    await d.pipeline.handleRawEvent(swipe());
    expect(d.feedback.cues).toEqual(["signal_sent"]);
  });

  it("normalizes both gestureName and gesture_name spellings", async () => {
    const h = harness();
    await h.pipeline.handleRawEvent({ gestureName: BACK });
    h.state.now += GESTURE_DEBOUNCE_MS;
    await h.pipeline.handleRawEvent({ gesture_name: BACK });
    expect(h.submit).toHaveBeenCalledTimes(2);
  });
});

describe("pipeline: gesture filtering", () => {
  it.each(["swipe_forward", "tap", "double_tap", "triple_tap", "long_press", "mystery", "SWIPE_BACKWARD", "swipe_backward_2", "swipe_backward!", "swipe"])(
    "%s does nothing",
    async (name) => {
      const h = harness();
      const out = await h.pipeline.handleRawEvent(swipe(name));
      expect(out).toMatchObject({ kind: "ignored", reason: "not_backward_swipe" });
      expect(h.submit).not.toHaveBeenCalled();
      expect(h.feedback.cues).toEqual([]);
    },
  );

  it("backwardSwipeGestureName null never submits", async () => {
    const h = harness({ backward: null });
    for (const name of [BACK, "swipe_forward", "tap", "null"]) {
      h.state.now += 5000;
      await h.pipeline.handleRawEvent(swipe(name));
    }
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.feedback.cues).toEqual([]);
  });

  it("calibration mode logs the raw name and never submits", async () => {
    const lines: string[] = [];
    const { createLogger } = await import("./logger");
    const submit = vi.fn();
    const pipeline = new GesturePipeline({
      mapping: { backwardSwipeGestureName: BACK },
      calibration: true,
      context: () => ({ state: "ready", encounterSessionId: SESSION_ID }),
      submit,
      feedback: recordingFeedback(),
      logger: createLogger((_l, line) => lines.push(line)),
    });
    const out = await pipeline.handleRawEvent(swipe(BACK));
    await pipeline.handleRawEvent(swipe("weird_name"));
    expect(out).toMatchObject({ kind: "ignored", reason: "calibration_mode" });
    expect(submit).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("weird_name"))).toBe(true);
    expect(lines.some((l) => l.includes(BACK))).toBe(true);
  });

  it.each([null, undefined, "swipe_backward", 5, {}, { gestureName: "" }, { gestureName: 3 }, { name: BACK }])(
    "malformed payload %j is ignored",
    async (payload) => {
      const h = harness();
      expect(await h.pipeline.handleRawEvent(payload)).toMatchObject({ kind: "ignored", reason: "malformed_event" });
      expect(h.submit).not.toHaveBeenCalled();
    },
  );
});

describe("pipeline: debounce and in-flight", () => {
  it("drops within 1000 ms, accepts at >= 1000 ms, distinct eventIds", async () => {
    const h = harness();
    await h.pipeline.handleRawEvent(swipe());
    h.state.now += GESTURE_DEBOUNCE_MS - 1;
    expect(await h.pipeline.handleRawEvent(swipe())).toMatchObject({ kind: "ignored", reason: "debounced" });
    h.state.now += 1;
    await h.pipeline.handleRawEvent(swipe());
    expect(h.submit).toHaveBeenCalledTimes(2);
    const [a, b] = h.submit.mock.calls.map((c) => c[0].eventId);
    expect(a).not.toBe(b);
  });

  it("drops a swipe while a submit is pending", async () => {
    let release!: (r: SubmitResult) => void;
    const submit = vi.fn(() => new Promise<SubmitResult>((r) => (release = r)));
    const feedback = recordingFeedback();
    let now = 1_800_000_000_000;
    const pipeline = new GesturePipeline({
      mapping: { backwardSwipeGestureName: BACK },
      calibration: false,
      context: () => ({ state: "ready", encounterSessionId: SESSION_ID }),
      submit,
      feedback,
      now: () => now,
    });
    const first = pipeline.handleRawEvent(swipe());
    now += 5000;
    expect(await pipeline.handleRawEvent(swipe())).toMatchObject({ kind: "ignored", reason: "submit_in_flight" });
    release({ ok: true, ack: ack() });
    await first;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(feedback.cues).toEqual(["signal_sent"]);
  });
});

describe("pipeline: mode gate", () => {
  it.each<[ContextSnapshot, string]>([
    [{ state: "encounter_mode_off" }, "encounter_mode_off"],
    [{ state: "unlinked" }, "unlinked"],
    [{ state: "offline" }, "offline"],
    [{ state: "stale" }, "context_stale"],
  ])("%j drops the swipe silently", async (context, reason) => {
    const h = harness({ context });
    expect(await h.pipeline.handleRawEvent(swipe())).toMatchObject({ kind: "ignored", reason });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.feedback.cues).toEqual([]);
  });

  it("a rejected-by-gate swipe does not consume the debounce window", async () => {
    const h = harness({ context: { state: "offline" } });
    await h.pipeline.handleRawEvent(swipe());
    h.state.context = { state: "ready", encounterSessionId: SESSION_ID };
    h.state.now += 10;
    await h.pipeline.handleRawEvent(swipe());
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("offline swipes are never replayed once context becomes ready", async () => {
    const h = harness({ context: { state: "offline" } });
    await h.pipeline.handleRawEvent(swipe());
    h.state.now += 3000;
    await h.pipeline.handleRawEvent(swipe());
    h.state.context = { state: "ready", encounterSessionId: SESSION_ID };
    h.state.now += 60_000;
    expect(h.submit).not.toHaveBeenCalled();
    await h.pipeline.handleRawEvent(swipe());
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("encounter mode off then on does not replay, via a real tracker", async () => {
    let result: ContextFetchResult = {
      ok: true,
      context: { deviceId: DEVICE_ID, encounterMode: false, encounterSessionId: null, serverTime: "2026-11-14T10:00:00.000Z" },
    };
    let now = 1_800_000_000_000;
    const tracker = new EncounterContextTracker(async () => result, () => now);
    const submit = vi.fn(async (): Promise<SubmitResult> => ({ ok: true, ack: ack() }));
    const pipeline = new GesturePipeline({
      mapping: { backwardSwipeGestureName: BACK },
      calibration: false,
      context: () => tracker.snapshot(),
      submit,
      feedback: recordingFeedback(),
      now: () => now,
    });
    await tracker.refresh();
    await pipeline.handleRawEvent(swipe());
    now += 2000;
    result = { ok: true, context: { deviceId: DEVICE_ID, encounterMode: true, encounterSessionId: SESSION_ID, serverTime: "2026-11-14T10:00:00.000Z" } };
    await tracker.refresh();
    expect(tracker.snapshot()).toEqual({ state: "ready", encounterSessionId: SESSION_ID });
    expect(submit).not.toHaveBeenCalled();
    now += 2000;
    await pipeline.handleRawEvent(swipe());
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("pipeline: failed submit", () => {
  it("network failure -> failed outcome, not_sent, and no resend on later context change", async () => {
    const h = harness({ result: { ok: false, error: "network" } });
    const out = await h.pipeline.handleRawEvent(swipe());
    expect(out).toMatchObject({ kind: "failed", error: "network", cue: "not_sent" });
    expect(h.feedback.cues).toEqual(["not_sent"]);
    h.state.context = { state: "offline" };
    h.state.context = { state: "ready", encounterSessionId: SESSION_ID };
    h.state.now += 60_000;
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("a throwing submit is treated as network failure", async () => {
    const feedback = recordingFeedback();
    const pipeline = new GesturePipeline({
      mapping: { backwardSwipeGestureName: BACK },
      calibration: false,
      context: () => ({ state: "ready", encounterSessionId: SESSION_ID }),
      submit: async () => {
        throw new Error("boom");
      },
      feedback,
    });
    expect(await pipeline.handleRawEvent(swipe())).toMatchObject({ kind: "failed", error: "network" });
    expect(feedback.cues).toEqual(["not_sent"]);
  });

  it("end to end with the api client: rejected and duplicate acks produce cues", async () => {
    for (const [a, cue] of [
      [ack({ status: "rejected", reason: "not_in_session", expiresAt: null }), "not_sent"],
      [ack({ status: "duplicate" }), "signal_sent"],
    ] as const) {
      const client = new CueApiClient({ baseUrl: "https://x", getToken: () => "t".repeat(40), fetch: fakeFetch([json(a)]) });
      const feedback = recordingFeedback();
      const pipeline = new GesturePipeline({
        mapping: { backwardSwipeGestureName: BACK },
        calibration: false,
        context: () => ({ state: "ready", encounterSessionId: SESSION_ID }),
        submit: (e) => client.submitInterest(e),
        feedback,
      });
      await pipeline.handleRawEvent(swipe());
      expect(feedback.cues).toEqual([cue]);
    }
  });
});

describe("cueForAck", () => {
  const cases: [Partial<InterestAck>, string][] = [
    [{ status: "accepted", matched: false }, "signal_sent"],
    [{ status: "accepted", matched: true }, "match"],
    [{ status: "duplicate", matched: false }, "signal_sent"],
    [{ status: "duplicate", matched: true }, "match"],
    [{ status: "rejected", matched: false, reason: "blocked" }, "not_sent"],
    [{ status: "rejected", matched: true, reason: "already_matched" }, "not_sent"],
  ];
  it.each(cases)("%j -> %s", (overrides, cue) => {
    expect(cueForAck(ack(overrides))).toBe(cue);
  });
});
