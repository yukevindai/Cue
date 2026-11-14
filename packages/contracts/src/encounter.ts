import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";
import { InterestSource } from "./interest";

export const VenueLabelSource = z.enum(["manual"]);

export const DemoSession = z.object({
  id: Uuid,
  /** Short code the second participant enters to join. */
  joinCode: z.string(),
  venueLabel: z.string(),
  /** Venue labels are typed in by the organizer; shown as such, never as GPS. */
  venueLabelSource: VenueLabelSource,
  memberCount: z.number().int(),
  capacity: z.number().int(),
  createdAt: IsoDateTime,
});
export type DemoSession = z.infer<typeof DemoSession>;

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
  session: DemoSession.nullable(),
  encounterMode: z.boolean(),
  pendingSignal: PendingSignal.nullable(),
  device: DeviceStatus,
  serverTime: IsoDateTime,
});
export type EncounterStatus = z.infer<typeof EncounterStatus>;

/** POST /api/encounter/mode */
export const EncounterModeInput = z.object({ enabled: z.boolean() });
export type EncounterModeInput = z.infer<typeof EncounterModeInput>;

/** POST /api/demo/session — create a two-person session and join it. */
export const CreateSessionInput = z.object({
  venueLabel: z.string().trim().min(1).max(80),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

/** POST /api/demo/session/join */
export const JoinSessionInput = z.object({
  joinCode: z.string().trim().min(4).max(12),
});
export type JoinSessionInput = z.infer<typeof JoinSessionInput>;

/**
 * POST /api/demo/reset — clean demo reset for the caller's current session:
 * expires pending signals and removes that session's matches + cached
 * suggestions. `leave: true` also ends the session.
 */
export const DemoResetInput = z.object({ leave: z.boolean().default(false) });
export type DemoResetInput = z.infer<typeof DemoResetInput>;
