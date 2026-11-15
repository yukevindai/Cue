import { randomUUID } from "node:crypto";
import { CHAT_MESSAGE_MAX_LENGTH, CHAT_PAGE_SIZE, type ChatMessage } from "@cue/contracts";
import { anonymousApi } from "./helpers/auth";
import { apiFor, must } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoLeak, expectNoMatches, sleep } from "./helpers/assertions";
import { linkDevice } from "./helpers/device";
import { expect, test } from "./helpers/fixtures";
import { watchTable } from "./helpers/realtime";
import { adminClient } from "./helpers/users";
import { matchedPair, signal, type Person } from "./helpers/scenario";

const send = (p: Person, matchId: string, body: string, clientId: string = randomUUID()) =>
  p.api.sendMessage(matchId, { clientId, body });

const bodies = (ms: ChatMessage[]) => ms.map((m) => m.body);

/** Unread count and lastMessageAt as `p` sees them on the match list. */
async function listing(p: Person, matchId: string) {
  const m = must(await p.api.listMatches(), "listMatches").matches.find((x) => x.id === matchId);
  if (!m) throw new Error("match missing from list");
  const one = must(await p.api.getMatch(matchId), "getMatch");
  expect(one.unreadCount, "GET /api/matches/[id] agrees with the list").toBe(m.unreadCount);
  expect(one.lastMessageAt).toBe(m.lastMessageAt);
  return m;
}

test.describe("chat: sending and reading", () => {
  test("two matched people exchange messages both ways: order, mine flags, no sender id", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const { a, b } = pair;

    expect(must(await a.api.listMessages(matchId))).toEqual({ messages: [], olderCursor: null });

    const first = await send(a, matchId, "hello from A");
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ matchId, mine: true, body: "hello from A" });
    expect(must(await send(b, matchId, "hi, B here")).mine).toBe(true);
    must(await send(a, matchId, "second from A"));
    must(await send(b, matchId, "  padded  "));

    const forA = must(await a.api.listMessages(matchId));
    const forB = must(await b.api.listMessages(matchId));
    const expected = ["hello from A", "hi, B here", "second from A", "padded"];
    expect(bodies(forA.messages), "oldest first, and bodies are trimmed").toEqual(expected);
    expect(bodies(forB.messages)).toEqual(expected);
    expect(forA.messages.map((m) => m.mine)).toEqual([true, false, true, false]);
    expect(forB.messages.map((m) => m.mine)).toEqual([false, true, false, true]);
    expect(forA.olderCursor).toBeNull();
    // Same ids on both sides, strictly non-decreasing timestamps.
    expect(forA.messages.map((m) => m.id)).toEqual(forB.messages.map((m) => m.id));
    const times = forA.messages.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));

    for (const m of [...forA.messages, ...forB.messages]) {
      expect(Object.keys(m).sort(), "no sender id or other column").toEqual(["body", "createdAt", "id", "matchId", "mine"]);
      expect(m.matchId).toBe(matchId);
    }
    const raw = [
      first.text,
      (await a.api.listMessages(matchId)).text,
      (await b.api.listMessages(matchId)).text,
    ];
    expectNoLeak(raw, { "A's user id": a.user.id, "B's user id": b.user.id, "sender_id": "sender_id" });
  });

  test("bodies are stored as typed: markup and links stay literal text; 1000 characters is the limit", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const markup = "<b>bold</b> https://example.com <script>alert(1)</script> \u{1F44B} 你好";
    const sent = must(await send(pair.a, matchId, markup));
    expect(sent.body).toBe(markup);
    const exact = "x".repeat(CHAT_MESSAGE_MAX_LENGTH);
    expect((await send(pair.b, matchId, exact)).status).toBe(201);
    const list = must(await pair.b.api.listMessages(matchId));
    expect(bodies(list.messages)).toEqual([markup, exact]);
  });
});

