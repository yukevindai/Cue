import { must, type Api } from "./api";

/** A synthetic point. Never a real place. */
export interface Spot {
  lat: number;
  lng: number;
}

/** Metres per degree of latitude for the sphere the server's `distance_m` uses. */
export const M_PER_DEG_LAT = (2 * Math.PI * 6371008.8) / 360;

/**
 * A fresh, isolated test spot: a random point within about +-0.45 degrees of
 * latitude 0, longitude 0 (open sea). Tests share one database, so each test
 * takes its own spot and never meets leftovers from another.
 */
export function freshSpot(): Spot {
  const r = () => (Math.random() - 0.5) * 0.9;
  return { lat: r(), lng: r() };
}

/** `spot` moved `m` metres north (exact along a meridian; negative goes south). */
export function metresNorth(spot: Spot, m: number): Spot {
  return { lat: spot.lat + m / M_PER_DEG_LAT, lng: spot.lng };
}

/** Reports a phone location for `person` (accuracy defaults to 5 m) and returns the parsed status. */
export async function locate(person: { api: Api }, spot: Spot & { accuracyM?: number }, accuracyM?: number) {
  const body = { lat: spot.lat, lng: spot.lng, accuracyM: accuracyM ?? spot.accuracyM ?? 5 };
  return must(await person.api.setLocation(body), "setLocation");
}

/** Strings that must not appear in any response: the coordinates (several roundings) of the given spots. */
export function coordinateNeedles(...spots: Spot[]): string[] {
  const out = new Set<string>();
  for (const s of spots) {
    for (const v of [s.lat, s.lng]) {
      out.add(String(v));
      out.add(v.toFixed(4));
    }
  }
  return [...out];
}

/**
 * Asserts-by-return: the first problem found in a response text, or null.
 * Coordinates must never be returned, not even to their owner.
 */
export function coordinateLeak(text: string, spots: Spot[]): string | null {
  if (/"(lat|lng|latitude|longitude)"/i.test(text)) return "response contains a lat/lng key";
  for (const needle of coordinateNeedles(...spots)) {
    if (text.includes(needle)) return `response contains coordinate ${needle}`;
  }
  return null;
}
