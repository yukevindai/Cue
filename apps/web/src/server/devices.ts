import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";
import type {
  DeviceClaimInput,
  DeviceClaimResult,
  DeviceContext,
  DeviceStatus,
  PairingCode,
} from "@cue/contracts";
import { iso, isoOrNull, rpc, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { hit, rateLimit } from "@/server/rate-limit";
import { getAdminSupabase } from "@/server/supabase-admin";

const PAIRING_TTL_SECONDS = 5 * 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 6;
const TOKEN_PREFIX = "cue_dev_";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Signed-in user asks for a short-lived, single-use pairing code. Only its hash is stored. */
export async function startPairing(userId: string): Promise<PairingCode> {
  rateLimit(`pair:${userId}`, 10, 60_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const res = await getAdminSupabase().rpc("start_device_pairing", {
      p_user_id: userId,
      p_code_hash: sha256(code),
      p_ttl_seconds: PAIRING_TTL_SECONDS,
    });
    if (res.error?.code === "23505") continue; // code collision with another open pairing
    return { code, expiresAt: iso(unwrap(res) as string) };
  }
  throw new Error("could not allocate a pairing code");
}

/**
 * Unauthenticated: the code is the credential. Guessing resistance: 32^6
 * (about 1e9) codes that live 5 minutes and work once, a per-client attempt
 * limit, and a global cap on failed claims. Unknown, expired and used codes
 * are indistinguishable.
 */
export async function claimDevice(
  input: DeviceClaimInput,
  clientKey: string,
): Promise<DeviceClaimResult> {
  rateLimit(`claim:${clientKey}`, 10, 60_000);
  if (isClaimLockedOut()) throw new HttpError("rate_limited", "Too many requests");

  const deviceToken = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const deviceId = await rpc<string | null>("claim_device", {
    p_code_hash: sha256(input.code),
    p_token_hash: sha256(deviceToken),
    p_device_label: input.deviceLabel,
    p_mentra_user_id: input.mentraUserId,
  });
  if (!deviceId) {
    recordClaimFailure();
    throw new HttpError("not_found", "Pairing code is invalid or expired");
  }
  return { deviceId, deviceToken };
}

const CLAIM_FAILURE_KEY = "claim:failures";
const CLAIM_FAILURE_LIMIT = 30;
let claimLockedUntil = 0;

function isClaimLockedOut(): boolean {
  return Date.now() < claimLockedUntil;
}

/** More than 30 failed claims in a minute (from anywhere) pauses claiming for a minute. */
function recordClaimFailure(): void {
  if (!hit(CLAIM_FAILURE_KEY, CLAIM_FAILURE_LIMIT, 60_000)) claimLockedUntil = Date.now() + 60_000;
}

export interface DeviceAuth {
  deviceId: string;
  userId: string;
}

/** Bearer token from the Authorization header, or null when the header is absent. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

/**
 * Device-token auth. The token authorizes interest submission and device
 * status for the linked user only; it is never accepted by profile or match
 * routes, which use requireSessionUser().
 */
export async function requireDevice(req: Request): Promise<DeviceAuth> {
  const token = bearerToken(req);
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    throw new HttpError("unauthenticated", "Device token required");
  }
  const row = unwrap(
    await getAdminSupabase()
      .from("device_associations")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("token_hash", sha256(token))
      .is("revoked_at", null)
      .not("linked_at", "is", null)
      .select("id, user_id")
      .maybeSingle(),
  ) as { id: string; user_id: string } | null;
  if (!row) throw new HttpError("unauthenticated", "Device token is invalid or revoked");
  return { deviceId: row.id, userId: row.user_id };
}

/** GET /api/devices/me */
export async function getDeviceContext(device: DeviceAuth): Promise<DeviceContext> {
  const member = unwrap(
    await getAdminSupabase()
      .from("demo_session_members")
      .select("session_id, encounter_mode")
      .eq("user_id", device.userId)
      .is("left_at", null)
      .maybeSingle(),
  ) as { session_id: string; encounter_mode: boolean } | null;
  const match = unwrap(
    await getAdminSupabase()
      .from("matches")
      .select("id")
      .eq("status", "active")
      .or(`user_a.eq.${device.userId},user_b.eq.${device.userId}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ) as { id: string } | null;
  return {
    deviceId: device.deviceId,
    encounterMode: member?.encounter_mode ?? false,
    encounterSessionId: member?.session_id ?? null,
    serverTime: new Date().toISOString(),
    activeMatchId: match?.id ?? null,
  };
}

export async function getDeviceStatus(userId: string): Promise<DeviceStatus> {
  const row = unwrap(
    await getAdminSupabase()
      .from("device_associations")
      .select("id, device_label, last_seen_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .not("linked_at", "is", null)
      .maybeSingle(),
  ) as { id: string; device_label: string | null; last_seen_at: string | null } | null;
  return {
    linked: row !== null,
    deviceId: row?.id ?? null,
    deviceLabel: row?.device_label ?? null,
    lastSeenAt: isoOrNull(row?.last_seen_at),
  };
}

/** Revokes the caller's device and cancels a pending glasses signal. */
export async function unlinkDevice(userId: string): Promise<void> {
  await rpc<null>("unlink_device", { p_user_id: userId });
}
