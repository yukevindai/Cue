/**
 * Direct-access (RLS / grants / storage) tests: what a browser holding only the
 * anon key and a user session can and cannot do against the real local stack.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  anonClient,
  cleanupUsers,
  createUser,
  eventsOf,
  matchesOf,
  must,
  newPair,
  reportSkips,
  signal,
  stackUp,
  trackAvatar,
  type Pair,
  type TestUser,
} from "./helpers";

reportSkips("rls.test.ts", false);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TABLES = [
  "profiles",
  "blocks",
  "device_associations",
  "venues",
  "user_presence",
  "interest_events",
  "matches",
  "wingman_suggestions",
] as const;
const FORBIDDEN_READ = [
  "profiles",
  "blocks",
  "device_associations",
  "venues",
  "user_presence",
  "wingman_suggestions",
] as const;

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Reads are "nothing": either a permission error or zero rows. */
async function visibleRows(client: SupabaseClient, table: string): Promise<unknown[]> {
  const res = await client.from(table).select("*");
  if (res.error) return [];
  return res.data ?? [];
}

describe.skipIf(!stackUp)("RLS and direct database access (real stack)", () => {
  afterAll(cleanupUsers);

  let pair: Pair;
  let u1: TestUser;
  let u2: TestUser;
  let u3: TestUser;
  let c1: SupabaseClient;
  let c2: SupabaseClient;
  let c3: SupabaseClient;
  let anon: SupabaseClient;
  let matchId: string;
  let matched = false;

  /** Idempotent: completes the u1/u2 match (u1 signalled in beforeAll) and seeds rows in every table. */
  async function ensureMatch() {
    if (matched) return;
    const ack = await signal(u2);
    expect(ack.matched).toBe(true);
    matchId = ack.match_id!;
    matched = true;
  }

  beforeAll(async () => {
    pair = await newPair();
    u1 = pair.a;
    u2 = pair.b;
    u3 = await createUser();
    [c1, c2, c3] = await Promise.all([anonClient(u1), anonClient(u2), anonClient(u3)]);
    anon = await anonClient();
    // u1 also reports a phone location, so user_presence holds coordinates.
    must(await admin.rpc("report_location", { p_user_id: u1.id, p_lat: 0.0123, p_lng: -0.0456, p_accuracy_m: 8 }));
    await signal(u1); // u1 has a pending signal; u2 has not signalled yet
    // Rows in the tables the browser must not read: a block (u3 blocks u1) and an open device pairing.
    must(await admin.rpc("block_user", { p_blocker_id: u3.id, p_blocked_id: u1.id }));
    must(
      await admin.rpc("start_device_pairing", {
        p_user_id: u1.id,
        p_code_hash: createHash("sha256").update(randomUUID()).digest("hex"),
        p_ttl_seconds: 300,
      }),
    );
  });

  it("a user sees only their own interest_events, never the other member's pending signal", async () => {
    // u1 signalled in beforeAll; u2 has not. Match not created yet in this test.
    {
      const seenByU2 = must(await c2.from("interest_events").select("*")) as { user_id: string }[];
      expect(seenByU2).toEqual([]); // u1's pending signal is invisible to u2
      const seenByU1 = must(await c1.from("interest_events").select("*")) as { user_id: string; status: string }[];
      expect(seenByU1).toHaveLength(1);
      expect(seenByU1[0]).toMatchObject({ user_id: u1.id, status: "pending" });
      expect(must(await c3.from("interest_events").select("*"))).toEqual([]);
    }
    await ensureMatch();
    for (const [client, user] of [
      [c1, u1],
      [c2, u2],
    ] as const) {
      const rows = must(await client.from("interest_events").select("*")) as { user_id: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.user_id === user.id)).toBe(true);
    }
    // Filtering explicitly for the other person returns nothing either.
    expect(must(await c2.from("interest_events").select("*").eq("user_id", u1.id))).toEqual([]);
  });

  it("a signed-in user can read nothing from profiles, blocks, device_associations, venues, user_presence, wingman_suggestions", async () => {
    await ensureMatch();
    must(
      await admin
        .from("wingman_suggestions")
        .insert({ match_id: matchId, requester_id: u1.id, cache_key: "k", payload: { x: 1 } }),
    );
    // Sanity: the rows really exist for the service role.
    for (const t of FORBIDDEN_READ) {
      const rows = must(await admin.from(t).select("*").limit(1)) as unknown[];
      expect(rows.length, `service role sees ${t}`).toBeGreaterThan(0);
    }
    for (const client of [c1, c2, c3]) {
      for (const t of FORBIDDEN_READ) expect(await visibleRows(client, t), `signed-in read of ${t}`).toEqual([]);
    }
    // Not even their own profile.
    expect(await visibleRows(c1, "profiles")).toEqual([]);
    const ownProfile = await c1.from("profiles").select("*").eq("user_id", u1.id);
    expect(ownProfile.error !== null || (ownProfile.data ?? []).length === 0).toBe(true);
  });

  it("venues and user_presence are unreadable even for their own rows, by filter or by id", async () => {
    for (const client of [c1, c2, anon]) {
      const own = await client.from("user_presence").select("*").eq("user_id", u1.id);
      expect(own.error !== null || (own.data ?? []).length === 0).toBe(true);
      const coords = await client.from("user_presence").select("lat, lng");
      expect(coords.error !== null || (coords.data ?? []).length === 0).toBe(true);
      const venue = await client.from("venues").select("*").eq("id", pair.venue.id);
      expect(venue.error !== null || (venue.data ?? []).length === 0).toBe(true);
      const byCode = await client.from("venues").select("id").eq("code", pair.venue.code);
      expect(byCode.error !== null || (byCode.data ?? []).length === 0).toBe(true);
    }
    // The rows exist for the service role.
    expect((must(await admin.from("user_presence").select("lat").eq("user_id", u1.id).single()) as { lat: number }).lat).toBe(0.0123);
  });

  it("matches are readable by participants only; a third user sees zero rows", async () => {
    await ensureMatch();
    for (const client of [c1, c2]) {
      const rows = must(await client.from("matches").select("*")) as { id: string; user_a: string; user_b: string }[];
      expect(rows.map((r) => r.id)).toEqual([matchId]);
    }
    expect(must(await c3.from("matches").select("*"))).toEqual([]);
    expect(must(await c3.from("matches").select("*").eq("id", matchId))).toEqual([]);
  });

  it("a signed-in user cannot insert, update or delete in any table", async () => {
    await ensureMatch();
    const [ua, ub] = [u1.id, u3.id].sort();
    const fakeEvent = randomUUID();
    const now = new Date().toISOString();
    const inserts: Record<(typeof TABLES)[number], Record<string, unknown>> = {
      profiles: { user_id: u3.id, display_name: "Hacked" },
      blocks: { blocker_id: u1.id, blocked_id: u3.id },
      device_associations: { user_id: u1.id, pairing_code_hash: "x" },
      venues: { name: "Hacked", code: "HAXXOR", created_by: u1.id },
      user_presence: { user_id: u3.id, encounter_mode: true, lat: 0.001, lng: 0.001, accuracy_m: 1, located_at: now },
      interest_events: {
        event_id: fakeEvent,
        user_id: u1.id,
        source: "web_demo",
        gesture: "web_confirm",
        occurred_at: now,
        received_at: now,
        expires_at: now,
        status: "pending",
      },
      matches: { user_a: ua, user_b: ub, first_signal_at: now, venue_label: "x", venue_label_source: "phone_location" },
      wingman_suggestions: { match_id: matchId, requester_id: u1.id, cache_key: "x", payload: {} },
    };
    const keyOf: Record<(typeof TABLES)[number], [string, string]> = {
      profiles: ["user_id", u1.id],
      blocks: ["blocker_id", u3.id],
      device_associations: ["user_id", u1.id],
      venues: ["id", pair.venue.id],
      user_presence: ["user_id", u1.id],
      interest_events: ["user_id", u1.id],
      matches: ["id", matchId],
      wingman_suggestions: ["match_id", matchId],
    };
    const updates: Record<(typeof TABLES)[number], Record<string, unknown>> = {
      profiles: { display_name: "Hacked" },
      blocks: { blocked_id: u2.id },
      device_associations: { revoked_at: now },
      venues: { active: false },
      user_presence: { encounter_mode: false, lat: null, lng: null, accuracy_m: null, located_at: null },
      interest_events: { status: "cancelled" },
      matches: { status: "ended" },
      wingman_suggestions: { cache_key: "hacked" },
    };

    for (const [who, client] of [
      ["signed-in", c1],
      ["anon", anon],
    ] as const) {
      for (const t of TABLES) {
        const ins = await client.from(t).insert(inserts[t]);
        expect(ins.error?.code, `${who} insert ${t}`).toBe("42501");
        const upd = await client.from(t).update(updates[t]).eq(...keyOf[t]);
        expect(upd.error?.code, `${who} update ${t}`).toBe("42501");
        const del = await client.from(t).delete().eq(...keyOf[t]);
        expect(del.error?.code, `${who} delete ${t}`).toBe("42501");
      }
    }

    // Database state is unchanged.
    expect(must(await admin.from("interest_events").select("id").eq("event_id", fakeEvent))).toEqual([]);
    expect(await matchesOf(u1)).toHaveLength(1);
    expect((await matchesOf(u1))[0].status).toBe("active");
    expect((await eventsOf(u1.id))[0].status).toBe("consumed");
    const profile = must(await admin.from("profiles").select("display_name").eq("user_id", u1.id).single()) as {
      display_name: string;
    };
    expect(profile.display_name).not.toBe("Hacked");
    expect(must(await admin.from("blocks").select("*").eq("blocker_id", u3.id))).toHaveLength(1);
    expect(must(await admin.from("venues").select("active, name").eq("id", pair.venue.id).single())).toEqual({
      active: true,
      name: pair.venue.name,
    });
    expect(must(await admin.from("user_presence").select("encounter_mode, venue_id, lat").eq("user_id", u1.id).single())).toEqual({
      encounter_mode: true,
      venue_id: pair.venue.id,
      lat: 0.0123,
    });
    expect(must(await admin.from("user_presence").select("user_id").eq("user_id", u3.id))).toEqual([]);
  });

  it("a signed-in user or anon cannot execute any SQL function through rpc", async () => {
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const calls: [string, Record<string, unknown>][] = [
      ["submit_signal", { p_user_id: u1.id, p_event_id: eventId, p_source: "web_demo", p_gesture: "web_confirm", p_occurred_at: now }],
      ["submit_interest", { p_user_id: u1.id, p_session_id: randomUUID(), p_event_id: eventId, p_source: "web_demo", p_gesture: "web_confirm", p_occurred_at: now }],
      ["presence_state", { p_user_id: u1.id }],
      ["set_presence_mode", { p_user_id: u1.id, p_enabled: false }],
      ["report_location", { p_user_id: u1.id, p_lat: 0.5, p_lng: 0.5, p_accuracy_m: 1 }],
      ["clear_location", { p_user_id: u1.id }],
      ["create_venue", { p_user_id: u1.id, p_name: "x", p_code: "ZZZZZZ" }],
      ["check_in_venue", { p_user_id: u3.id, p_code: pair.venue.code }],
      ["check_out_venue", { p_user_id: u1.id }],
      ["reset_my_demo", { p_user_id: u1.id, p_leave: true }],
      ["distance_m", { p_lat1: 0, p_lng1: 0, p_lat2: 0, p_lng2: 0.001 }],
      ["claim_device", { p_code_hash: "a", p_token_hash: "b", p_device_label: "x", p_mentra_user_id: null }],
      ["end_match", { p_match_id: randomUUID(), p_user_id: u1.id, p_reason: "unmatch" }],
      ["block_user", { p_blocker_id: u1.id, p_blocked_id: u3.id }],
      ["start_device_pairing", { p_user_id: u1.id, p_code_hash: "c", p_ttl_seconds: 60 }],
      ["unlink_device", { p_user_id: u1.id }],
      ["interest_pair_ok", { p_source: "headset_remote", p_gesture: "media_next_track" }],
      ["expire_own_signals", { p_user_id: u1.id }],
    ];
    for (const [who, client] of [
      ["signed-in", c1],
      ["anon", anon],
    ] as const) {
      for (const [fn, args] of calls) {
        const res = await client.rpc(fn, args);
        expect(res.error?.code, `${who} rpc ${fn}`).toBe("42501");
      }
    }
    // Nothing happened as a side effect.
    expect(await eventById_(eventId, u1.id)).toBe(0);
    expect((await matchesOf(u1))[0].status).toBe("active");
    expect(must(await admin.from("user_presence").select("encounter_mode, venue_id, lat").eq("user_id", u1.id).single())).toEqual({
      encounter_mode: true,
      venue_id: pair.venue.id,
      lat: 0.0123,
    });
    expect(must(await admin.from("venues").select("id").eq("code", "ZZZZZZ"))).toEqual([]);
    expect(must(await admin.from("blocks").select("*").eq("blocker_id", u1.id))).toEqual([]);
  });

  it("anon (signed out) sees nothing in any table", async () => {
    for (const t of TABLES) {
      const res = await anon.from(t).select("*");
      expect(res.error !== null || (res.data ?? []).length === 0, `anon read of ${t}`).toBe(true);
      expect(await visibleRows(anon, t)).toEqual([]);
    }
  });

  describe("storage: avatars bucket", () => {
    it("a user can upload under their own uid folder and the public URL serves the file", async () => {
      const path = `${u1.id}/a.png`;
      trackAvatar(path);
      const up = await c1.storage.from("avatars").upload(path, PNG, { contentType: "image/png", upsert: true });
      expect(up.error).toBeNull();
      const { data } = c1.storage.from("avatars").getPublicUrl(path);
      const res = await fetch(data.publicUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
      // The same URL works without any credentials (public bucket).
      expect((await fetch(data.publicUrl, { headers: {} })).status).toBe(200);
    });

    it("a user cannot upload into another user's folder, the bucket root, or with a non-image type", async () => {
      const other = `${u2.id}/a.png`;
      trackAvatar(other);
      const refused = await c1.storage.from("avatars").upload(other, PNG, { contentType: "image/png", upsert: true });
      expect(refused.error).not.toBeNull();
      const root = await c1.storage.from("avatars").upload(`root-${u1.id}.png`, PNG, { contentType: "image/png" });
      expect(root.error).not.toBeNull();
      const text = await c1.storage.from("avatars").upload(`${u1.id}/note.txt`, Buffer.from("hi"), { contentType: "text/plain" });
      expect(text.error).not.toBeNull();

      const listed = must(await admin.storage.from("avatars").list(u2.id)) as { name: string }[];
      expect(listed.map((o) => o.name)).not.toContain("a.png");
    });

    it("another user cannot overwrite or delete a user's avatar, and anon cannot upload", async () => {
      const path = `${u1.id}/b.png`;
      trackAvatar(path);
      expect((await c1.storage.from("avatars").upload(path, PNG, { contentType: "image/png" })).error).toBeNull();
      const overwrite = await c2.storage.from("avatars").upload(path, PNG, { contentType: "image/png", upsert: true });
      expect(overwrite.error).not.toBeNull();
      await c2.storage.from("avatars").remove([path]);
      const stillThere = must(await admin.storage.from("avatars").list(u1.id)) as { name: string }[];
      expect(stillThere.map((o) => o.name)).toContain("b.png");
      const anonUp = await anon.storage.from("avatars").upload(`${u1.id}/c.png`, PNG, { contentType: "image/png" });
      expect(anonUp.error).not.toBeNull();
      const listedByOther = await c2.storage.from("avatars").list(u1.id);
      expect(listedByOther.error !== null || (listedByOther.data ?? []).length === 0).toBe(true);
    });
  });
});

async function eventById_(eventId: string, userId: string): Promise<number> {
  return (must(await admin.from("interest_events").select("id").eq("user_id", userId).eq("event_id", eventId)) as unknown[]).length;
}
