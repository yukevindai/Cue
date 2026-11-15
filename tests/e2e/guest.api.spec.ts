// Guest accounts ("Hi, my name is Sam"): the server routes and what a guest can do afterwards.
// Server path only. Speech recognition is not involved here (see guest-voice.ui.spec.ts, which
// replaces the browser's speech with fakes); a guest's device token here is not real glasses.
import {
  DEFAULT_SHARING,
  GUEST_EMAIL_DOMAIN,
  GuestDeviceResult,
  GuestHandoff,
  GuestResult,
  parseIntroName,
  routes,
} from "@cue/contracts";
import { GUEST_RATE_LIMIT } from "../../apps/web/src/server/guest-config";
import { BASE_URL } from "./helpers/env";
import { addressedApi, deviceApi, freshAddress } from "./helpers/auth";
import { apiFor, interestEvent, must, parseApiError, rawCall } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoLeak, expectNoMatches } from "./helpers/assertions";
import { linkDevice } from "./helpers/device";
import { expect, test } from "./helpers/fixtures";
import { freshSpot, locate, metresNorth } from "./helpers/geo";
import { signal, type Guest, type World } from "./helpers/scenario";
import { countGuestUsers } from "./helpers/users";
import { randomUUID } from "node:crypto";

const GUEST_DOMAIN = `@${GUEST_EMAIL_DOMAIN}`;

/** A letters-only name with a random tail, so every guest in a test is told apart. */
function uniqueName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let tail = "";
  for (let i = 0; i < 8; i++) tail += letters[Math.floor(Math.random() * letters.length)];
  return `Tess ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** A guest signed in through its own cookies, made with a device-route guest and the handoff link. */
async function deviceGuest(world: World, intro = `um hey, I'm ${uniqueName()}`) {
  const address = freshAddress();
  const anon = await addressedApi(address);
  world.onCleanup(() => anon.dispose());
  world.watchGuests();
  const res = await rawCall(anon, "POST", routes.guestDevice, { intro, deviceLabel: "E2E Glasses" });
  expect(res.status, res.text).toBe(201);
  const created = GuestDeviceResult.parse(res.json);
  const device = await deviceApi(created.deviceToken);
  world.onCleanup(() => device.dispose());
  return { created, address, anon, device, deviceApi: apiFor(device) };
}

