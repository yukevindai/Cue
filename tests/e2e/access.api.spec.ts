import { randomUUID } from "node:crypto";
import { anonymousApi } from "./helpers/auth";
import { apiFor, interestEvent, must, wasRejected } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoLeak, expectNoMatches, sleep } from "./helpers/assertions";
import { watchTable } from "./helpers/realtime";
import { expect, test } from "./helpers/fixtures";
import { signal } from "./helpers/scenario";

test.describe("authentication", () => {
  test("an unauthenticated request gets 401 on every session route", async () => {
    const anon = await anonymousApi();
    const api = apiFor(anon);
    const id = randomUUID();
    const calls: Array<[string, () => Promise<{ status: number; error?: { code: string } }>]> = [
      ["GET /api/profile", () => api.getProfile()],
      [
        "PUT /api/profile",
        () =>
          api.putProfile({
            displayName: "x",
            photoUrl: null,
            bio: "",
            interests: [],
            sharing: { photo: true, bio: true, interests: true, aiAssist: true },
          }),
      ],
      ["GET /api/encounter", () => api.getEncounter()],
      ["POST /api/encounter/mode", () => api.setMode(true)],
      ["POST /api/demo/session", () => api.createSession("Nowhere")],
      ["POST /api/demo/session/join", () => api.joinSession("ABCDEF")],
      ["POST /api/demo/reset", () => api.reset(false)],
      ["POST /api/interest", () => api.interest(interestEvent(id))],
      ["GET /api/matches", () => api.listMatches()],
      ["GET /api/matches/[id]", () => api.getMatch(id)],
      ["POST /api/matches/[id]/unmatch", () => api.unmatch(id)],
      ["POST /api/matches/[id]/suggestions", () => api.suggestions(id)],
      ["POST /api/blocks", () => api.block(id)],
      ["POST /api/devices/pair", () => api.devicePair()],
      ["DELETE /api/devices", () => api.deviceUnlink()],
      ["GET /api/devices/me", () => api.deviceMe()],
    ];
    try {
      for (const [name, run] of calls) {
        const r = await run();
        expect(r.status, `${name} without credentials`).toBe(401);
        expect(r.error?.code, `${name} error code`).toBe("unauthenticated");
      }
    } finally {
      await anon.dispose();
    }
  });
});

test.describe("third account", () => {
  test("is refused at join and never sees, reads or touches the pair's data", async ({ world, fake }) => {
    const tag = randomUUID().slice(0, 8);
    const pair = await world.pair({ a: { bio: `bio-A-${tag}` }, b: { bio: `bio-B-${tag}` } });
    const third = await world.person({ bio: `bio-C-${tag}` });
    const joinCode = (must(await pair.a.api.getEncounter()).session ?? { joinCode: "" }).joinCode;

    const join = await third.api.joinSession(joinCode);
    expect(join.status).toBe(409);
    expect(join.error?.code).toBe("session_full");

    // The pair is unaffected and can still match.
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    const texts: string[] = [join.text];
    const watch = async <T extends { text: string }>(p: Promise<T>) => {
      const r = await p;
      texts.push(r.text);
      return r;
    };

    // No session, no matches.
    const enc = await watch(third.api.getEncounter());
    expect(enc.ok).toBe(true);
    expect(enc.data?.session).toBeNull();
    const list = await watch(third.api.listMatches());
    expect(list.data?.matches).toEqual([]);

    // Cannot read, unmatch, or request suggestions for the pair's match.
    const card = await watch(third.api.getMatch(forA.id));
    expect(card.status).toBe(404);
    expect(card.error?.code).toBe("not_found");
    const unmatch = await watch(third.api.unmatch(forA.id));
    expect(unmatch.status).toBe(404);
    const sugg = await watch(third.api.suggestions(forA.id));
    expect(sugg.status).toBe(404);
    expect(sugg.error?.code).toBe("not_found");
    expect(await fake.requests(), "a refused suggestions request makes no model call").toHaveLength(0);
    // ...and the pair's match is intact.
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    // Cannot inject signals into the pair's session.
    const sneaky = await watch(third.api.interest(interestEvent(pair.session.id)));
    expect(wasRejected(sneaky, "not_in_session")).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    // Profile routes only ever return the caller's own profile, even if asked for another.
    const own = await watch(third.api.getProfile());
    expect(own.data?.userId).toBe(third.user.id);
    for (const path of [
      `/api/profile?userId=${pair.a.user.id}`,
      `/api/profile?user_id=${pair.b.user.id}`,
    ]) {
      const res = await third.ctx.get(path, { failOnStatusCode: false, maxRedirects: 0 });
      const text = await res.text();
      texts.push(text);
      if (res.ok()) expect((JSON.parse(text) as { userId: string }).userId).toBe(third.user.id);
    }
    for (const path of [`/api/profile/${pair.a.user.id}`, `/api/profiles/${pair.b.user.id}`, `/api/users/${pair.a.user.id}`]) {
      const res = await third.ctx.get(path, { failOnStatusCode: false, maxRedirects: 0 });
      texts.push(await res.text());
      expect(res.status(), `${path} must not exist or must refuse`).toBeGreaterThanOrEqual(400);
    }

    expectNoLeak(texts, {
      "A's user id": pair.a.user.id,
      "B's user id": pair.b.user.id,
      "A's display name": pair.a.displayName,
      "B's display name": pair.b.displayName,
      "A's bio": `bio-A-${tag}`,
      "B's bio": `bio-B-${tag}`,
      "the match id": forA.id,
    });
  });

  test("gets no realtime events about the pair's match", async ({ world }) => {
    const pair = await world.pair();
    const third = await world.person();
    const watcher = await watchTable(third, "matches");
    try {
      must(await signal(pair, pair.a));
      must(await signal(pair, pair.b));
      await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
      expect(await watcher.waitFor(2000), "RLS must hide the match from a non-participant").toBeNull();
    } finally {
      await watcher.close();
    }
  });
});

