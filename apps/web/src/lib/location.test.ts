import { LOCATION_REPORT_INTERVAL_MS, LocationInput } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import {
  distanceM,
  geoErrorKind,
  geoProblemText,
  LOCATION_MIN_GAP_MS,
  locationLine,
  meaningfullyChanged,
  shouldReport,
  toLocationInput,
  type ReportState,
} from "./location";

// Synthetic positions near 0,0 only.
const HERE = { lat: 0.0001, lng: 0.0001, accuracyM: 10 };
const T0 = 1_000_000;

function st(over: Partial<ReportState> = {}): ReportState {
  return { latest: HERE, lastSent: null, lastAttemptAtMs: null, inFlight: false, ...over };
}

describe("toLocationInput", () => {
  it("builds a strict contract body", () => {
    const input = toLocationInput({
      coords: { latitude: 0.0001, longitude: -0.0002, accuracy: 8.5 },
      timestamp: T0,
    });
    expect(input).toEqual({ lat: 0.0001, lng: -0.0002, accuracyM: 8.5 });
    expect(LocationInput.safeParse(input).success).toBe(true);
  });

  it("refuses positions the contract would refuse", () => {
    const at = (latitude: number, longitude: number, accuracy: number) =>
      toLocationInput({ coords: { latitude, longitude, accuracy }, timestamp: T0 });
    expect(at(91, 0, 5)).toBeNull();
    expect(at(0, 181, 5)).toBeNull();
    expect(at(0, 0, -1)).toBeNull();
    expect(at(Number.NaN, 0, 5)).toBeNull();
    expect(at(0, 0, 5e9)?.accuracyM).toBe(1_000_000);
  });
});

describe("distanceM", () => {
  it("is about 11 m per 0.0001 degree at the equator", () => {
    expect(distanceM({ lat: 0, lng: 0 }, { lat: 0.0001, lng: 0 })).toBeCloseTo(11.1, 0);
    expect(distanceM(HERE, HERE)).toBe(0);
  });
});

describe("geoErrorKind", () => {
  it("maps the GeolocationPositionError codes", () => {
    expect(geoErrorKind(1)).toBe("denied");
    expect(geoErrorKind(2)).toBe("unavailable");
    expect(geoErrorKind(3)).toBe("timeout");
  });
});

describe("meaningfullyChanged", () => {
  it("counts a move of 10 m or more", () => {
    expect(meaningfullyChanged(HERE, { ...HERE, lat: HERE.lat + 0.00005 })).toBe(false);
    expect(meaningfullyChanged(HERE, { ...HERE, lat: HERE.lat + 0.0001 })).toBe(true);
  });

  it("counts crossing the accuracy limit and large accuracy changes", () => {
    expect(meaningfullyChanged({ ...HERE, accuracyM: 95 }, { ...HERE, accuracyM: 105 })).toBe(true);
    expect(meaningfullyChanged(HERE, { ...HERE, accuracyM: 14 })).toBe(false);
    expect(meaningfullyChanged(HERE, { ...HERE, accuracyM: 30 })).toBe(true);
  });
});

describe("shouldReport", () => {
  it("sends the first position straight away", () => {
    expect(shouldReport(st(), T0)).toBe(true);
  });

  it("does nothing without a position or while a report is in flight", () => {
    expect(shouldReport(st({ latest: null }), T0)).toBe(false);
    expect(shouldReport(st({ inFlight: true }), T0)).toBe(false);
  });

  it("re-sends an unchanged position at the report interval, so it never goes stale", () => {
    const s = st({ lastSent: { input: HERE, atMs: T0 }, lastAttemptAtMs: T0 });
    expect(shouldReport(s, T0 + LOCATION_REPORT_INTERVAL_MS - 1)).toBe(false);
    expect(shouldReport(s, T0 + LOCATION_REPORT_INTERVAL_MS)).toBe(true);
  });

  it("sends a meaningful change early, but never within the minimum gap", () => {
    const moved = { ...HERE, lat: HERE.lat + 0.001 };
    const s = st({ latest: moved, lastSent: { input: HERE, atMs: T0 }, lastAttemptAtMs: T0 });
    expect(shouldReport(s, T0 + LOCATION_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldReport(s, T0 + LOCATION_MIN_GAP_MS)).toBe(true);
  });

  it("waits the minimum gap after a failed attempt before trying again", () => {
    const s = st({ lastAttemptAtMs: T0 });
    expect(shouldReport(s, T0 + 1000)).toBe(false);
    expect(shouldReport(s, T0 + LOCATION_MIN_GAP_MS)).toBe(true);
  });
});

describe("geoProblemText", () => {
  it("points to venue check-in whenever location can't be used", () => {
    for (const kind of ["unsupported", "denied", "unavailable", "timeout"] as const) {
      expect(geoProblemText({ kind })).toMatch(/venue code/);
    }
    expect(geoProblemText({ kind: "off" })).toBeNull();
    expect(geoProblemText({ kind: "located", accuracyM: 10, fixAtMs: T0 })).toBeNull();
  });
});

describe("locationLine", () => {
  const located = { kind: "located" as const, accuracyM: 12, fixAtMs: T0 };

  it("is off while encounter mode is off", () => {
    expect(locationLine(false, located, "Location on, accurate to about 12 m").text).toMatch(/^Location off/);
  });

  it("puts this page's permission problems first, with a retry", () => {
    expect(locationLine(true, { kind: "denied" }, "Location on")).toMatchObject({ retry: true });
    expect(locationLine(true, { kind: "unsupported" }, null)).toMatchObject({ retry: false });
  });

  it("shows the server's status once there is one", () => {
    expect(locationLine(true, located, "Location on, accurate to about 12 m").text).toBe(
      "Location on, accurate to about 12 m",
    );
    expect(locationLine(true, located, null).text).toMatch(/Sending it to Cue/);
    expect(locationLine(true, { kind: "locating" }, null).text).toBe("Finding your location…");
  });

  it("says a rough position is too rough before the server answers", () => {
    expect(locationLine(true, { ...located, accuracyM: 350 }, null).text).toMatch(/about 350 m/);
  });
});