test.describe("guest accounts: creation", () => {
  test("several phrasings give the name parseIntroName reads, signed in with no email or password in the answer", async ({ world }) => {
    const cases: Array<[string, string]> = [
      ["Hi, my name is Sam", "Sam"],
      ["hi, my name is sam.", "Sam"],
      ["I'm Quinn", "Quinn"],
      ["call me Alex Rivera", "Alex Rivera"],
      ["yo it's priya, nice to meet you", "Priya"],
      ["um hey there, I'm José", "José"],
      ["Mei", "Mei"],
    ];
    for (const [intro, expected] of cases) {
      expect(parseIntroName(intro), `parseIntroName(${intro})`).toBe(expected);
      const guest = await world.guest({ intro });
      expect(guest.displayName, intro).toBe(expected);
    }
  });

  test("the response is only the name; the session cookies sign that browser in; the profile is name-only with default sharing", async ({ world }) => {
    world.watchGuests();
    const ctx = await addressedApi();
    world.onCleanup(() => ctx.dispose());
    const name = uniqueName();
    const res = await rawCall(ctx, "POST", routes.guest, { intro: `Hi, my name is ${name}` });
    expect(res.status, res.text).toBe(201);
    expect(GuestResult.parse(res.json)).toEqual({ displayName: name });
    expect(Object.keys(res.json as object)).toEqual(["displayName"]);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.text).not.toContain("@");
    expect(res.text).not.toContain(GUEST_EMAIL_DOMAIN);
    expect(res.text).not.toMatch(/password|token|session/i);

    const guest = await world.adoptGuest(ctx, "n/a");
    const profile = must(await guest.api.getProfile());
    expect(profile).toMatchObject({
      displayName: name,
      isGuest: true,
      bio: "",
      interests: [],
      photoUrl: null,
      age: null,
      cards: [],
      archetype: null,
      sharing: DEFAULT_SHARING,
    });
    const profileText = JSON.stringify(profile);
    expect(profileText).not.toContain("@");
    expect(profileText).not.toContain(GUEST_EMAIL_DOMAIN);
    expect(guest.email.endsWith(GUEST_DOMAIN), "the account carries the guest address").toBe(true);
  });

  test("a normal account says isGuest false", async ({ world }) => {
    const person = await world.person();
    expect(must(await person.api.getProfile()).isGuest).toBe(false);
  });

  test("unreadable intros are 400 and leave no account behind; so do extra keys and a bad body", async ({ world }) => {
    world.watchGuests();
    const ctx = await addressedApi();
    world.onCleanup(() => ctx.dispose());
    const before = await countGuestUsers();
    const bad: unknown[] = [
      { intro: "hello" },
      { intro: "um hi" },
      { intro: "my name is" },
      { intro: "1234" },
      { intro: "this sentence is far too long to be anybody's name at all" },
      { intro: "   " },
      { intro: "" },
      { intro: "Sam", extra: 1 },
      { intro: 5 },
      {},
      { name: "Sam" },
    ];
    for (const body of bad) {
      const res = await rawCall(ctx, "POST", routes.guest, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(parseApiError(res).code).toBe("invalid_request");
      expect(res.headers["set-cookie"] ?? "", "no session for a refused guest").not.toMatch(/auth-token/);
    }
    const tooLong = await rawCall(ctx, "POST", routes.guest, { intro: `Hi, my name is ${"a".repeat(300)}` });
    expect(tooLong.status).toBe(400);
    const notJson = await ctx.fetch(routes.guest, {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: "{not json",
      failOnStatusCode: false,
    });
    expect(notJson.status()).toBe(400);
    expect(await countGuestUsers(), "no account was made for any refused request").toBe(before);
  });

  test("the per-address limit: the 41st request from one address is 429 and makes no account; another address is not affected", async ({ world }) => {
    world.watchGuests();
    const busyAddress = freshAddress();
    const busy = await addressedApi(busyAddress);
    const other = await addressedApi();
    world.onCleanup(() => busy.dispose());
    world.onCleanup(() => other.dispose());
    const before = await countGuestUsers();
    for (let i = 0; i < GUEST_RATE_LIMIT.limit; i++) {
      const r = await rawCall(busy, "POST", routes.guest, { intro: "hello" });
      expect(r.status, `request ${i + 1}`).toBe(400);
    }
    const limited = await rawCall(busy, "POST", routes.guest, { intro: "hello" });
    expect(limited.status).toBe(429);
    expect(parseApiError(limited).code).toBe("rate_limited");
    // Even a valid introduction is refused, and nothing is created for it.
    const valid = await rawCall(busy, "POST", routes.guest, { intro: "Hi, my name is Limit" });
    expect(valid.status).toBe(429);
    expect(await countGuestUsers()).toBe(before);

    // Another address still gets in.
    expect((await rawCall(other, "POST", routes.guest, { intro: "hello" })).status).toBe(400);
    const guest = await world.guest({ intro: "Hi, my name is Other", address: freshAddress() });
    expect(guest.displayName).toBe("Other");
    // The limit keys on the first x-forwarded-for entry only: a forged tail does not escape it.
    const chained = await rawCall(other, "POST", routes.guest, { intro: "hello" }, { "x-forwarded-for": `${busyAddress}, 203.0.113.9` });
    expect(chained.status).toBe(429);
  });
});