test.describe("chat: idempotency", () => {
  test("the same clientId twice stores one message: 201 then 200 with the same message", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const clientId = randomUUID();
    const first = await send(pair.a, matchId, "only once", clientId);
    const again = await send(pair.a, matchId, "only once", clientId);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.data).toEqual(first.data);
    // A retry with a different body still returns the stored message and creates nothing.
    const changed = await send(pair.a, matchId, "something else", clientId);
    expect(changed.status).toBe(200);
    expect(changed.data?.body).toBe("only once");

    expect(bodies(must(await pair.a.api.listMessages(matchId)).messages)).toEqual(["only once"]);
    expect(bodies(must(await pair.b.api.listMessages(matchId)).messages)).toEqual(["only once"]);
  });

  test("five concurrent sends with one clientId create exactly one row", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const clientId = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => send(pair.a, matchId, "race", clientId)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201), `exactly one create: ${statuses}`).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    const ids = new Set(results.map((r) => r.data?.id));
    expect(ids.size, "every response names the same message").toBe(1);

    const { data, error } = await adminClient().from("chat_messages").select("id").eq("client_id", clientId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(bodies(must(await pair.b.api.listMessages(matchId)).messages)).toEqual(["race"]);
  });

  test("the same clientId is a separate key per sender", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const clientId = randomUUID();
    expect((await send(pair.a, matchId, "from A", clientId)).status).toBe(201);
    expect((await send(pair.b, matchId, "from B", clientId)).status).toBe(201);
    expect(bodies(must(await pair.a.api.listMessages(matchId)).messages)).toEqual(["from A", "from B"]);
  });
});

test.describe("chat: pagination", () => {
  /** Inserts `count` messages straight into the table (the API is rate limited to 20 per 10 s). */
  async function seed(
    matchId: string,
    a: Person,
    b: Person,
    count: number,
    createdAt: (i: number) => string | undefined,
  ): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, i) => ({
      match_id: matchId,
      sender_id: i % 2 === 0 ? a.user.id : b.user.id,
      client_id: randomUUID(),
      body: `m-${String(i).padStart(3, "0")}`,
      ...(createdAt(i) ? { created_at: createdAt(i) } : {}),
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await adminClient().from("chat_messages").insert(rows.slice(i, i + 50));
      expect(error, `seed rows ${i}..`).toBeNull();
    }
    return rows.map((r) => r.body);
  }

  async function walkBack(p: Person, matchId: string) {
    const newest = must(await p.api.listMessages(matchId));
    const pages = [newest];
    let cursor = newest.olderCursor;
    while (cursor) {
      const page = must(await p.api.listMessages(matchId, cursor));
      pages.push(page);
      cursor = page.olderCursor;
      if (pages.length > 20) throw new Error("cursor never ends");
    }
    // Oldest page first.
    return { pages, all: [...pages].reverse().flatMap((pg) => pg.messages) };
  }

  test("more than a page: olderCursor walks back to the first message, no duplicates, no gaps", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const base = Date.now() - 600_000;
    const seeded = await seed(matchId, pair.a, pair.b, 2 * CHAT_PAGE_SIZE + 17, (i) => new Date(base + i * 1000).toISOString());
    // And two sent through the real route, newer than every seeded row.
    must(await send(pair.a, matchId, "api-one"));
    must(await send(pair.b, matchId, "api-two"));
    const expected = [...seeded, "api-one", "api-two"];

    const { pages, all } = await walkBack(pair.b, matchId);
    expect(pages.map((p) => p.messages.length)).toEqual([CHAT_PAGE_SIZE, CHAT_PAGE_SIZE, 19]);
    expect(pages[pages.length - 1].olderCursor).toBeNull();
    expect(bodies(all), "every message once, in order").toEqual(expected);
    expect(new Set(all.map((m) => m.id)).size).toBe(expected.length);
    expect(bodies(pages[0].messages).at(-1)).toBe("api-two");
    // mine flags follow the sender, page by page.
    for (const m of all) expect(m.mine).toBe(["api-two"].includes(m.body) || (m.body.startsWith("m-") && Number(m.body.slice(2)) % 2 === 1));
  });

  test("rows with identical timestamps are still paged without duplicates or gaps", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const same = new Date(Date.now() - 60_000).toISOString();
    const seeded = await seed(matchId, pair.a, pair.b, 130, () => same);
    const { all } = await walkBack(pair.a, matchId);
    expect(all).toHaveLength(seeded.length);
    expect(new Set(all.map((m) => m.id)).size, "no duplicates").toBe(seeded.length);
    expect([...bodies(all)].sort(), "no gaps").toEqual([...seeded].sort());
  });

  test("a tampered cursor is a 400, never a server error or someone else's data", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const base = Date.now() - 600_000;
    await seed(matchId, pair.a, pair.b, CHAT_PAGE_SIZE + 3, (i) => new Date(base + i * 1000).toISOString());
    const real = must(await pair.a.api.listMessages(matchId)).olderCursor;
    expect(real).toBeTruthy();

    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const decoded = Buffer.from(real!, "base64url").toString("utf8");
    const [ts, id] = decoded.split("|");
    const tampered = [
      "garbage",
      "",
      "!!!",
      real!.slice(0, -4) + "AAAA" + "!",
      b64("not-a-timestamp|" + id),
      b64(`${ts}|not-a-uuid`),
      b64(`${ts}`),
      b64(`${ts}|${id}|extra`),
      b64(`2026-01-01T00:00:00Z"),id.gt.0,or(a.eq."|${id}`),
      b64(`${ts}"|${id}`),
      "A".repeat(400),
    ];
    for (const before of tampered) {
      const r = await pair.a.api.listMessages(matchId, before);
      expect(r.status, `before=${before.slice(0, 40)}`).toBe(400);
      expect(r.error?.code).toBe("invalid_request");
    }
    // The real cursor still works.
    expect(must(await pair.a.api.listMessages(matchId, real!)).messages).toHaveLength(3);
  });
});