test.describe("match access", () => {
  test("a non-participant cannot read a match or request suggestions", async ({ world, fake }) => {
    const pair = await world.pair();
    const stranger = await world.person();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    expect((await stranger.api.getMatch(forA.id)).status).toBe(404);
    expect((await stranger.api.suggestions(forA.id)).status).toBe(404);
    // A malformed id looks the same as an unknown one.
    expect((await stranger.api.getMatch("not-a-uuid")).status).toBe(404);
    expect((await stranger.api.suggestions(randomUUID())).status).toBe(404);
    expect(await fake.requests()).toHaveLength(0);
  });

  test("after unmatch the former participants get 404 for the match and suggestions", async ({ world, fake }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    expect((await pair.a.api.unmatch(forA.id)).status).toBe(204);

    await expectNoMatches(pair.a.api, pair.b.api);
    for (const who of [pair.a, pair.b]) {
      const card = await who.api.getMatch(forA.id);
      expect(card.status).toBe(404);
      expect(card.error?.code).toBe("not_found");
      const sugg = await who.api.suggestions(forA.id);
      expect(sugg.status).toBe(404);
      expect(sugg.error?.code).toBe("not_found");
    }
    expect(await fake.requests(), "no model call after unmatch").toHaveLength(0);
    // Unmatching twice does not succeed.
    expect((await pair.b.api.unmatch(forA.id)).status).toBe(404);
  });
});

test.describe("one-sided interest is invisible", () => {
  test("A's pending signal changes nothing B can read or receive", async ({ world }) => {
    const pair = await world.pair();
    const strip = (e: unknown) => {
      const { serverTime: _ignored, ...rest } = e as Record<string, unknown>;
      void _ignored;
      return rest;
    };
    const before = must(await pair.b.api.getEncounter());

    const watchers = [
      await watchTable(pair.b, "matches"),
      await watchTable(pair.b, "interest_events"),
      await watchTable(pair.b, "demo_session_members"),
    ];
    try {
      // Let late change events from the pair's own setup (session join, mode on) drain, then start counting.
      await sleep(1500);
      for (const w of watchers) w.events.length = 0;
      const ack = must(await signal(pair, pair.a), "A signal");
      expect(ack.matched).toBe(false);

      const encB = await pair.b.api.getEncounter();
      expect(encB.data?.pendingSignal, "B must not see a pending signal").toBeNull();
      expect(strip(encB.data)).toEqual(strip(before));
      const matchesB = await pair.b.api.listMatches();
      expect(matchesB.data?.matches).toEqual([]);
      expectNoLeak([encB.text, matchesB.text], {
        "A's user id": pair.a.user.id,
        "A's event id": ack.eventId,
        "A's display name": pair.a.displayName,
      });

      // Realtime for B: nothing at all (own-row RLS on interest_events / members, participant RLS on matches).
      await sleep(1500);
      for (const w of watchers) expect(w.events).toEqual([]);
    } finally {
      for (const w of watchers) await w.close();
    }
  });

  test("B's own ack reveals nothing about A beyond `matched`", async ({ world }) => {
    const pair = await world.pair();
    const ackA = must(await signal(pair, pair.a));
    const res = await signal(pair, pair.b);
    const ackB = must(res);
    expect(ackB.matched).toBe(true);
    expect(Object.keys(ackB).sort()).toEqual(["eventId", "expiresAt", "matched", "reason", "receivedAt", "status"]);
    expectNoLeak([res.text], {
      "A's user id": pair.a.user.id,
      "A's display name": pair.a.displayName,
      "A's event id": ackA.eventId,
    });
  });
});