test.describe("guest accounts: a guest is a full member", () => {
  test("hosts a venue, turns Encounter mode on, signals, matches a normal account, chats both ways, and unmatches", async ({ world }) => {
    const guest = await world.guest();
    const member = await world.person();
    const venue = await world.venue(guest);
    await world.checkIn(member, venue);
    must(await guest.api.setMode(true));
    must(await member.api.setMode(true));
    expect(must(await guest.api.getEncounter())).toMatchObject({ encounterMode: true, ready: true });

    expect(must(await signal(null, guest)).status).toBe("accepted");
    expect(must(await signal(null, member)).matched).toBe(true);
    const { forA, forB } = await expectExactlyOneSharedMatch(guest.api, member.api);
    expect(forA.other.userId).toBe(member.user.id);
    expect(forB.other.userId).toBe(guest.id);
    expect(forB.other.displayName).toBe(guest.displayName);
    expect(forA.venueLabel).toBe(venue.name);

    // Chat both ways.
    const matchId = forA.id;
    must(await guest.api.sendMessage(matchId, { clientId: randomUUID(), body: "hello from the guest" }));
    must(await member.api.sendMessage(matchId, { clientId: randomUUID(), body: "hi back" }));
    const forGuest = must(await guest.api.listMessages(matchId)).messages;
    const forMember = must(await member.api.listMessages(matchId)).messages;
    expect(forGuest.map((m) => m.body)).toEqual(["hello from the guest", "hi back"]);
    expect(forMember.map((m) => m.body)).toEqual(["hello from the guest", "hi back"]);
    expect(forGuest.map((m) => m.mine)).toEqual([true, false]);
    expect(forMember.map((m) => m.mine)).toEqual([false, true]);

    // The guest ends it.
    expect((await guest.api.unmatch(matchId)).status).toBe(204);
    await expectNoMatches(guest.api, member.api);
    expect((await member.api.listMessages(matchId)).status).toBe(404);
  });

  test("by phone location alone: two people nearby, one of them a guest, match as 'Nearby'", async ({ world }) => {
    const guest = await world.guest();
    const member = await world.person();
    const spot = freshSpot();
    must(await guest.api.setMode(true));
    must(await member.api.setMode(true));
    await locate(guest, spot, 5);
    await locate(member, metresNorth(spot, 12), 5);
    must(await signal(null, member));
    expect(must(await signal(null, guest)).matched).toBe(true);
    const { forA, forB } = await expectExactlyOneSharedMatch(guest.api, member.api);
    for (const card of [forA, forB]) expect(card).toMatchObject({ venueLabel: "Nearby", venueLabelSource: "phone_location" });
  });

  test("two guests match each other and chat; one blocks the other, which ends the match and keeps them apart", async ({ world }) => {
    const first = await world.guest();
    const second = await world.guest();
    const venue = await world.venue(first);
    await world.checkIn(second, venue);
    must(await first.api.setMode(true));
    must(await second.api.setMode(true));
    must(await signal(null, first));
    expect(must(await signal(null, second)).matched).toBe(true);
    const { forA } = await expectExactlyOneSharedMatch(first.api, second.api);
    must(await second.api.sendMessage(forA.id, { clientId: randomUUID(), body: "guest to guest" }));
    expect(must(await first.api.listMessages(forA.id)).messages.map((m) => m.body)).toEqual(["guest to guest"]);

    expect((await first.api.block(second.id)).status).toBe(204);
    await expectNoMatches(first.api, second.api);
    // Blocked: signalling again never matches, in either order.
    must(await signal(null, first));
    expect(must(await signal(null, second)).matched).toBe(false);
    await expectNoMatches(first.api, second.api);
  });

  test("the guest's email never appears in anything the other person can fetch, nor in the guest's own answers", async ({ world }) => {
    const guest = await world.guest();
    const member = await world.person();
    const other = await world.guest();
    const venue = await world.venue(guest);
    await world.checkIn(member, venue);
    await world.checkIn(other, venue);
    must(await guest.api.setMode(true));
    must(await member.api.setMode(true));
    must(await signal(null, guest));
    must(await signal(null, member));
    const { forB } = await expectExactlyOneSharedMatch(guest.api, member.api);
    const matchId = forB.id;
    must(await member.api.sendMessage(matchId, { clientId: randomUUID(), body: "hello guest" }));
    const sent = await guest.api.sendMessage(matchId, { clientId: randomUUID(), body: "hello member" });
    expect(sent.status).toBe(201);

    const seenByMember = [
      (await member.api.listMatches()).text,
      (await member.api.getMatch(matchId)).text,
      (await member.api.listMessages(matchId)).text,
      (await member.api.getEncounter()).text,
      (await member.api.getProfile()).text,
    ];
    const seenByGuest = [
      (await guest.api.getProfile()).text,
      (await guest.api.getEncounter()).text,
      (await guest.api.listMatches()).text,
      (await guest.api.getMatch(matchId)).text,
      (await guest.api.listMessages(matchId)).text,
      sent.text,
    ];
    const needles = {
      "the guest's email": guest.email,
      "the guest domain": GUEST_EMAIL_DOMAIN,
      "a guest-<uuid> local part": "guest-",
      "the other guest's email": other.email,
    };
    expectNoLeak([...seenByMember, ...seenByGuest], needles);
    // The member's own address does not reach the guest either.
    expectNoLeak(seenByGuest, { "the member's email": member.user.email });
  });
});