test.describe("chat: unread and lastMessageAt", () => {
  test("B's unread rises as A sends, lastMessageAt updates, B reading the newest page resets it; own messages never count", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const { a, b } = pair;
    expect((await listing(b, matchId)).unreadCount).toBe(0);
    expect((await listing(b, matchId)).lastMessageAt).toBeNull();

    const m1 = must(await send(a, matchId, "one"));
    let lb = await listing(b, matchId);
    expect(lb.unreadCount).toBe(1);
    expect(lb.lastMessageAt).not.toBeNull();
    expect(Math.abs(Date.parse(lb.lastMessageAt!) - Date.parse(m1.createdAt))).toBeLessThanOrEqual(1);
    expect((await listing(a, matchId)).unreadCount, "own message is not unread for the sender").toBe(0);

    await sleep(20);
    const m2 = must(await send(a, matchId, "two"));
    must(await send(a, matchId, "three"));
    lb = await listing(b, matchId);
    expect(lb.unreadCount).toBe(3);
    expect(Date.parse(lb.lastMessageAt!)).toBeGreaterThan(Date.parse(m2.createdAt) - 1);
    expect((await listing(a, matchId)).unreadCount).toBe(0);

    // B opens the conversation (newest page): read.
    expect(bodies(must(await b.api.listMessages(matchId)).messages)).toEqual(["one", "two", "three"]);
    expect((await listing(b, matchId)).unreadCount).toBe(0);
    // A's view of the thread is unaffected by B reading.
    expect((await listing(a, matchId)).unreadCount).toBe(0);

    // B replies: counts for A only; B's own message is never unread for B.
    const reply = must(await send(b, matchId, "reply"));
    expect((await listing(b, matchId)).unreadCount).toBe(0);
    const la = await listing(a, matchId);
    expect(la.unreadCount).toBe(1);
    expect(Math.abs(Date.parse(la.lastMessageAt!) - Date.parse(reply.createdAt))).toBeLessThanOrEqual(1);
    expect((await listing(b, matchId)).lastMessageAt, "lastMessageAt covers either person's messages").toBe(la.lastMessageAt);

    // A sends again after B read: unread is 1, not 4.
    must(await send(a, matchId, "four"));
    expect((await listing(b, matchId)).unreadCount).toBe(1);
    must(await b.api.listMessages(matchId));
    expect((await listing(b, matchId)).unreadCount).toBe(0);
  });
});

