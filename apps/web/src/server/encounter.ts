import "server-only";

import { randomInt } from "node:crypto";
import { DEMO_SESSION_CAPACITY, type DemoSession, type EncounterStatus } from "@cue/contracts";
import { iso, rpc, unwrap } from "@/server/db";
import { getDeviceStatus } from "@/server/devices";
import { HttpError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getAdminSupabase } from "@/server/supabase-admin";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const JOIN_CODE_LENGTH = 6;

function randomJoinCode(): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

interface SessionRow {
  id: string;
  join_code: string;
  venue_label: string;
  venue_label_source: "manual";
  created_at: string;
}

/** The caller's own view only: their session, their mode, their own pending signal. */
export async function getEncounterStatus(userId: string): Promise<EncounterStatus> {
  await rpc<null>("expire_own_signals", { p_user_id: userId });
  const db = getAdminSupabase();

  const member = unwrap(
    await db
      .from("demo_session_members")
      .select("session_id, encounter_mode")
      .eq("user_id", userId)
      .is("left_at", null)
      .maybeSingle(),
  ) as { session_id: string; encounter_mode: boolean } | null;

  let session: DemoSession | null = null;
  let pendingSignal: EncounterStatus["pendingSignal"] = null;

  if (member) {
    const row = unwrap(
      await db
        .from("demo_sessions")
        .select("id, join_code, venue_label, venue_label_source, created_at")
        .eq("id", member.session_id)
        .eq("status", "active")
        .maybeSingle(),
    ) as SessionRow | null;
    if (row) {
      const members = await db
        .from("demo_session_members")
        .select("user_id", { count: "exact", head: true })
        .eq("session_id", row.id)
        .is("left_at", null);
      if (members.error) throw new Error(`database error ${members.error.code}`);
      session = {
        id: row.id,
        joinCode: row.join_code,
        venueLabel: row.venue_label,
        venueLabelSource: row.venue_label_source,
        memberCount: members.count ?? 0,
        capacity: DEMO_SESSION_CAPACITY,
        createdAt: iso(row.created_at),
      };
      const pending = unwrap(
        await db
          .from("interest_events")
          .select("event_id, source, received_at, expires_at")
          .eq("user_id", userId)
          .eq("session_id", row.id)
          .eq("status", "pending")
          .gt("expires_at", new Date().toISOString())
          .maybeSingle(),
      ) as {
        event_id: string;
        source: "mentra_touch" | "web_demo";
        received_at: string;
        expires_at: string;
      } | null;
      if (pending) {
        pendingSignal = {
          eventId: pending.event_id,
          source: pending.source,
          receivedAt: iso(pending.received_at),
          expiresAt: iso(pending.expires_at),
        };
      }
    }
  }

  return {
    session,
    encounterMode: session ? (member?.encounter_mode ?? false) : false,
    pendingSignal,
    device: await getDeviceStatus(userId),
    serverTime: new Date().toISOString(),
  };
}

export async function setEncounterMode(userId: string, enabled: boolean): Promise<EncounterStatus> {
  const ok = await rpc<boolean>("set_encounter_mode", { p_user_id: userId, p_enabled: enabled });
  if (!ok) throw new HttpError("not_in_session", "Join or create a session first");
  return getEncounterStatus(userId);
}

export async function createSession(userId: string, venueLabel: string): Promise<EncounterStatus> {
  const db = getAdminSupabase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await db.rpc("create_demo_session", {
      p_user_id: userId,
      p_venue_label: venueLabel,
      p_join_code: randomJoinCode(),
    });
    if (res.error?.code === "23505") continue; // join code collision
    unwrap(res);
    return getEncounterStatus(userId);
  }
  throw new Error("could not allocate a join code");
}

export async function joinSession(userId: string, joinCode: string): Promise<EncounterStatus> {
  rateLimit(`join:${userId}`, 10, 60_000);
  const full = new HttpError("session_full", "This session already has two participants");
  const res = await getAdminSupabase().rpc("join_demo_session", {
    p_user_id: userId,
    p_join_code: joinCode,
  });
  if (res.error?.code === "CUE01") throw full;
  const result = unwrap(res) as { status: "joined" | "not_found" | "session_full" };
  if (result.status === "not_found") {
    throw new HttpError("not_found", "No active session with that code");
  }
  if (result.status === "session_full") throw full;
  return getEncounterStatus(userId);
}

export async function resetDemo(userId: string, leave: boolean): Promise<EncounterStatus> {
  const ok = await rpc<boolean>("reset_demo_session", { p_user_id: userId, p_leave: leave });
  if (!ok) throw new HttpError("not_in_session", "Join or create a session first");
  return getEncounterStatus(userId);
}
