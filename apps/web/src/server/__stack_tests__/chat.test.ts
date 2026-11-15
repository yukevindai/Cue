/**
 * In-app chat (GET/POST /api/matches/[id]/messages) against the running web
 * server and the real local stack, plus direct-access (RLS) checks on
 * chat_messages / chat_reads. Skipped unless both are reachable.
 */
import { randomUUID } from "node:crypto";
import {
  ApiError,
  CHAT_PAGE_SIZE,
  ChatMessage,
  DeviceClaimResult,
  MatchCard,
  MatchList,
  MessageList,
  PairingCode,
  routes,
} from "@cue/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  anonClient,
  api,
  cleanupUsers,
  cookieFor,
  createUser,
  freshClient,
  must,
  newPair,
  openVenue,
  reportSkips,
  signal,
  stackUp,
  webUp,
  type Pair,
  type Reply,
} from "./helpers";

reportSkips("chat.test.ts", true);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function ok<S extends { parse(x: unknown): unknown }>(res: Reply, schema: S, status = 200) {
  expect(res.status, res.text).toBe(status);
  return schema.parse(res.json) as ReturnType<S["parse"]>;
}

function err(res: Reply, status: number, code?: string) {
  expect(res.status, res.text).toBe(status);
  const parsed = ApiError.parse(res.json);
  if (code) expect(parsed.error.code).toBe(code);
  return parsed;
}

interface Matched extends Pair {
  matchId: string;
  ca: string;
  cb: string;
}

