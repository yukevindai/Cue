import { describe, expect, it } from "vitest";
import {
  distanceM,
  EARTH_RADIUS_M,
  locationUsable,
  presenceReady,
  presenceVenue,
  withinRadius,
  type PhoneLocation,
  type Presence,
} from "./index";

// Synthetic coordinates only: small offsets around latitude 0, longitude 0.
const NOW = new Date("2026-11-14T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
/** Metres per degree along the equator / a meridian for this radius. */
const M_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;
const loc = (northM: number, eastM = 0, over: Partial<PhoneLocation> = {}): PhoneLocation => ({
  lat: northM / M_PER_DEG,
  lng: eastM / M_PER_DEG,
  accuracyM: 0,
  locatedAt: ago(1),
  ...over,
});

describe("distanceM", () => {
  it("is zero for the same point", () => {
    expect(distanceM(0, 0, 0, 0)).toBe(0);
  });
  it("one degree of latitude or of longitude at the equator is 2*pi*R/360", () => {
    expect(distanceM(0, 0, 1, 0)).toBeCloseTo(M_PER_DEG, 6);
    expect(distanceM(0, 0, 0, 1)).toBeCloseTo(M_PER_DEG, 6);
  });
  it("short offsets are metres as expected and symmetric", () => {
    const a = loc(30, 0);
    const b = loc(0, 40);
    expect(distanceM(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(50, 3);
    expect(distanceM(b.lat, b.lng, a.lat, a.lng)).toBeCloseTo(50, 3);
  });
  it("antipodes are half the circumference (asin clamp)", () => {
    expect(distanceM(0, 0, 0, 180)).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 3);
  });
});

describe("withinRadius", () => {
  it("40 m apart with exact fixes is in range; 41 m is not", () => {
    expect(withinRadius(loc(0), loc(40))).toBe(true);
    expect(withinRadius(loc(0), loc(41))).toBe(false);
  });
  it("both accuracies are allowed for", () => {
    expect(withinRadius(loc(0, 0, { accuracyM: 30 }), loc(99, 0, { accuracyM: 30 }))).toBe(true);
    expect(withinRadius(loc(0, 0, { accuracyM: 30 }), loc(101, 0, { accuracyM: 30 }))).toBe(false);
  });
});

describe("locationUsable", () => {
  it("fresh and accurate is usable", () => {
    expect(locationUsable(loc(0, 0, { accuracyM: 100, locatedAt: ago(59) }), NOW)).toBe(true);
  });
  it("exactly 60 s old is stale", () => {
    expect(locationUsable(loc(0, 0, { locatedAt: ago(60) }), NOW)).toBe(false);
  });
  it("worse than 100 m is not usable", () => {
    expect(locationUsable(loc(0, 0, { accuracyM: 100.5 }), NOW)).toBe(false);
  });
  it("no location is not usable", () => {
    expect(locationUsable(null, NOW)).toBe(false);
  });
});

describe("presenceVenue and presenceReady", () => {
  const venue = "11111111-0000-4000-8000-000000000000";
  const p = (over: Partial<Presence>): Presence => ({ encounterMode: true, checkIn: null, location: null, ...over });
  it("a check-in counts for under 8 hours", () => {
    expect(presenceVenue(p({ checkIn: { venueId: venue, active: true, checkedInAt: ago(8 * 3600 - 1) } }), NOW)).toBe(venue);
    expect(presenceVenue(p({ checkIn: { venueId: venue, active: true, checkedInAt: ago(8 * 3600) } }), NOW)).toBeNull();
  });
  it("an inactive venue does not count", () => {
    expect(presenceVenue(p({ checkIn: { venueId: venue, active: false, checkedInAt: ago(1) } }), NOW)).toBeNull();
  });
  it("ready needs mode on and a place", () => {
    expect(presenceReady(p({}), NOW)).toBe(false);
    expect(presenceReady(p({ location: loc(0) }), NOW)).toBe(true);
    expect(presenceReady(p({ encounterMode: false, location: loc(0) }), NOW)).toBe(false);
    expect(presenceReady(p({ checkIn: { venueId: venue, active: true, checkedInAt: ago(1) } }), NOW)).toBe(true);
    expect(presenceReady(p({ location: loc(0, 0, { locatedAt: ago(61) }) }), NOW)).toBe(false);
  });
});
