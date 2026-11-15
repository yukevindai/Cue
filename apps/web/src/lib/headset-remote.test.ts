import { GESTURE_DEBOUNCE_MS, InterestEvent, type InterestAck } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import {
  buildQuietWavDataUrl,
  choiceForCommand,
  choiceLabel,
  decideCommand,
  DEFAULT_SIGNAL_CHOICE,
  gestureForCommand,
  ignoreReasonText,
  isEcho,
  MEDIA_COMMANDS,
  outcomeText,
  parseSignalChoice,
  pushRecent,
  toneForOutcome,
  type HeadsetState,
  type IgnoreReason,
  type MediaCommand,
} from "./headset-remote";

const T0 = Date.parse("2026-11-15T18:00:00.000Z");
const SESSION_ID = "7b0f5c0e-5c59-4c0f-9d5e-0d7a0e6f3a11";
const EVENT_ID = "2f1d8f3a-91c4-4f0b-8a55-6f1f0c7a9e22";
const newId = () => EVENT_ID;

function state(over: Partial<HeadsetState> = {}): HeadsetState {
  return {
    listening: true,
    choice: "nexttrack",
    session: { id: SESSION_ID, memberCount: 2, capacity: 2 },
    encounterMode: true,
    pending: false,
    lastSentAtMs: null,
    ...over,
  };
}

function ack(over: Partial<InterestAck> = {}): InterestAck {
  return {
    status: "accepted",
    eventId: EVENT_ID,
    receivedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 15_000).toISOString(),
    matched: false,
    reason: null,
    ...over,
  };
}

describe("command mapping", () => {
  it("maps each command to a contract gesture", () => {
    expect(gestureForCommand("play")).toBe("media_play_pause");
    expect(gestureForCommand("pause")).toBe("media_play_pause");
    expect(gestureForCommand("nexttrack")).toBe("media_next_track");
    expect(gestureForCommand("previoustrack")).toBe("media_previous_track");
  });

  it("treats play and pause as one choice", () => {
    expect(choiceForCommand("play")).toBe("playpause");
    expect(choiceForCommand("pause")).toBe("playpause");
    expect(choiceForCommand("nexttrack")).toBe("nexttrack");
  });

  it("defaults to double tap and survives junk in storage", () => {
    expect(DEFAULT_SIGNAL_CHOICE).toBe("nexttrack");
    expect(parseSignalChoice(null)).toBe("nexttrack");
    expect(parseSignalChoice("bogus")).toBe("nexttrack");
    expect(parseSignalChoice("previoustrack")).toBe("previoustrack");
    expect(parseSignalChoice("playpause")).toBe("playpause");
    expect(choiceLabel("nexttrack")).toBe("Double tap (next track)");
  });
});

describe("decideCommand", () => {
  it("sends the chosen command as a contract-valid headset_remote event", () => {
    const d = decideCommand("nexttrack", state(), T0, newId);
    expect(d.kind).toBe("send");
    if (d.kind !== "send") return;
    expect(d.event).toEqual({
      eventId: EVENT_ID,
      encounterSessionId: SESSION_ID,
      source: "headset_remote",
      gesture: "media_next_track",
      occurredAt: "2026-11-15T18:00:00.000Z",
    });
    expect(InterestEvent.safeParse(d.event).success).toBe(true);
  });

  it("uses a fresh event id by default", () => {
    const a = decideCommand("nexttrack", state(), T0);
    const b = decideCommand("nexttrack", state(), T0);
    expect(a.kind === "send" && b.kind === "send" && a.event.eventId !== b.event.eventId).toBe(true);
  });

  it("every command yields a contract-valid event when it is the choice", () => {
    for (const command of MEDIA_COMMANDS) {
      const d = decideCommand(command, state({ choice: choiceForCommand(command) }), T0, newId);
      expect(d.kind).toBe("send");
      if (d.kind === "send") expect(InterestEvent.safeParse(d.event).success).toBe(true);
    }
  });

  it("ignores other commands with a reason", () => {
    for (const command of ["play", "pause", "previoustrack"] as MediaCommand[]) {
      expect(decideCommand(command, state(), T0, newId)).toEqual({
        kind: "ignored",
        reason: "not_chosen",
      });
    }
  });

  it("play and pause both count when single tap is the choice", () => {
    const s = state({ choice: "playpause" });
    const play = decideCommand("play", s, T0, newId);
    const pause = decideCommand("pause", s, T0, newId);
    expect(play.kind).toBe("send");
    expect(pause.kind).toBe("send");
    if (play.kind === "send") expect(play.event.gesture).toBe("media_play_pause");
    expect(decideCommand("nexttrack", s, T0, newId)).toMatchObject({ reason: "not_chosen" });
  });

  it("ignores while not listening", () => {
    expect(decideCommand("nexttrack", state({ listening: false }), T0, newId)).toEqual({
      kind: "ignored",
      reason: "not_listening",
    });
  });

  it("ignores without a session, or before the second person joins", () => {
    expect(decideCommand("nexttrack", state({ session: null }), T0, newId)).toMatchObject({
      reason: "no_session",
    });
    expect(
      decideCommand(
        "nexttrack",
        state({ session: { id: SESSION_ID, memberCount: 1, capacity: 2 } }),
        T0,
        newId,
      ),
    ).toMatchObject({ reason: "session_not_full" });
  });

  it("ignores while encounter mode is off", () => {
    expect(decideCommand("nexttrack", state({ encounterMode: false }), T0, newId)).toMatchObject({
      reason: "encounter_mode_off",
    });
  });

  it("ignores while a signal is already pending", () => {
    expect(decideCommand("nexttrack", state({ pending: true }), T0, newId)).toMatchObject({
      reason: "already_pending",
    });
  });

  it("debounces repeats inside the window and accepts after it", () => {
    const s = state({ lastSentAtMs: T0 });
    expect(decideCommand("nexttrack", s, T0 + GESTURE_DEBOUNCE_MS - 1, newId)).toMatchObject({
      reason: "debounced",
    });
    expect(decideCommand("nexttrack", s, T0 + GESTURE_DEBOUNCE_MS, newId).kind).toBe("send");
  });

  it("a single tap reaching the page twice (handler, then element pause) sends once", () => {
    const s = state({ choice: "playpause" });
    const first = decideCommand("pause", s, T0, newId);
    expect(first.kind).toBe("send");
    // The send failed fast, so nothing is pending, but the echo is still caught.
    const second = decideCommand("pause", { ...s, lastSentAtMs: T0 }, T0 + 60, newId);
    expect(second).toEqual({ kind: "ignored", reason: "debounced" });
  });
});

