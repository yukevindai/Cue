import "server-only";

import { randomInt } from "node:crypto";
import {
  VENUE_CODE_ALPHABET,
  type EncounterStatus,
  type InterestSource,
  type LocationInput,
  type LocationStatus,
} from "@cue/contracts";
import { iso, isoOrNull, rpc, unwrap } from "@/server/db";
import { getDeviceStatus } from "@/server/devices";
import { HttpError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getAdminSupabase } from "@/server/supabase-admin";

const VENUE_CODE_LENGTH = 6;

function randomVenueCode(): string {
  let code = "";
  for (let i = 0; i < VENUE_CODE_LENGTH; i++) code += VENUE_CODE_ALPHABET[randomInt(VENUE_CODE_ALPHABET.length)];
  return code;
}

/** jsonb returned by SQL `presence_state`. Never contains coordinates. */
export interface PresenceState {
  encounter_mode: boolean;
  ready: boolean;
  venue: {
    id: string;
    name: string;
    code: string;
    checked_in_at: string;
    expires_at: string;
  } | null;
  location: {
    status: LocationStatus;
    accuracy_m: number | null;
    located_at: string | null;
  };
}

export async function getPresenceState(userId: string): Promise<PresenceState> {
  return rpc<PresenceState>("presence_state", { p_user_id: userId });
}

interface PendingRow {
  event_id: string;
  source: InterestSource;
  received_at: string;
  expires_at: string;
}

/** The caller's OWN unexpired pending signal (place-based rows have no session). */
async function ownPendingSignal(userId: string): Promise<PendingRow | null> {
  return unwrap(
    await getAdminSupabase()
      .from("interest_events")
      .select("event_id, source, received_at, expires_at")
      .eq("user_id", userId)
      .is("session_id", null)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ) as PendingRow | null;
}

/**
 * The caller's own view only: their mode, their place (never coordinates),
 * their own pending signal and their device. Incoming interest is never shown.
 */
export async function getEncounterStatus(userId: string): Promise<EncounterStatus> {
  await rpc<null>("expire_own_signals", { p_user_id: userId });
  const [presence, pending, device] = await Promise.all([
    getPresenceState(userId),
    ownPendingSignal(userId),
    getDeviceStatus(userId),
  ]);

  return {
    encounterMode: presence.encounter_mode,
    checkIn: presence.venue
      ? {
          venueId: presence.venue.id,
          name: presence.venue.name,
          code: presence.venue.code,
          checkedInAt: iso(presence.venue.checked_in_at),
          expiresAt: iso(presence.venue.expires_at),
        }
      : null,
    location: {
      status: presence.location.status,
      accuracyM: presence.location.accuracy_m,
      locatedAt: isoOrNull(presence.location.located_at),
    },
    ready: presence.ready,
    pendingSignal: pending
      ? {
          eventId: pending.event_id,
          source: pending.source,
          receivedAt: iso(pending.received_at),
          expiresAt: iso(pending.expires_at),
        }
      : null,
    device,
    serverTime: new Date().toISOString(),
  };
}

/** Turning it off cancels the pending signal and forgets the location (in SQL). */
export async function setEncounterMode(userId: string, enabled: boolean): Promise<EncounterStatus> {
  await rpc<null>("set_presence_mode", { p_user_id: userId, p_enabled: enabled });
  return getEncounterStatus(userId);
}

/**
 * Stores the phone's position. With encounter mode off nothing is stored and
 * the status comes back unchanged (still 200): the page may race a mode change.
 */
export async function reportLocation(userId: string, input: LocationInput): Promise<EncounterStatus> {
  // The page reports about every 15 s and on movement; allow bursts.
  rateLimit(`location:${userId}`, 30, 60_000);
  await rpc<boolean>("report_location", {
    p_user_id: userId,
    p_lat: input.lat,
    p_lng: input.lng,
    p_accuracy_m: input.accuracyM,
  });
  return getEncounterStatus(userId);
}

export async function clearLocation(userId: string): Promise<EncounterStatus> {
  await rpc<null>("clear_location", { p_user_id: userId });
  return getEncounterStatus(userId);
}

/** Creates a venue with a fresh code and checks the caller into it. */
export async function createVenue(userId: string, name: string): Promise<EncounterStatus> {
  rateLimit(`venue:${userId}`, 10, 60_000);
  const db = getAdminSupabase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await db.rpc("create_venue", { p_user_id: userId, p_name: name, p_code: randomVenueCode() });
    if (res.error?.code === "23505") continue; // code collision
    unwrap(res);
    return getEncounterStatus(userId);
  }
  throw new Error("could not allocate a venue code");
}

/** Codes are short and guessable, so attempts are rate limited. Unknown and inactive codes look the same. */
export async function checkIn(userId: string, code: string): Promise<EncounterStatus> {
  rateLimit(`checkin:${userId}`, 10, 60_000);
  const result = await rpc<"checked_in" | "not_found">("check_in_venue", { p_user_id: userId, p_code: code });
  if (result !== "checked_in") throw new HttpError("not_found", "No venue with that code");
  return getEncounterStatus(userId);
}

/** Leaving cancels a pending signal (in SQL). */
export async function checkOut(userId: string): Promise<EncounterStatus> {
  await rpc<null>("check_out_venue", { p_user_id: userId });
  return getEncounterStatus(userId);
}

export async function resetDemo(userId: string, leave: boolean): Promise<EncounterStatus> {
  await rpc<null>("reset_my_demo", { p_user_id: userId, p_leave: leave });
  return getEncounterStatus(userId);
}
