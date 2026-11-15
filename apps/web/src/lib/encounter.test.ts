import { InterestEvent, type EncounterStatus, type PendingSignal } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import {
  buildInterestEvent,
  deriveSignalView,
  effectivePendingSignal,
  formatCountdown,
  groupPairingCode,
  joinCodeProblem,
  normalizeJoinCode,
  occupancyText,
  rejectionCopy,
  signalSourceText,
  spellCode,
  venueLabelProblem,
} from "./encounter";

const T0 = Date.parse("2026-11-14T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_ID = "7b0f5c0e-5c59-4c0f-9d5e-0d7a0e6f3a11";
const EVENT_ID = "2f1d8f3a-91c4-4f0b-8a55-6f1f0c7a9e22";

function status(over: Partial<EncounterStatus> = {}, memberCount = 2): EncounterStatus {
  return {
    session: {
      id: SESSION_ID,
      joinCode: "AB12CD",
      venueLabel: "Main hall",
      venueLabelSource: "manual",
      memberCount,
      capacity: 2,
      createdAt: iso(T0 - 60_000),
    },
    encounterMode: true,
    pendingSignal: null,
    device: { linked: false, deviceId: null, deviceLabel: null, lastSeenAt: null },
    serverTime: iso(T0),
    ...over,
  };
}

function signal(receivedMs: number, source: PendingSignal["source"] = "web_demo"): PendingSignal {
  return {
    eventId: EVENT_ID,
    source,
    receivedAt: iso(receivedMs),
    expiresAt: iso(receivedMs + 15_000),
  };
}

describe("deriveSignalView", () => {
  it("is no_session without a session", () => {
    expect(deriveSignalView(status({ session: null }), T0)).toEqual({ kind: "no_session" });
  });

  it("is paused when encounter mode is off, even with a signal still on the server", () => {
    const s = status({ encounterMode: false, pendingSignal: signal(T0) });
    expect(deriveSignalView(s, T0 + 1000)).toEqual({ kind: "paused" });
  });

  it("is idle with both people present and no signal", () => {
    expect(deriveSignalView(status(), T0)).toEqual({ kind: "idle" });
  });

  it("waits for the second person when only one member is present", () => {
    expect(deriveSignalView(status({}, 1), T0)).toEqual({ kind: "waiting_for_partner" });
  });

  it("shows an own pending signal with whole seconds left and the remaining fraction", () => {
    const s = status({ pendingSignal: signal(T0, "mentra_touch") });
    expect(deriveSignalView(s, T0 + 4_200)).toEqual({
      kind: "pending",
      eventId: EVENT_ID,
      source: "mentra_touch",
      secondsLeft: 11,
      fraction: 10_800 / 15_000,
    });
  });

  it("keeps showing 1 second until the very end, then goes idle at expiry", () => {
    const s = status({ pendingSignal: signal(T0) });
    expect(deriveSignalView(s, T0 + 14_999)).toMatchObject({ kind: "pending", secondsLeft: 1 });
    expect(deriveSignalView(s, T0 + 15_000)).toEqual({ kind: "idle" });
  });

  it("treats a signal the server still returns after its expiry as idle", () => {
    const s = status({ pendingSignal: signal(T0 - 60_000) });
    expect(deriveSignalView(s, T0)).toEqual({ kind: "idle" });
  });
});

describe("effectivePendingSignal", () => {
  const acked = signal(T0 + 500);

  it("uses the optimistic signal only until a newer server status arrives", () => {
    expect(effectivePendingSignal(status(), acked)).toBe(acked);
    // Fetched after the ack and the signal is gone (matched or reset): drop it.
    expect(effectivePendingSignal(status({ serverTime: iso(T0 + 900) }), acked)).toBeNull();
  });

  it("prefers the server's signal", () => {
    const server = signal(T0, "mentra_touch");
    expect(effectivePendingSignal(status({ pendingSignal: server }), acked)).toBe(server);
  });
});

describe("join code and venue label", () => {
  it("normalises codes to uppercase without whitespace", () => {
    expect(normalizeJoinCode("  ab 12cd \n")).toBe("AB12CD");
  });

  it("checks code length against the contract (4 to 12)", () => {
    expect(joinCodeProblem("")).not.toBeNull();
    expect(joinCodeProblem("ABC")).not.toBeNull();
    expect(joinCodeProblem("ABCD")).toBeNull();
    expect(joinCodeProblem("ABCDEFGHIJKL")).toBeNull();
    expect(joinCodeProblem("ABCDEFGHIJKLM")).not.toBeNull();
  });

  it("requires a venue label of 1 to 80 characters after trimming", () => {
    expect(venueLabelProblem("   ")).not.toBeNull();
    expect(venueLabelProblem(" Main hall ")).toBeNull();
    expect(venueLabelProblem("x".repeat(80))).toBeNull();
    expect(venueLabelProblem("x".repeat(81))).not.toBeNull();
  });

  it("describes occupancy in words", () => {
    expect(occupancyText({ memberCount: 1, capacity: 2 })).toMatch(/^Just you so far/);
    expect(occupancyText({ memberCount: 2, capacity: 2 })).toBe("Both of you are here.");
  });
});

describe("buildInterestEvent", () => {
  it("builds exactly the strict contract body for the web button", () => {
    const event = buildInterestEvent(SESSION_ID, EVENT_ID, new Date(T0));
    expect(event).toEqual({
      eventId: EVENT_ID,
      encounterSessionId: SESSION_ID,
      source: "web_demo",
      gesture: "web_confirm",
      occurredAt: "2026-11-14T18:00:00.000Z",
    });
    expect(InterestEvent.safeParse(event).success).toBe(true);
  });

  it("uses a fresh event id per call", () => {
    expect(buildInterestEvent(SESSION_ID).eventId).not.toBe(buildInterestEvent(SESSION_ID).eventId);
  });
});

describe("copy helpers", () => {
  it("names where the signal came from", () => {
    expect(signalSourceText("mentra_touch")).toBe("Sent from your glasses");
    expect(signalSourceText("headset_remote")).toBe("Sent from your glasses");
    expect(signalSourceText("spectacles_hand")).toBe("Sent from your glasses");
    expect(signalSourceText("web_demo")).toBe("Sent from this page");
  });

  it("maps rejection reasons", () => {
    expect(rejectionCopy("already_matched")).toMatchObject({ matchesLink: true, refresh: false });
    expect(rejectionCopy("session_inactive")).toMatchObject({ refresh: true });
    expect(rejectionCopy("invalid_event").text).toMatch(/try again/);
    expect(rejectionCopy(null).text).toMatch(/try again/);
  });

  it("formats pairing codes and countdowns", () => {
    expect(groupPairingCode("ABC123")).toBe("ABC 123");
    expect(spellCode("AB1")).toBe("A B 1");
    expect(formatCountdown(125)).toBe("2:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});