test.describe("guest accounts: glasses (device) route", () => {
  test("needs a real introduction; the token works on /api/devices/me and a Mentra touch signal matches", async ({ world }) => {
    world.watchGuests();
    const anon = await addressedApi();
    world.onCleanup(() => anon.dispose());
    const before = await countGuestUsers();
    for (const intro of ["Sam", "hey there", "hello", "my name is", "I am"]) {
      const res = await rawCall(anon, "POST", routes.guestDevice, { intro });
      expect(res.status, intro).toBe(400);
      expect(parseApiError(res).code).toBe("invalid_request");
    }
    expect((await rawCall(anon, "POST", routes.guestDevice, { intro: "I'm Sam", extra: true })).status).toBe(400);
    expect((await rawCall(anon, "POST", routes.guestDevice, { intro: "I'm Sam", deviceLabel: "" })).status).toBe(400);
    expect(await countGuestUsers(), "no account for a refused request").toBe(before);

    const name = uniqueName();
    const res = await rawCall(anon, "POST", routes.guestDevice, {
      intro: `um hey, I'm ${name}`,
      deviceLabel: "E2E Glasses",
      mentraUserId: `mentra-${randomUUID()}`,
    });
    expect(res.status, res.text).toBe(201);
    const created = GuestDeviceResult.parse(res.json);
    expect(created.displayName).toBe(name);
    expect(Object.keys(res.json as object).sort()).toEqual(["deviceId", "deviceToken", "displayName"]);
    expect(res.text).not.toContain("@");
    expect(res.text).not.toContain(GUEST_EMAIL_DOMAIN);
    expect(res.headers["set-cookie"] ?? "", "the device route never signs a browser in").toBe("");

    // The token is a device credential, not a session.
    const device = await deviceApi(created.deviceToken);
    world.onCleanup(() => device.dispose());
    const deviceClient = apiFor(device);
    const me = must(await deviceClient.deviceMe(), "deviceMe");
    expect(me).toMatchObject({ deviceId: created.deviceId, encounterMode: false, ready: false, latestMatchId: null });
    expect((await deviceClient.getProfile()).status).toBe(401);

    // Handoff gives the guest a session; then a Mentra touch signal matches a member.
    const handoff = await rawCall(device, "POST", routes.guestHandoff);
    expect(handoff.status, handoff.text).toBe(200);
    const link = GuestHandoff.parse(handoff.json);
    const phone = await addressedApi();
    world.onCleanup(() => phone.dispose());
    const opened = await rawCall(phone, "GET", link.path);
    expect(opened.status).toBe(307);
    const guest = await world.adoptGuest(phone, "n/a");
    expect(guest.displayName).toBe(name);

    const member = await world.person();
    const venue = await world.venue(guest);
    await world.checkIn(member, venue);
    must(await guest.api.setMode(true));
    must(await member.api.setMode(true));
    expect(must(await deviceClient.deviceMe()).ready).toBe(true);
    const swipe = must(await deviceClient.interest(interestEvent({ source: "mentra_touch" })), "device interest");
    expect(swipe.status).toBe("accepted");
    expect(must(await signal(null, member)).matched).toBe(true);
    const { forA } = await expectExactlyOneSharedMatch(guest.api, member.api);
    expect(must(await deviceClient.deviceMe()).latestMatchId).toBe(forA.id);
  });
});