test.describe("chat: access", () => {
  test("a third account gets 404 on GET and POST and nothing is stored", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    must(await send(pair.a, matchId, "private words"));
    const third = await world.person();
    const get = await third.api.listMessages(matchId);
    const post = await send(third, matchId, "intruder");
    expect(get.status).toBe(404);
    expect(get.error?.code).toBe("not_found");
    expect(post.status).toBe(404);
    expect(post.error?.code).toBe("not_found");
    expectNoLeak([get.text, post.text], { body: "private words", "A's id": pair.a.user.id });
    expect(bodies(must(await pair.a.api.listMessages(matchId)).messages)).toEqual(["private words"]);
  });

  test("a malformed or unknown match id is 404, never a server error", async ({ world }) => {
    const p = await world.person();
    for (const id of ["not-a-uuid", randomUUID(), "00000000-0000-0000-0000-000000000000", "1' or '1'='1"]) {
      expect((await p.api.listMessages(id)).status, `GET ${id}`).toBe(404);
      expect((await send(p, id, "hi")).status, `POST ${id}`).toBe(404);
    }
  });

  test("unauthenticated requests are 401", async ({ world }) => {
    const { matchId } = await matchedPair(world);
    const anon = await anonymousApi();
    try {
      const api = apiFor(anon);
      const get = await api.listMessages(matchId);
      const post = await api.sendMessage(matchId, { clientId: randomUUID(), body: "hi" });
      expect(get.status).toBe(401);
      expect(post.status).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test("a glasses device token is 401 on both routes, even for the owner of the match", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const device = await linkDevice(pair.a);
    try {
      const get = await device.api.listMessages(matchId);
      const post = await device.api.sendMessage(matchId, { clientId: randomUUID(), body: "from glasses" });
      expect(get.status).toBe(401);
      expect(post.status).toBe(401);
      expect(must(await pair.a.api.listMessages(matchId)).messages).toEqual([]);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("invalid bodies are 400 and store nothing", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const ok = () => ({ clientId: randomUUID(), body: "fine" });
    const cases: Array<[string, Record<string, unknown>]> = [
      [`${CHAT_MESSAGE_MAX_LENGTH + 1} characters`, { ...ok(), body: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }],
      ["empty body", { ...ok(), body: "" }],
      ["whitespace-only body", { ...ok(), body: "   \n\t  " }],
      ["no body", { clientId: randomUUID() }],
      ["body that is not a string", { ...ok(), body: 42 }],
      ["no clientId", { body: "fine" }],
      ["clientId that is not a uuid", { ...ok(), clientId: "not-a-uuid" }],
      ["an extra key (senderId)", { ...ok(), senderId: pair.b.user.id }],
      ["an extra key (matchId)", { ...ok(), matchId }],
      ["an extra key (createdAt)", { ...ok(), createdAt: "2020-01-01T00:00:00Z" }],
    ];
    for (const [name, body] of cases) {
      const r = await pair.a.api.sendMessage(matchId, body);
      expect(r.status, name).toBe(400);
      expect(r.error?.code, name).toBe("invalid_request");
    }
    expect(must(await pair.a.api.listMessages(matchId)).messages, "nothing was stored").toEqual([]);
  });
});

test.describe("chat: lifecycle (messages die with the match)", () => {
  async function bothGone(a: Person, b: Person, matchId: string) {
    for (const who of [a, b]) {
      const get = await who.api.listMessages(matchId);
      const post = await send(who, matchId, "too late");
      expect(get.status, "GET after the match ended").toBe(404);
      expect(post.status, "POST after the match ended").toBe(404);
    }
  }

  async function seedConversation(a: Person, b: Person, matchId: string) {
    must(await send(a, matchId, "A says hi"));
    must(await send(b, matchId, "B says hi"));
    must(await b.api.listMessages(matchId));
  }

  async function rowCount(matchId: string): Promise<number> {
    const { count, error } = await adminClient()
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("match_id", matchId);
    expect(error).toBeNull();
    return count ?? 0;
  }

  test("unmatch: both get 404, the rows are gone, and matching again starts empty", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    await seedConversation(pair.a, pair.b, matchId);
    expect(await rowCount(matchId)).toBe(2);

    expect((await pair.b.api.unmatch(matchId)).status).toBe(204);
    await bothGone(pair.a, pair.b, matchId);
    expect(await rowCount(matchId)).toBe(0);

    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect(forA.id).not.toBe(matchId);
    expect(forA.unreadCount).toBe(0);
    expect(forA.lastMessageAt).toBeNull();
    expect(must(await pair.a.api.listMessages(forA.id))).toEqual({ messages: [], olderCursor: null });
    expect(must(await pair.b.api.listMessages(forA.id))).toEqual({ messages: [], olderCursor: null });
    // The old conversation is still unreachable.
    await bothGone(pair.a, pair.b, matchId);
  });

  test("block: both get 404 and the rows are gone", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    await seedConversation(pair.a, pair.b, matchId);
    expect((await pair.a.api.block(pair.b.user.id)).status).toBe(204);
    await expectNoMatches(pair.a.api, pair.b.api);
    await bothGone(pair.a, pair.b, matchId);
    expect(await rowCount(matchId)).toBe(0);
  });

  test("demo reset: both get 404, the rows are gone, and matching again starts empty", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    await seedConversation(pair.a, pair.b, matchId);
    must(await pair.a.api.reset(false));
    await bothGone(pair.a, pair.b, matchId);
    expect(await rowCount(matchId)).toBe(0);

    // The pair is still checked in after a reset that does not leave; match again.
    must(await pair.a.api.setMode(true));
    must(await pair.b.api.setMode(true));
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect(forA.id).not.toBe(matchId);
    expect(must(await pair.a.api.listMessages(forA.id)).messages).toEqual([]);
    expect(must(await pair.b.api.listMessages(forA.id)).messages).toEqual([]);
  });
});

