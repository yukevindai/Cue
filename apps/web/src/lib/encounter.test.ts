import { InterestEvent, type EncounterStatus, type PendingSignal } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import {
  buildInterestEvent,
  deriveSignalView,
  effectivePendingSignal,
  formatCountdown,
  groupPairingCode,
  normalizeVenueCode,
  placeSummary,
  rejectionCopy,
  safeReturnPath,
  serverLocationText,
  signalSourceText,
  spellCode,
  venueCheckInUrl,
  venueCodeProblem,
  venueNameProblem,
} from "./encounter";

const T0 = Date.parse("2026-11-14T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const VENUE_ID = "7b0f5c0e-5c59-4c0f-9d5e-0d7a0e6f3a11";
const EVENT_ID = "2f1d8f3a-91c4-4f0b-8a55-6f1f0c7a9e22";

const CHECK_IN = {
  venueId: VENUE_ID,
  name: "Main hall",
  code: "AB3K7Q",
  checkedInAt: iso(T0 - 60_000),
  expiresAt: iso(T0 + 8 * 3600_000),
};

function status(over: Partial<EncounterStatus> = {}): EncounterStatus {
  return {
    encounterMode: true,
    checkIn: null,
    location: { status: "fresh", accuracyM: 12, locatedAt: iso(T0 - 2_000) },
    ready: true,
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
  it("is paused when encounter mode is off, even with a signal still on the server", () => {
    const s = status({ encounterMode: false, pendingSignal: signal(T0) });
    expect(deriveSignalView(s, T0 + 1000)).toEqual({ kind: "paused" });
  });

  it("is idle when ready and no signal is out", () => {
    expect(deriveSignalView(status(), T0)).toEqual({ kind: "idle" });
  });

  it("is no_place while Cue doesn't know where the person is", () => {
    const s = status({ ready: false, location: { status: "none", accuracyM: null, locatedAt: null } });
    expect(deriveSignalView(s, T0)).toEqual({ kind: "no_place" });
  });

  it("still shows an own pending signal if the place lapses meanwhile", () => {
    const s = status({ ready: false, pendingSignal: signal(T0) });
    expect(deriveSignalView(s, T0 + 1000)).toMatchObject({ kind: "pending" });
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

describe("venue code and name", () => {
  it("normalises codes to uppercase without spaces or dashes, at most 6", () => {
    expect(normalizeVenueCode("  ab3 k-7q \n")).toBe("AB3K7Q");
    expect(normalizeVenueCode("ab3k7qzz")).toBe("AB3K7Q");
  });

  it("asks for exactly 6 letters or numbers", () => {
    expect(venueCodeProblem("")).not.toBeNull();
    expect(venueCodeProblem("AB3K7")).toMatch(/6 characters/);
    expect(venueCodeProblem("AB3K7?")).toMatch(/letters and numbers/);
    expect(venueCodeProblem("AB3K7Q")).toBeNull();
  });

  it("requires a name of 1 to 80 characters after trimming", () => {
    expect(venueNameProblem("   ")).not.toBeNull();
    expect(venueNameProblem(" Main hall ")).toBeNull();
    expect(venueNameProblem("x".repeat(80))).toBeNull();
    expect(venueNameProblem("x".repeat(81))).not.toBeNull();
  });

  it("builds the URL a venue's QR code opens", () => {
    expect(venueCheckInUrl("https://cue.example/", "AB3K7Q")).toBe("https://cue.example/v/AB3K7Q");
  });
});

describe("place", () => {
  it("is off while encounter mode is off, whatever else is known", () => {
    expect(placeSummary(status({ encounterMode: false, ready: false, checkIn: CHECK_IN })).tone).toBe(
      "off",
    );
  });

  it("is ready when the server says so, naming the venue when checked in", () => {
    expect(placeSummary(status())).toMatchObject({ tone: "ready", headline: "Ready to signal" });
    expect(placeSummary(status({ checkIn: CHECK_IN })).detail).toMatch(/checked in at Main hall/);
  });

  it("says Cue doesn't know where you are when not ready", () => {
    expect(placeSummary(status({ ready: false }))).toMatchObject({
      tone: "not_ready",
      headline: "Cue doesn't know where you are yet",
    });
  });

  it("describes the server's location status without coordinates", () => {
    expect(serverLocationText(status())).toBe("Location on, accurate to about 12 m");
    expect(
      serverLocationText(
        status({ location: { status: "inaccurate", accuracyM: 240.4, locatedAt: iso(T0) } }),
      ),
    ).toMatch(/about 240 m\. Cue needs 100 m or better/);
    expect(
      serverLocationText(status({ location: { status: "stale", accuracyM: 12, locatedAt: iso(T0) } })),
    ).toMatch(/out of date/);
    expect(
      serverLocationText(status({ location: { status: "none", accuracyM: null, locatedAt: null } })),
    ).toBeNull();
  });
});

describe("safeReturnPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeReturnPath("/v/AB3K7Q")).toBe("/v/AB3K7Q");
    expect(safeReturnPath("/matches?x=1#y")).toBe("/matches?x=1#y");
  });

  it("refuses anything that could leave the site, and auth pages", () => {
    for (const bad of [
      null,
      "",
      "v/AB3K7Q",
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/\tevil",
      "javascript:alert(1)",
      "/sign-in",
      "/sign-up?next=/x",
    ]) {
      expect(safeReturnPath(bad)).toBe("/encounter");
    }
  });
});

describe("buildInterestEvent", () => {
  it("builds exactly the strict contract body for the web button, with no place", () => {
    const event = buildInterestEvent(EVENT_ID, new Date(T0));
    expect(event).toEqual({
      eventId: EVENT_ID,
      source: "web_demo",
      gesture: "web_confirm",
      occurredAt: "2026-11-14T18:00:00.000Z",
    });
    expect(InterestEvent.safeParse(event).success).toBe(true);
  });

  it("uses a fresh event id per call", () => {
    expect(buildInterestEvent().eventId).not.toBe(buildInterestEvent().eventId);
  });
});

describe("copy helpers", () => {
  it("names where the signal came from", () => {
    expect(signalSourceText("mentra_touch")).toBe("Sent from your glasses");
    expect(signalSourceText("headset_remote")).toBe("Sent from your glasses");
    expect(signalSourceText("spectacles_hand")).toBe("Sent from your glasses");
    expect(signalSourceText("web_demo")).toBe("Sent from this page");
  });

  it("maps rejection reasons to a next step", () => {
    expect(rejectionCopy("no_place").text).toMatch(/venue code/);
    expect(rejectionCopy("encounter_mode_off").text).toMatch(/Turn it on/);
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