test.describe("guest accounts: handoff to a phone", () => {
  test("401 without a token, 403 for a normal account's device", async ({ world }) => {
    const anon = await addressedApi();
    world.onCleanup(() => anon.dispose());
    const none = await rawCall(anon, "POST", routes.guestHandoff);
    expect(none.status).toBe(401);
    expect(parseApiError(none).code).toBe("unauthenticated");
    const wrong = await deviceApi("x".repeat(48));
    world.onCleanup(() => wrong.dispose());
    expect((await rawCall(wrong, "POST", routes.guestHandoff)).status).toBe(401);
    // A session cookie is not a device token.
    const person = await world.person();
    expect((await rawCall(person.ctx, "POST", routes.guestHandoff)).status).toBe(401);

    const member = await world.person();
    const device = await linkDevice(member);
    try {
      const res = await rawCall(device.ctx, "POST", routes.guestHandoff, undefined, { "x-forwarded-for": freshAddress() });
      expect(res.status, res.text).toBe(403);
      expect(parseApiError(res).code).toBe("forbidden");
      expect(res.text).not.toContain("/g/");
    } finally {
      await device.ctx.dispose();
    }
  });

  test("the link signs a fresh browser in as that guest and lands on /encounter; a second use goes to /sign-in", async ({ world, browser }) => {
    const g = await deviceGuest(world);
    const res = await rawCall(g.device, "POST", routes.guestHandoff, undefined, { "x-forwarded-for": g.address });
    expect(res.status, res.text).toBe(200);
    const handoff = GuestHandoff.parse(res.json);
    expect(handoff.path).toMatch(/^\/g\/[A-Za-z0-9_-]+$/);
    expect(Object.keys(res.json as object).sort()).toEqual(["expiresAt", "path"]);
    expect(res.text).not.toContain(g.created.deviceToken);
    expect(res.text).not.toContain("@");
    const ttl = Date.parse(handoff.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3_600_000);

    const fresh = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 } });
    world.onCleanup(() => fresh.close());
    const page = await fresh.newPage();
    await page.goto(handoff.path);
    await expect(page).toHaveURL(/\/encounter$/);
    const profile = await page.request.get(routes.profile);
    expect(profile.status()).toBe(200);
    const body = (await profile.json()) as { displayName: string; isGuest: boolean };
    expect(body).toMatchObject({ displayName: g.created.displayName, isGuest: true });

    // Single use: another browser opening the same link goes to sign-in and is not signed in.
    const second = await browser.newContext({ baseURL: BASE_URL });
    world.onCleanup(() => second.close());
    const page2 = await second.newPage();
    await page2.goto(handoff.path);
    await expect(page2).toHaveURL(/\/sign-in$/);
    expect((await page2.request.get(routes.profile, { maxRedirects: 0 })).status()).toBe(401);
  });

  test("a second requested link invalidates the first; a malformed link goes to sign-in with no detail", async ({ world, browser }) => {
    const g = await deviceGuest(world);
    const headers = { "x-forwarded-for": g.address };
    const first = GuestHandoff.parse((await rawCall(g.device, "POST", routes.guestHandoff, undefined, headers)).json);
    const secondRes = await rawCall(g.device, "POST", routes.guestHandoff, undefined, headers);
    expect(secondRes.status, secondRes.text).toBe(200);
    const second = GuestHandoff.parse(secondRes.json);
    expect(second.path).not.toBe(first.path);

    const ctxA = await browser.newContext({ baseURL: BASE_URL });
    world.onCleanup(() => ctxA.close());
    const pageA = await ctxA.newPage();
    await pageA.goto(first.path);
    await expect(pageA).toHaveURL(/\/sign-in$/);

    const ctxB = await browser.newContext({ baseURL: BASE_URL });
    world.onCleanup(() => ctxB.close());
    const pageB = await ctxB.newPage();
    await pageB.goto(second.path);
    await expect(pageB).toHaveURL(/\/encounter$/);

    for (const bad of ["/g/not-a-real-token-at-all", "/g/short", `/g/${"a".repeat(64)}`]) {
      const anon = await addressedApi();
      try {
        const r = await rawCall(anon, "GET", bad);
        expect(r.status, bad).toBe(307);
        expect(new URL(r.headers["location"]!, "http://x").pathname).toBe("/sign-in");
        expect(r.headers["set-cookie"] ?? "").toBe("");
      } finally {
        await anon.dispose();
      }
    }
  });

  test("a device token's guest never gets another account's session: the link opens exactly the guest of that device", async ({ world, browser }) => {
    const one = await deviceGuest(world);
    const two = await deviceGuest(world);
    const linkOne = GuestHandoff.parse((await rawCall(one.device, "POST", routes.guestHandoff, undefined, { "x-forwarded-for": one.address })).json);
    const linkTwo = GuestHandoff.parse((await rawCall(two.device, "POST", routes.guestHandoff, undefined, { "x-forwarded-for": two.address })).json);
    for (const [link, who] of [[linkTwo, two], [linkOne, one]] as const) {
      const c = await browser.newContext({ baseURL: BASE_URL });
      world.onCleanup(() => c.close());
      const p = await c.newPage();
      await p.goto(link.path);
      await expect(p).toHaveURL(/\/encounter$/);
      const body = (await (await p.request.get(routes.profile)).json()) as { displayName: string };
      expect(body.displayName).toBe(who.created.displayName);
    }
  });
});