test.describe("chat: realtime", () => {
  test("B receives a chat_messages event when A sends; a third signed-in account receives none", async ({ world }) => {
    const { pair, matchId } = await matchedPair(world);
    const third = await world.person();
    const watchB = await watchTable(pair.b, "chat_messages");
    const watchThird = await watchTable(third, "chat_messages");
    // SUBSCRIBED can arrive a moment before Realtime is reading the WAL for this table.
    await sleep(750);
    try {
      const sent = must(await send(pair.a, matchId, "realtime hello"));
      const ev = await watchB.waitFor(5000, (e) => e.eventType === "INSERT");
      expect(ev, "B gets an INSERT event").not.toBeNull();
      expect(ev!.new.id).toBe(sent.id);
      expect(ev!.new.match_id).toBe(matchId);

      // A second message arrives as a second event; a reply from B reaches B's own subscription too.
      must(await send(pair.b, matchId, "and back"));
      await sleep(2500);
      expect(watchB.events.filter((e) => e.eventType === "INSERT")).toHaveLength(2);

      // Same table, different account: RLS keeps every INSERT/UPDATE away from them.
      // (DELETE events are not RLS-filtered by Realtime, see cross-glasses.api.spec.ts.)
      expect(watchThird.events.filter((e) => e.eventType !== "DELETE")).toEqual([]);
    } finally {
      await watchB.close();
      await watchThird.close();
    }
  });
});

test.describe("chat: rate limit", () => {
  test("more than 20 sends inside 10 s: the excess is 429 rate_limited; the other person is unaffected", async ({ world }) => {
    test.setTimeout(90_000);
    // Own users: the limiter is per sender, so this cannot starve any other test.
    const { pair, matchId } = await matchedPair(world);
    const t0 = Date.now();
    const results = [];
    for (let i = 0; i < 25; i++) results.push(await send(pair.a, matchId, `burst ${i}`));
    const took = Date.now() - t0;
    expect(took, "the burst must fit inside one 10 s window for the count to be exact").toBeLessThan(9_000);

    const created = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 429);
    expect(created).toHaveLength(20);
    expect(limited).toHaveLength(5);
    expect(results.slice(0, 20).every((r) => r.status === 201)).toBe(true);
    expect(limited.every((r) => r.error?.code === "rate_limited")).toBe(true);

    // Limited sends were not stored.
    const all = must(await pair.b.api.listMessages(matchId)).messages;
    expect(all).toHaveLength(20);
    expect(bodies(all)).toEqual(Array.from({ length: 20 }, (_, i) => `burst ${i}`));

    // The limit is per sender.
    expect((await send(pair.b, matchId, "B is fine")).status).toBe(201);

    // And the window slides: A can send again once it has passed.
    await sleep(Math.max(0, 10_500 - (Date.now() - t0)));
    expect((await send(pair.a, matchId, "after the window")).status).toBe(201);
  });
});
