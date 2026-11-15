import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { InterestSource } from "./interest";

/**
 * Where a match's place label came from.
 * - `venue_checkin`: both people were checked into the same venue; the label is its name.
 * - `phone_location`: their phones were close together; the label is just "Nearby".
 * - `manual`: typed in by an organizer (matches made in the earlier demo sessions).
 * A match never carries coordinates.
 */
export const VenueLabelSource = z.enum(["manual", "venue_checkin", "phone_location"]);
export type VenueLabelSource = z.infer<typeof VenueLabelSource>;

/** Label stored on a match made by phone location. */
export const NEARBY_LABEL = "Nearby";

/** Six characters, no look-alikes (0/O, 1/I). Printed in the venue's QR code. */
export const VENUE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const VenueCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/);

/** Path of the page a venue's QR code opens. */
export const venueCheckInPath = (code: string) => `/v/${code}`;

/** The venue the caller is checked into. */
export const CheckIn = z.object({
  venueId: Uuid,
  name: z.string(),
  code: z.string(),
  checkedInAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type CheckIn = z.infer<typeof CheckIn>;

/**
 * What Cue currently knows about the caller's phone location. Coordinates are
 * never returned, not even to their owner.
 * - `none`: nothing stored.
 * - `fresh`: usable for matching.
 * - `stale`: older than LOCATION_MAX_AGE_SECONDS.
 * - `inaccurate`: worse than LOCATION_MAX_ACCURACY_M.
 */
export const LocationStatus = z.enum(["none", "fresh", "stale", "inaccurate"]);
export type LocationStatus = z.infer<typeof LocationStatus>;

export const LocationState = z.object({
  status: LocationStatus,
  accuracyM: z.number().nonnegative().nullable(),
  locatedAt: IsoDateTime.nullable(),
});
export type LocationState = z.infer<typeof LocationState>;

/** The user's OWN pending signal only. Incoming one-sided interest is never exposed. */
export const PendingSignal = z.object({
  eventId: Uuid,
  source: InterestSource,
  receivedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type PendingSignal = z.infer<typeof PendingSignal>;

export const DeviceStatus = z.object({
  linked: z.boolean(),
  deviceId: Uuid.nullable(),
  deviceLabel: z.string().nullable(),
  /** Last time the glasses bridge checked in or sent an event. */
  lastSeenAt: IsoDateTime.nullable(),
});
export type DeviceStatus = z.infer<typeof DeviceStatus>;

/** GET /api/encounter */
export const EncounterStatus = z.object({
  encounterMode: z.boolean(),
  checkIn: CheckIn.nullable(),
  location: LocationState,
  /** Encounter mode is on and Cue has a place for the caller: a signal can match now. */
  ready: z.boolean(),
  pendingSignal: PendingSignal.nullable(),
  device: DeviceStatus,
  serverTime: IsoDateTime,
});
export type EncounterStatus = z.infer<typeof EncounterStatus>;

/** POST /api/encounter/mode */
export const EncounterModeInput = z.object({ enabled: z.boolean() });
export type EncounterModeInput = z.infer<typeof EncounterModeInput>;

/**
 * POST /api/encounter/location — the phone's current position, from the
 * browser's geolocation. Kept only while encounter mode is on.
 */
export const LocationInput = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().nonnegative().max(1_000_000),
  })
  .strict();
export type LocationInput = z.infer<typeof LocationInput>;

/** POST /api/venues — create a venue and check into it. */
export const CreateVenueInput = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateVenueInput = z.infer<typeof CreateVenueInput>;

/** POST /api/venues/check-in */
export const CheckInInput = z.object({ code: VenueCode });
export type CheckInInput = z.infer<typeof CheckInInput>;

/**
 * POST /api/demo/reset — expires the caller's pending signal and ends the
 * matches they made in the last 12 hours. `leave: true` also checks them out,
 * turns encounter mode off and forgets their location.
 */
export const DemoResetInput = z.object({ leave: z.boolean().default(false) });
export type DemoResetInput = z.infer<typeof DemoResetInput>;
