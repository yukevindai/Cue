/**
 * Wire shapes of the three device endpoints, hand-mirrored from
 * `@cue/contracts` (zod cannot be bundled into a Lens). The parsers are
 * deliberately strict about what this client reads and ignore anything else.
 * `test/contract-parity.test.ts` runs them against the real zod schemas.
 */
import { GESTURE, SOURCE } from "./config";

export interface InterestEvent {
  eventId: string;
  encounterSessionId: string;
  source: typeof SOURCE;
  gesture: typeof GESTURE;
  occurredAt: string;
}

export type InterestAckStatus = "accepted" | "duplicate" | "rejected";

export interface InterestAck {
  status: InterestAckStatus;
  eventId: string;
  receivedAt: string;
  expiresAt: string | null;
  matched: boolean;
  reason: string | null;
}

export interface DeviceContext {
  deviceId: string;
  encounterMode: boolean;
  encounterSessionId: string | null;
  serverTime: string;
  /** The wearer's newest active (mutual) match. Absent on older servers. */
  activeMatchId?: string | null;
}

export interface DeviceClaimInput {
  code: string;
  deviceLabel: string;
  mentraUserId: null;
}

export interface DeviceClaimResult {
  deviceId: string;
  deviceToken: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Pairing codes are six characters A-Z / 0-9 (PairingCode in contracts). */
const PAIRING_CODE = /^[A-Z0-9]{6}$/;
const ACK_STATUSES: readonly string[] = ["accepted", "duplicate", "rejected"];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isUuid(value: unknown): value is string {
  return isString(value) && UUID.test(value);
}

/** Trims and upper-cases what the wearer typed; null when it is not a valid code. */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return PAIRING_CODE.test(code) ? code : null;
}

export function parseInterestAck(value: unknown): InterestAck | null {
  const o = asObject(value);
  if (o === null) return null;
  if (!isString(o.status) || !ACK_STATUSES.includes(o.status)) return null;
  if (!isUuid(o.eventId) || !isString(o.receivedAt)) return null;
  if (!isNullableString(o.expiresAt) || typeof o.matched !== "boolean" || !isNullableString(o.reason)) return null;
  return {
    status: o.status as InterestAckStatus,
    eventId: o.eventId,
    receivedAt: o.receivedAt,
    expiresAt: o.expiresAt,
    matched: o.matched,
    reason: o.reason,
  };
}

export function parseDeviceContext(value: unknown): DeviceContext | null {
  const o = asObject(value);
  if (o === null) return null;
  if (!isUuid(o.deviceId) || typeof o.encounterMode !== "boolean") return null;
  if (!(o.encounterSessionId === null || isUuid(o.encounterSessionId)) || !isString(o.serverTime)) return null;
  const hasMatch = o.activeMatchId !== undefined;
  if (hasMatch && !(o.activeMatchId === null || isUuid(o.activeMatchId))) return null;
  const context: DeviceContext = {
    deviceId: o.deviceId,
    encounterMode: o.encounterMode,
    encounterSessionId: o.encounterSessionId as string | null,
    serverTime: o.serverTime,
  };
  if (hasMatch) context.activeMatchId = o.activeMatchId as string | null;
  return context;
}

export function parseDeviceClaimResult(value: unknown): DeviceClaimResult | null {
  const o = asObject(value);
  if (o === null) return null;
  if (!isUuid(o.deviceId) || !isString(o.deviceToken) || o.deviceToken.length < 32) return null;
  return { deviceId: o.deviceId, deviceToken: o.deviceToken };
}