test.describe("guest accounts: nothing sensitive in guest responses", () => {
  test("no guest route answer carries an email, a password or (apart from deviceToken itself) a device token", async ({ world }) => {
    world.watchGuests();
    const g = await deviceGuest(world);
    const web = await world.guest();
    const answers: string[] = [];
    const anon = await addressedApi();
    world.onCleanup(() => anon.dispose());
    answers.push((await rawCall(anon, "POST", routes.guest, { intro: "hello" })).text);
    answers.push((await rawCall(anon, "POST", routes.guestDevice, { intro: "Sam" })).text);
    answers.push((await rawCall(anon, "POST", routes.guestHandoff)).text);
    const created = await rawCall(anon, "POST", routes.guest, { intro: `Hi, my name is ${uniqueName()}` });
    answers.push(created.text);
    const handoff = await rawCall(g.device, "POST", routes.guestHandoff, undefined, { "x-forwarded-for": g.address });
    answers.push(handoff.text);
    answers.push((await web.api.getProfile()).text);

    for (const text of answers) {
      expect(text).not.toContain(GUEST_EMAIL_DOMAIN);
      expect(text).not.toMatch(/guest-[0-9a-f]{8}-/);
      expect(text).not.toContain(g.created.deviceToken);
      expect(text).not.toContain(web.email);
      expect(text).not.toMatch(/"password"|"email"/);
    }
    // The device route's own answer is the one place the token appears, under that key only.
    const deviceAnswer = await rawCall(anon, "POST", routes.guestDevice, { intro: `I'm ${uniqueName()}` });
    expect(deviceAnswer.status).toBe(201);
    const parsed = GuestDeviceResult.parse(deviceAnswer.json);
    expect(deviceAnswer.text.split(parsed.deviceToken)).toHaveLength(2);
    expect(deviceAnswer.text).not.toContain(GUEST_EMAIL_DOMAIN);
  });
});