/** Two fresh users with an ACTIVE match, and their cookie sessions. */
async function matchedPair(): Promise<Matched> {
  const p = await newPair();
  await signal(p.a);
  const ack = await signal(p.b);
  expect(ack.matched).toBe(true);
  const [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
  return { ...p, matchId: ack.match_id!, ca, cb };
}

const send = (cookie: string, matchId: string, body: string, clientId: string = randomUUID()) =>
  api("POST", routes.messages(matchId), { cookie }, { clientId, body });

const read = async (cookie: string, matchId: string, before?: string) =>
  ok(
    await api("GET", `${routes.messages(matchId)}${before ? `?before=${encodeURIComponent(before)}` : ""}`, { cookie }),
    MessageList,
  );

const card = async (cookie: string, matchId: string) => ok(await api("GET", routes.match(matchId), { cookie }), MatchCard);

const rowsOf = async (matchId: string) =>
  must(await admin.from("chat_messages").select("*").eq("match_id", matchId)) as {
    id: string;
    sender_id: string;
    client_id: string;
    body: string;
  }[];

describe.skipIf(!stackUp || !webUp)("chat (real web server + real stack)", () => {
  afterAll(cleanupUsers);

  it("both people send and read; mine flags are per viewer; no sender id in any response", async () => {
    const m = await matchedPair();
    const s1 = ok(await send(m.ca, m.matchId, "  Hi from A  "), ChatMessage, 201);
    expect(s1).toMatchObject({ matchId: m.matchId, mine: true, body: "Hi from A" }); // trimmed by the contract
    const s2 = ok(await send(m.cb, m.matchId, "<b>Hi</b> from B & co"), ChatMessage, 201);
    expect(s2.body).toBe("<b>Hi</b> from B & co"); // stored as plain text, untouched

    const forA = await read(m.ca, m.matchId);
    const forB = await read(m.cb, m.matchId);
    expect(forA.olderCursor).toBeNull();
    expect(forA.messages.map((x) => [x.body, x.mine])).toEqual([
      ["Hi from A", true],
      ["<b>Hi</b> from B & co", false],
    ]);
    expect(forB.messages.map((x) => [x.body, x.mine])).toEqual([
      ["Hi from A", false],
      ["<b>Hi</b> from B & co", true],
    ]);
    expect(forA.messages.map((x) => x.id)).toEqual([s1.id, s2.id]);

    for (const res of [JSON.stringify(forA), JSON.stringify(forB), JSON.stringify(s1), JSON.stringify(s2)]) {
      expect(res).not.toContain(m.a.id);
      expect(res).not.toContain(m.b.id);
      expect(res).not.toMatch(/sender|client_?id/i);
    }
  });

  it("rejects bodies that fail the contract (empty, too long, extra keys) and writes nothing", async () => {
    const m = await matchedPair();
    err(await send(m.ca, m.matchId, "   "), 400, "invalid_request");
    err(await send(m.ca, m.matchId, "x".repeat(1001)), 400, "invalid_request");
    err(await api("POST", routes.messages(m.matchId), { cookie: m.ca }, { clientId: "nope", body: "hi" }), 400, "invalid_request");
    err(
      await api("POST", routes.messages(m.matchId), { cookie: m.ca }, { clientId: randomUUID(), body: "hi", senderId: m.b.id }),
      400,
      "invalid_request",
    );
    expect(await rowsOf(m.matchId)).toHaveLength(0);
    ok(await send(m.ca, m.matchId, "x".repeat(1000)), ChatMessage, 201);
  });

  it("re-sending a clientId returns the stored message with 200 and never duplicates, even concurrently", async () => {
    const m = await matchedPair();
    const clientId = randomUUID();
    const first = ok(await send(m.ca, m.matchId, "once", clientId), ChatMessage, 201);
    const again = ok(await send(m.ca, m.matchId, "once (edited retry)", clientId), ChatMessage, 200);
    expect(again).toEqual(first); // the stored message wins

    const racing = randomUUID();
    const replies = await Promise.all(Array.from({ length: 6 }, () => send(m.cb, m.matchId, "race", racing)));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const ids = new Set(replies.map((r) => ChatMessage.parse(r.json).id));
    expect(ids.size).toBe(1);

    const rows = await rowsOf(m.matchId);
    expect(rows.filter((r) => r.client_id === clientId)).toHaveLength(1);
    expect(rows.filter((r) => r.client_id === racing)).toHaveLength(1);
    expect(rows).toHaveLength(2);

    // The same clientId from the other person is a different message.
    ok(await send(m.cb, m.matchId, "b reuses a's id", clientId), ChatMessage, 201);
    expect(await rowsOf(m.matchId)).toHaveLength(3);
  });

  it("a clientId already used in another conversation is rejected, not leaked", async () => {
    const m1 = await matchedPair();
    const clientId = randomUUID();
    ok(await send(m1.ca, m1.matchId, "first conversation", clientId), ChatMessage, 201);
    // Give A a second active match with someone else.
    const other = await createUser();
    await openVenue(m1.a, other);
    await signal(m1.a);
    const ack = await signal(other);
    expect(ack.matched).toBe(true);
    const ca = await cookieFor(m1.a);
    const res = await send(ca, ack.match_id!, "second conversation", clientId);
    err(res, 400, "invalid_request");
    expect(res.text).not.toContain("first conversation");
    expect(await rowsOf(ack.match_id!)).toHaveLength(0);
  });

  it("pages back with olderCursor, oldest first within each page, without gaps or repeats", async () => {
    const m = await matchedPair();
    const total = CHAT_PAGE_SIZE + 7;
    // Insert directly (the API limit is 20 / 10 s per sender). Same created_at for a few rows exercises the id tiebreak.
    const base = Date.now() - 60_000;
    const rows = Array.from({ length: total }, (_, i) => ({
      match_id: m.matchId,
      sender_id: i % 2 === 0 ? m.a.id : m.b.id,
      client_id: randomUUID(),
      body: `m${String(i).padStart(3, "0")}`,
      created_at: new Date(base + Math.floor(i / 3) * 1000).toISOString(),
    }));
    must(await admin.from("chat_messages").insert(rows));

    const newest = await read(m.ca, m.matchId);
    expect(newest.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(newest.olderCursor).not.toBeNull();
    const older = await read(m.ca, m.matchId, newest.olderCursor!);
    expect(older.messages).toHaveLength(7);
    expect(older.olderCursor).toBeNull();

    const all = [...older.messages, ...newest.messages];
    expect(new Set(all.map((x) => x.id)).size).toBe(total);
    const times = all.map((x) => new Date(x.createdAt).getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    // Exactly the DB order (created_at, then id as tiebreak), oldest first, across both pages.
    const expected = must(
      await admin
        .from("chat_messages")
        .select("id")
        .eq("match_id", m.matchId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ) as { id: string }[];
    expect(all.map((x) => x.id)).toEqual(expected.map((r) => r.id));

    // A tampered cursor is a 400, never a query error.
    for (const bad of ["not base64!", Buffer.from("x|y").toString("base64url"), Buffer.from(`2026-01-01T00:00:00Z|${randomUUID()},id.gt.0`).toString("base64url")]) {
      err(await api("GET", `${routes.messages(m.matchId)}?before=${encodeURIComponent(bad)}`, { cookie: m.ca }), 400, "invalid_request");
    }
  });

  it("unread count rises for the other person, resets when they fetch, and lastMessageAt tracks the newest", async () => {
    const m = await matchedPair();
    expect(await card(m.cb, m.matchId)).toMatchObject({ unreadCount: 0, lastMessageAt: null });

    const m1 = ok(await send(m.ca, m.matchId, "one"), ChatMessage, 201);
    const m2 = ok(await send(m.ca, m.matchId, "two"), ChatMessage, 201);
    const forB = await card(m.cb, m.matchId);
    expect(forB.unreadCount).toBe(2);
    expect(forB.lastMessageAt).toBe(m2.createdAt);
    // Own messages are never unread for the sender.
    expect((await card(m.ca, m.matchId)).unreadCount).toBe(0);
    expect((await card(m.ca, m.matchId)).lastMessageAt).toBe(m2.createdAt);
    const listB = ok(await api("GET", routes.matches, { cookie: m.cb }), MatchList).matches;
    expect(listB.find((c) => c.id === m.matchId)).toMatchObject({ unreadCount: 2, lastMessageAt: m2.createdAt });
    void m1;

    // An older page does not mark anything read.
    await read(m.cb, m.matchId, Buffer.from(`2099-01-01T00:00:00+00:00|${randomUUID()}`).toString("base64url"));
    expect((await card(m.cb, m.matchId)).unreadCount).toBe(2);

    await read(m.cb, m.matchId);
    expect((await card(m.cb, m.matchId)).unreadCount).toBe(0);

    const reply = ok(await send(m.cb, m.matchId, "hello back"), ChatMessage, 201);
    expect((await card(m.cb, m.matchId)).unreadCount).toBe(0);
    expect((await card(m.ca, m.matchId)).unreadCount).toBe(1);
    expect((await card(m.cb, m.matchId)).lastMessageAt).toBe(reply.createdAt);
    ok(await send(m.ca, m.matchId, "three"), ChatMessage, 201);
    expect((await card(m.cb, m.matchId)).unreadCount).toBe(1);
  });

  it("non-participants, a malformed id and an unknown id get 404 on GET and POST; nothing is written", async () => {
    const m = await matchedPair();
    ok(await send(m.ca, m.matchId, "private"), ChatMessage, 201);
    const third = await createUser();
    const cc = await cookieFor(third);
    for (const id of [m.matchId, randomUUID(), "not-a-uuid"]) {
      const g = await api("GET", routes.messages(id), { cookie: cc });
      err(g, 404, "not_found");
      expect(g.text).not.toContain("private");
      err(await send(cc, id, "let me in"), 404, "not_found");
    }
    err(await api("GET", routes.messages("not-a-uuid"), { cookie: m.ca }), 404, "not_found");
    expect((await rowsOf(m.matchId)).map((r) => r.body)).toEqual(["private"]);
  });

  it("unauthenticated is 401; a device token is not a session (401) and writes nothing", async () => {
    const m = await matchedPair();
    err(await api("GET", routes.messages(m.matchId)), 401, "unauthenticated");
    err(await api("POST", routes.messages(m.matchId), {}, { clientId: randomUUID(), body: "x" }), 401, "unauthenticated");
    const pairing = ok(await api("POST", routes.devicePair, { cookie: m.ca }), PairingCode);
    const { deviceToken } = ok(await api("POST", routes.deviceClaim, freshClient(), { code: pairing.code }), DeviceClaimResult);
    err(await api("GET", routes.messages(m.matchId), { bearer: deviceToken }), 401, "unauthenticated");
    err(
      await api("POST", routes.messages(m.matchId), { bearer: deviceToken }, { clientId: randomUUID(), body: "from glasses" }),
      401,
      "unauthenticated",
    );
    expect(await rowsOf(m.matchId)).toHaveLength(0);
  });

  it("rate limit: past 20 messages in 10 s a sender gets 429 rate_limited", async () => {
    const m = await matchedPair();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await send(m.ca, m.matchId, `burst ${i}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    err(await send(m.ca, m.matchId, "still limited"), 429, "rate_limited");
    // The limit is per sender: the other person is unaffected.
    ok(await send(m.cb, m.matchId, "fine"), ChatMessage, 201);
    expect((await rowsOf(m.matchId)).length).toBe(21);
  });

  describe("the conversation vanishes when the match ends", () => {
    async function withHistory() {
      const m = await matchedPair();
      ok(await send(m.ca, m.matchId, "hello"), ChatMessage, 201);
      ok(await send(m.cb, m.matchId, "hi"), ChatMessage, 201);
      await read(m.cb, m.matchId); // creates a read marker
      expect(must(await admin.from("chat_reads").select("*").eq("match_id", m.matchId))).toHaveLength(1);
      return m;
    }

    async function expectGone(m: Matched) {
      expect(await rowsOf(m.matchId)).toHaveLength(0);
      expect(must(await admin.from("chat_reads").select("*").eq("match_id", m.matchId))).toHaveLength(0);
      for (const cookie of [m.ca, m.cb]) {
        err(await api("GET", routes.messages(m.matchId), { cookie }), 404, "not_found");
        err(await send(cookie, m.matchId, "anyone there?"), 404, "not_found");
      }
      expect(await rowsOf(m.matchId)).toHaveLength(0);
    }

    it("after unmatch", async () => {
      const m = await withHistory();
      expect((await api("POST", routes.unmatch(m.matchId), { cookie: m.ca })).status).toBe(204);
      await expectGone(m);
    });

    it("after block", async () => {
      const m = await withHistory();
      expect((await api("POST", routes.blocks, { cookie: m.cb }, { userId: m.a.id })).status).toBe(204);
      await expectGone(m);
    });

    it("after demo reset", async () => {
      const m = await withHistory();
      expect((await api("POST", routes.demoReset, { cookie: m.ca }, {})).status).toBe(200);
      await expectGone(m);
    });

    it("the DB itself refuses a message for an ended match (CUE03)", async () => {
      const m = await withHistory();
      must(await admin.rpc("end_match", { p_match_id: m.matchId, p_user_id: m.a.id, p_reason: "unmatch" }));
      const res = await admin
        .from("chat_messages")
        .insert({ match_id: m.matchId, sender_id: m.a.id, client_id: randomUUID(), body: "late" });
      expect(res.error?.code).toBe("CUE03");
      const read2 = await admin.from("chat_reads").insert({ match_id: m.matchId, user_id: m.a.id });
      expect(read2.error?.code).toBe("CUE03");
    });
  });
});

describe.skipIf(!stackUp)("chat RLS and direct database access (real stack)", () => {
  afterAll(cleanupUsers);

  it("participants can select their messages but not write; non-participants and anon see nothing; chat_reads is closed", async () => {
    const p = await newPair();
    await signal(p.a);
    const ack = await signal(p.b);
    const matchId = ack.match_id!;
    const third = await createUser();
    const row = must(
      await admin
        .from("chat_messages")
        .insert({ match_id: matchId, sender_id: p.a.id, client_id: randomUUID(), body: "rls probe" })
        .select("id")
        .single(),
    ) as { id: string };
    must(await admin.from("chat_reads").insert({ match_id: matchId, user_id: p.a.id }));

    const [ca, cb, cc, anon] = await Promise.all([anonClient(p.a), anonClient(p.b), anonClient(third), anonClient()]);

    for (const client of [ca, cb]) {
      const seen = must(await client.from("chat_messages").select("id, body").eq("match_id", matchId)) as { id: string }[];
      expect(seen.map((r) => r.id)).toEqual([row.id]);
    }
    for (const client of [cc, anon]) {
      const res = await client.from("chat_messages").select("*");
      expect(res.error ? [] : res.data).toEqual([]);
    }

    // No direct writes for anyone, participants included.
    for (const client of [ca, cb, cc, anon]) {
      const ins = await client
        .from("chat_messages")
        .insert({ match_id: matchId, sender_id: p.a.id, client_id: randomUUID(), body: "direct" });
      expect(ins.error).not.toBeNull();
      const upd = await client.from("chat_messages").update({ body: "edited" }).eq("id", row.id).select();
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
      const del = await client.from("chat_messages").delete().eq("id", row.id).select();
      expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);

      // chat_reads: not readable or writable from a browser at all.
      const r = await client.from("chat_reads").select("*");
      expect(r.error ? [] : r.data).toEqual([]);
      const rIns = await client.from("chat_reads").upsert({ match_id: matchId, user_id: p.b.id });
      expect(rIns.error).not.toBeNull();
    }
    const after = must(await admin.from("chat_messages").select("body").eq("match_id", matchId)) as { body: string }[];
    expect(after.map((r) => r.body)).toEqual(["rls probe"]);
    expect(must(await admin.from("chat_reads").select("user_id").eq("match_id", matchId))).toEqual([{ user_id: p.a.id }]);

    // After the match ends, even participants can no longer select.
    must(await admin.rpc("end_match", { p_match_id: matchId, p_user_id: p.a.id, p_reason: "unmatch" }));
    expect(must(await ca.from("chat_messages").select("*"))).toEqual([]);
  });
});
