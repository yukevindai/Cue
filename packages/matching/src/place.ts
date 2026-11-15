import {
  CHECK_IN_HOURS,
  LOCATION_MAX_ACCURACY_M,
  LOCATION_MAX_AGE_SECONDS,
  MATCH_RADIUS_M,
} from "@cue/contracts";

/** Mean Earth radius in metres; the same constant as SQL `distance_m`. */
export const EARTH_RADIUS_M = 6371008.8;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). Mirrors SQL `public.distance_m`. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const h =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type VenueCheckIn = {
  venueId: string;
  /** `venues.active`. */
  active: boolean;
  checkedInAt: Date;
};

export type PhoneLocation = {
  lat: number;
  lng: number;
  accuracyM: number;
  locatedAt: Date;
};

/** One `user_presence` row. */
export type Presence = {
  encounterMode: boolean;
  checkIn: VenueCheckIn | null;
  location: PhoneLocation | null;
};

/** The venue a presence is validly checked into at `now`, or null. Mirrors SQL `_presence_venue`. */
export function presenceVenue(p: Presence, now: Date): string | null {
  const c = p.checkIn;
  if (!c || !c.active) return null;
  return c.checkedInAt.getTime() > now.getTime() - CHECK_IN_HOURS * 3600_000 ? c.venueId : null;
}

/** A location fresh and accurate enough to match on. Mirrors SQL `_presence_located`. */
export function locationUsable(loc: PhoneLocation | null, now: Date): loc is PhoneLocation {
  return (
    loc !== null &&
    loc.locatedAt.getTime() > now.getTime() - LOCATION_MAX_AGE_SECONDS * 1000 &&
    loc.accuracyM <= LOCATION_MAX_ACCURACY_M
  );
}

/** Two usable locations are close enough once both accuracies are allowed for. */
export function withinRadius(a: PhoneLocation, b: PhoneLocation): boolean {
  const d = distanceM(a.lat, a.lng, b.lat, b.lng);
  return Math.max(0, d - a.accuracyM - b.accuracyM) <= MATCH_RADIUS_M;
}

/** Ready: encounter mode on and Cue has a place (venue or usable location). Mirrors `presence_state.ready`. */
export function presenceReady(p: Presence, now: Date): boolean {
  return p.encounterMode && (presenceVenue(p, now) !== null || locationUsable(p.location, now));
}