describe("isEcho", () => {
  const prev = { id: 1, command: "pause" as const, origin: "handler" as const, atMs: T0 };

  it("folds a handler + element pause for one tap", () => {
    expect(isEcho(prev, "pause", "element", T0 + 80)).toBe(true);
    expect(isEcho({ ...prev, origin: "element" }, "play", "handler", T0 + 80)).toBe(true);
  });

  it("keeps separate taps, same-origin repeats and other commands", () => {
    expect(isEcho(prev, "pause", "element", T0 + GESTURE_DEBOUNCE_MS)).toBe(false);
    expect(isEcho(prev, "pause", "handler", T0 + 80)).toBe(false);
    expect(isEcho(prev, "nexttrack", "handler", T0 + 80)).toBe(false);
    expect(isEcho({ ...prev, command: "nexttrack" }, "pause", "element", T0 + 80)).toBe(false);
    expect(isEcho(null, "pause", "element", T0)).toBe(false);
  });
});

describe("copy and feedback", () => {
  it("has text for every ignore reason", () => {
    const reasons: IgnoreReason[] = [
      "not_listening",
      "not_chosen",
      "no_session",
      "session_not_full",
      "encounter_mode_off",
      "already_pending",
      "debounced",
    ];
    for (const r of reasons) expect(ignoreReasonText(r, "nexttrack").length).toBeGreaterThan(5);
    expect(outcomeText({ kind: "ignored", reason: "not_chosen" }, "nexttrack")).toBe(
      "Ignored: not your signal. Yours is double tap (next track).",
    );
  });

  it("describes every ack", () => {
    expect(outcomeText({ kind: "sent", ack: ack() }, "nexttrack")).toBe("Sent. Your signal is out.");
    expect(outcomeText({ kind: "sent", ack: ack({ matched: true }) }, "nexttrack")).toBe(
      "Sent. It's a match.",
    );
    expect(outcomeText({ kind: "sent", ack: ack({ status: "duplicate" }) }, "nexttrack")).toBe(
      "Sent, but your signal was already out.",
    );
    expect(
      outcomeText(
        { kind: "sent", ack: ack({ status: "rejected", reason: "encounter_mode_off" }) },
        "nexttrack",
      ),
    ).toBe("Not sent. Encounter mode is paused. Resume to signal.");
    expect(outcomeText({ kind: "failed", detail: "No connection." }, "nexttrack")).toBe(
      "Not sent. No connection.",
    );
  });

  it("plays sent / not-sent tones, and stays quiet for stray taps and matches", () => {
    expect(toneForOutcome({ kind: "sent", ack: ack() })).toBe("sent");
    expect(toneForOutcome({ kind: "sent", ack: ack({ matched: true }) })).toBeNull();
    expect(toneForOutcome({ kind: "sent", ack: ack({ status: "rejected", reason: "blocked" }) })).toBe(
      "not_sent",
    );
    expect(toneForOutcome({ kind: "failed", detail: "x" })).toBe("not_sent");
    expect(toneForOutcome({ kind: "unconfirmed" })).toBe("not_sent");
    expect(outcomeText({ kind: "unconfirmed" }, "nexttrack")).toMatch(/^Not confirmed\./);
    expect(toneForOutcome({ kind: "ignored", reason: "encounter_mode_off" })).toBe("not_sent");
    expect(toneForOutcome({ kind: "ignored", reason: "already_pending" })).toBe("not_sent");
    expect(toneForOutcome({ kind: "ignored", reason: "not_chosen" })).toBeNull();
    expect(toneForOutcome({ kind: "ignored", reason: "debounced" })).toBeNull();
  });

  it("keeps the newest few commands", () => {
    let list: number[] = [];
    for (let i = 1; i <= 7; i++) list = pushRecent(list, i, 5);
    expect(list).toEqual([7, 6, 5, 4, 3]);
  });
});

describe("buildQuietWavDataUrl", () => {
  it("builds a quiet but not silent PCM WAV", () => {
    const url = buildQuietWavDataUrl({ seconds: 0.5, sampleRate: 8000 });
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    const v = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(40, true)).toBe(8000); // 4000 samples * 2 bytes
    let peak = 0;
    for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)));
    expect(peak).toBeGreaterThan(0);
    // About -50 dBFS: 32767 * 10^(-50/20) ~= 104.
    expect(peak).toBeGreaterThan(90);
    expect(peak).toBeLessThan(120);
  });
});
