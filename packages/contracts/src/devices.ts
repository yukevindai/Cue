import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

/**
 * Account-to-device association.
 * 1. Signed-in web user calls POST /api/devices/pair -> short pairing code.
 * 2. The glasses client (Mentra miniapp or Spectacles Lens) calls POST /api/devices/claim with that code and
 *    receives a long-lived device token (stored hashed server-side).
 * 3. The bridge sends `Authorization: Bearer <deviceToken>` on
 *    POST /api/interest and GET /api/devices/me.
 * The device token only authorizes interest submission and device status for
 * the linked user. It never grants profile or match access.
 */
export const PairingCode = z.object({
  code: z.string().regex(/^[A-Z0-9]{6}$/),
  expiresAt: IsoDateTime,
});
export type PairingCode = z.infer<typeof PairingCode>;

export const DeviceClaimInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/),
  /** Human label shown in the web app, e.g. "Mentra Live" or "Snap Spectacles". */
  deviceLabel: z.string().trim().min(1).max(60).default("Mentra Live"),
  /** Identifier reported by the Mentra runtime for the wearer, if any. Spectacles send null. */
  mentraUserId: z.string().max(200).nullable().default(null),
});
export type DeviceClaimInput = z.infer<typeof DeviceClaimInput>;

export const DeviceClaimResult = z.object({
  deviceId: Uuid,
  deviceToken: z.string().min(32),
});
export type DeviceClaimResult = z.infer<typeof DeviceClaimResult>;

/**
 * GET /api/devices/me (device token auth). Lets the bridge know whether to
 * forward swipes, and which session id to stamp on events.
 */
export const DeviceContext = z.object({
  deviceId: Uuid,
  encounterMode: z.boolean(),
  encounterSessionId: Uuid.nullable(),
  serverTime: IsoDateTime,
  /**
   * The wearer's newest active match, so glasses can show the match even when
   * the wearer signalled first. Only ever the wearer's own mutual match, never
   * a one-sided signal. Optional so older servers and clients stay compatible.
   */
  activeMatchId: Uuid.nullable().optional(),
});
export type DeviceContext = z.infer<typeof DeviceContext>;
