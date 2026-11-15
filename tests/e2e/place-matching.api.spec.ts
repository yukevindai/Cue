// Place-based matching, API level. There is no pre-joined session: a signal
// matches the closest other person with an unexpired pending signal who shares
// the sender's venue or is within MATCH_RADIUS_M (less both accuracies).
// Each test takes its own random spot near latitude 0, longitude 0 (open sea)
// so tests sharing one database never meet each other's leftovers.
import { randomUUID } from "node:crypto";
import { InterestAck, MATCH_RADIUS_M } from "@cue/contracts";
import type { z } from "zod";
import { interestEvent, must, wasRejected } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoLeak, expectNoMatches, matchIds } from "./helpers/assertions";
import { coordinateLeak, freshSpot, locate, metresNorth, type Spot } from "./helpers/geo";
import { expect, test } from "./helpers/fixtures";
import { signal, type Person, type World } from "./helpers/scenario";

type Ack = z.infer<typeof InterestAck>;

/** An ack without ids and timestamps: what must be identical for an ordinary unanswered signal. */
const ackShape = (a: Ack) => ({
  keys: Object.keys(a).sort(),
  status: a.status,
  matched: a.matched,
  reason: a.reason,
  hasExpiry: a.expiresAt !== null,
});

/** What a person's own screens show about their pending signal, without ids and clock values. */
async function ownView(p: Person) {
  const enc = must(await p.api.getEncounter(), "getEncounter");
  const pending = enc.pendingSignal;
  return {
    encounterMode: enc.encounterMode,
    ready: enc.ready,
    pending: pending
      ? {
          keys: Object.keys(pending).sort(),
          source: pending.source,
          windowMs: new Date(pending.expiresAt).getTime() - new Date(pending.receivedAt).getTime(),
        }
      : null,
    matches: await matchIds(p.api),
  };
}

/** A lone person in their own venue who signalled and was not answered: the reference for "nothing happened". */
async function unansweredControl(world: World) {
  const d = await world.person();
  await world.venue(d);
  must(await d.api.setMode(true));
  const ack = must(await signal(null, d), "control signal");
  expect(ack).toMatchObject({ status: "accepted", matched: false });
  return { ack, view: await ownView(d) };
}

/** `person` in encounter mode with a location `metres` north of `spot` (accuracy 5 m). */
async function located(world: World, spot: Spot, metres: number, accuracyM = 5): Promise<Person> {
  const p = await world.person();
  must(await p.api.setMode(true));
  await locate(p, metresNorth(spot, metres), accuracyM);
  return p;
}

test.describe("matching by phone location", () => {
  test("two people within range match; the card says Nearby and carries no place", async ({ world }) => {
    const { a, b } = await world.nearbyPair({ metres: 25 });
    expect(must(await a.api.getEncounter())).toMatchObject({
      ready: true,
      checkIn: null,
      location: { status: "fresh", accuracyM: 5 },
    });

    const first = must(await signal(null, a));
    expect(first).toMatchObject({ status: "accepted", matched: false });
    await expectNoMatches(a.api, b.api);
    const second = must(await signal(null, b));
    expect(second).toMatchObject({ status: "accepted", matched: true, expiresAt: null });

    const { forA, forB } = await expectExactlyOneSharedMatch(a.api, b.api);
    for (const card of [forA, forB]) {
      expect(card).toMatchObject({ venueLabel: "Nearby", venueLabelSource: "phone_location" });
      expect(Math.abs(new Date(card.encounterAt).getTime() - new Date(first.receivedAt).getTime())).toBeLessThan(50);
    }
    expect(forA.other.userId).toBe(b.user.id);
    expect(forB.other.userId).toBe(a.user.id);
  });

  test("clearly out of range: both stay pending and nothing matches", async ({ world }) => {
    const { a, b } = await world.nearbyPair({ metres: 500 });
    const ackA = must(await signal(null, a));
    const ackB = must(await signal(null, b));
    expect(ackA).toMatchObject({ status: "accepted", matched: false });
    expect(ackB).toMatchObject({ status: "accepted", matched: false });
    for (const who of [a, b]) {
      expect(must(await who.api.getEncounter()).pendingSignal, "own signal is pending").not.toBeNull();
    }
    await expectNoMatches(a.api, b.api);
  });

  test("the accuracy allowance decides the boundary: 60 m apart matches at 15 m accuracy each, not at 5 m", async ({ world }) => {
    // distance - accuracyA - accuracyB must be <= MATCH_RADIUS_M: 60 - 30 = 30 matches, 60 - 10 = 50 does not.
    expect(MATCH_RADIUS_M).toBe(40);
    const rough = await world.nearbyPair({ metres: 60, accuracyM: 15 });
    must(await signal(null, rough.a));
    expect(must(await signal(null, rough.b)).matched, "60 m apart, 15 m accuracies").toBe(true);
    await expectExactlyOneSharedMatch(rough.a.api, rough.b.api);

    const sharp = await world.nearbyPair({ metres: 60, accuracyM: 5 });
    must(await signal(null, sharp.a));
    expect(must(await signal(null, sharp.b)).matched, "60 m apart, 5 m accuracies").toBe(false);
    await expectNoMatches(sharp.a.api, sharp.b.api);
  });

  test("the allowance uses both accuracies, one rough and one sharp", async ({ world }) => {
    // 70 m apart: 30 + 5 allowance leaves 35 <= 40 (match); 10 + 5 leaves 55 (no match).
    const yes = await world.nearbyPair({ metres: 70, accuracyM: [30, 5] });
    must(await signal(null, yes.a));
    expect(must(await signal(null, yes.b)).matched).toBe(true);
    const no = await world.nearbyPair({ metres: 70, accuracyM: [10, 5] });
    must(await signal(null, no.a));
    expect(must(await signal(null, no.b)).matched).toBe(false);
  });
});

test.describe("no place, encounter mode off", () => {
  test("encounter mode on but no check-in and no location: no_place, nothing pending", async ({ world }) => {
    const p = await world.person();
    must(await p.api.setMode(true));
    const enc = must(await p.api.getEncounter());
    expect(enc).toMatchObject({ encounterMode: true, ready: false, checkIn: null, location: { status: "none" } });
    const r = await signal(null, p);
    expect(wasRejected(r, "no_place")).toBe(true);
    expect(r.data).toMatchObject({ status: "rejected", reason: "no_place", matched: false, expiresAt: null });
    expect(must(await p.api.getEncounter()).pendingSignal).toBeNull();
  });

  test("an inaccurate location (150 m) is stored as inaccurate and is still no_place", async ({ world }) => {
    const p = await world.person();
    must(await p.api.setMode(true));
    const st = await locate(p, freshSpot(), 150);
    expect(st).toMatchObject({ ready: false, location: { status: "inaccurate", accuracyM: 150 } });
    expect(wasRejected(await signal(null, p), "no_place")).toBe(true);
    expect(must(await p.api.getEncounter()).pendingSignal).toBeNull();
    // A better fix makes it usable.
    expect(await locate(p, freshSpot(), 20)).toMatchObject({ ready: true, location: { status: "fresh" } });
  });

  test("an inaccurate neighbour cannot be matched even when close", async ({ world }) => {
    const spot = freshSpot();
    const a = await located(world, spot, 0, 5);
    const rough = await located(world, spot, 5, 150);
    must(await signal(null, a));
    expect(wasRejected(await signal(null, rough), "no_place")).toBe(true);
    await expectNoMatches(a.api, rough.api);
  });

  test("encounter mode off: encounter_mode_off even with a venue, and a location report is not stored", async ({ world }) => {
    const pair = await world.pair({ encounterMode: false });
    for (const who of [pair.a, pair.b]) {
      const r = await signal(pair, who);
      expect(wasRejected(r, "encounter_mode_off")).toBe(true);
      expect(r.data).toMatchObject({ status: "rejected", matched: false, expiresAt: null });
    }
    const before = must(await pair.a.api.getEncounter());
    const after = must(await pair.a.api.setLocation({ lat: freshSpot().lat, lng: 0.01, accuracyM: 5 }));
    expect(after).toMatchObject({ encounterMode: false, ready: false, location: { status: "none", accuracyM: null, locatedAt: null } });
    expect({ ...after, serverTime: null }).toEqual({ ...before, serverTime: null });
    // Turning the mode on afterwards finds no location: it was never kept.
    must(await pair.a.api.setMode(true));
    expect(must(await pair.a.api.getEncounter()).location.status).toBe("none");
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("turning encounter mode off makes the server forget the location and cancels a pending signal", async ({ world }) => {
    const { a, b } = await world.nearbyPair({ metres: 10 });
    must(await signal(null, a));
    expect(must(await a.api.getEncounter()).location.status).toBe("fresh");
    must(await a.api.setMode(false));
    const off = must(await a.api.getEncounter());
    expect(off).toMatchObject({ encounterMode: false, ready: false, pendingSignal: null, location: { status: "none", accuracyM: null, locatedAt: null } });
    // B signals in the original window: A's cancelled signal does not match.
    expect(must(await signal(null, b)).matched).toBe(false);
    // Back on with no location: not ready until the phone reports again.
    must(await a.api.setMode(true));
    expect(must(await a.api.getEncounter())).toMatchObject({ ready: false, location: { status: "none" } });
    await expectNoMatches(a.api, b.api);
  });

  test("DELETE /api/encounter/location forgets the location and a signal then has no place", async ({ world }) => {
    const p = await located(world, freshSpot(), 0);
    expect(must(await p.api.getEncounter()).ready).toBe(true);
    const st = must(await p.api.clearLocation());
    expect(st).toMatchObject({ encounterMode: true, ready: false, location: { status: "none" } });
    expect(wasRejected(await signal(null, p), "no_place")).toBe(true);
  });

  test("bad bodies are 400: out-of-range coordinates, a missing accuracy, extra keys, and any place or user in a signal", async ({ world }) => {
    const pair = await world.pair();
    const spot = freshSpot();
    for (const body of [
      { lat: 91, lng: 0, accuracyM: 5 },
      { lat: 0, lng: 181, accuracyM: 5 },
      { lat: 0, lng: 0, accuracyM: -1 },
      { lat: spot.lat, lng: spot.lng },
      { lat: spot.lat, lng: spot.lng, accuracyM: 5, userId: pair.b.user.id },
    ]) {
      const r = await pair.a.api.setLocation(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe("invalid_request");
    }
    expect((await pair.a.api.createVenue("")).status).toBe(400);
    expect((await pair.a.api.checkIn("ABC")).status).toBe(400);
    for (const extra of [
      { encounterSessionId: randomUUID() },
      { venueId: pair.venue.id },
      { lat: spot.lat, lng: spot.lng },
      { userId: pair.b.user.id },
    ]) {
      const r = await pair.a.api.interest({ ...interestEvent(), ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.error?.code).toBe("invalid_request");
    }
    expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
  });
});

test.describe("matching by venue", () => {
  test("the same venue matches without any location, and the card names the venue", async ({ world }) => {
    const pair = await world.pair({ venue: "Place Matching Hall" });
    for (const who of [pair.a, pair.b]) {
      expect(must(await who.api.getEncounter())).toMatchObject({
        ready: true,
        checkIn: { name: "Place Matching Hall", code: pair.venue.code },
        location: { status: "none" },
      });
    }
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const { forA, forB } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    for (const card of [forA, forB]) {
      expect(card).toMatchObject({ venueLabel: "Place Matching Hall", venueLabelSource: "venue_checkin" });
    }
  });

  test("a venue code is case-insensitive", async ({ world }) => {
    const a = await world.person();
    const b = await world.person();
    const venue = await world.venue(a);
    const st = must(await b.api.checkIn(venue.code.toLowerCase()));
    expect(st.checkIn?.venueId).toBe(venue.id);
  });

  test("different venues do not match, even with identical signals at the same time", async ({ world }) => {
    const a = await world.person();
    const b = await world.person();
    await world.venue(a, "Hall One");
    await world.venue(b, "Hall Two");
    must(await a.api.setMode(true));
    must(await b.api.setMode(true));
    expect(must(await signal(null, a)).matched).toBe(false);
    expect(must(await signal(null, b)).matched).toBe(false);
    await expectNoMatches(a.api, b.api);
  });

  test("a venue does not match someone who is merely nearby: a venue never matches a located person outside it", async ({ world }) => {
    // B is in the venue; C has a location and no venue: they share nothing, whatever the distance.
    const pair = await world.pair();
    const spot = freshSpot();
    await locate(pair.b, spot, 5);
    const c = await located(world, spot, 3);
    must(await signal(null, pair.b));
    expect(must(await signal(null, c)).matched, "B's venue is not C's place, and B has a location only as a second signal source").toBe(true);
    // ...which is the location path: both have fresh locations a few metres apart.
    const { forA: cardForB } = await expectExactlyOneSharedMatch(pair.b.api, c.api);
    expect(cardForB.venueLabelSource).toBe("phone_location");
  });

  test("checking out cancels the pending signal and the person can no longer match", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    const out = must(await pair.a.api.checkOut());
    expect(out).toMatchObject({ checkIn: null, ready: false, pendingSignal: null, encounterMode: true });
    // B's signal finds nothing.
    expect(must(await signal(pair, pair.b)).matched).toBe(false);
    // A, checked out, has no place.
    expect(wasRejected(await signal(pair, pair.a), "no_place")).toBe(true);
    // Back in, a fresh signal completes against B's pending one.
    must(await pair.a.api.checkIn(pair.venue.code));
    expect(must(await signal(pair, pair.a)).matched).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  });

  test("an unknown venue code is 404 not_found and checks nobody in", async ({ world }) => {
    const p = await world.person();
    const r = await p.api.checkIn("ZZZZZZ");
    expect(r.status).toBe(404);
    expect(r.error?.code).toBe("not_found");
    expect(must(await p.api.getEncounter()).checkIn).toBeNull();
  });

  test("checking into another venue leaves the first: the pair no longer matches", async ({ world }) => {
    const pair = await world.pair();
    const other = await world.person();
    const venue2 = await world.venue(other, "Second Hall");
    must(await signal(pair, pair.a));
    await world.checkIn(pair.b, venue2);
    expect(must(await pair.b.api.getEncounter()).checkIn?.name).toBe("Second Hall");
    expect(must(await signal(pair, pair.b)).matched).toBe(false);
    await expectNoMatches(pair.a.api, pair.b.api);
  });
});

test.describe("a crowd: the closest signaller wins and the others learn nothing", () => {
  test("three people in range: C matches the nearer of two pending people, not the more recent one", async ({ world }) => {
    const spot = freshSpot();
    // All within 40 m + allowances of each other: A is 12 m from C, B is 36 m from C.
    const a = await located(world, spot, 0);
    const b = await located(world, spot, 48);
    const c = await located(world, spot, 12);
    const control = await unansweredControl(world);

    // A and B are 48 m apart (48 - 10 = 38 <= 40), so make them unable to match each other first:
    // block, so both can stay pending side by side.
    expect((await a.api.block(b.user.id)).status).toBe(204);
    const ackA = must(await signal(null, a));
    const ackB = must(await signal(null, b)); // more recent than A
    expect(ackA.matched).toBe(false);
    expect(ackB.matched).toBe(false);

    const ackC = must(await signal(null, c));
    expect(ackC).toMatchObject({ status: "accepted", matched: true });
    // C is matched with A (12 m), not B (36 m) although B signalled last.
    const listC = must(await c.api.listMatches()).matches;
    expect(listC).toHaveLength(1);
    expect(listC[0].other.userId).toBe(a.user.id);
    expect(await matchIds(a.api)).toEqual([listC[0].id]);

    // B was passed over. Everything B can see or receive is what an unanswered signal looks like.
    expect(ackShape(ackB)).toEqual(ackShape(control.ack));
    const viewB = await ownView(b);
    expect(viewB).toEqual(control.view);
    expect(viewB.matches).toEqual([]);
    const rawB = [(await b.api.getEncounter()).text, (await b.api.listMatches()).text];
    expectNoLeak(rawB, {
      "A's id": a.user.id,
      "C's id": c.user.id,
      "A's name": a.displayName,
      "C's name": c.displayName,
      "the match id": listC[0].id,
    });
    // B's own signal is still waiting for its window; a second gesture is a duplicate, not a match.
    expect(must(await signal(null, b))).toMatchObject({ status: "duplicate", matched: false });
  });

  test("the nearer person wins even when the farther one signalled last", async ({ world }) => {
    const spot = freshSpot();
    const near = await located(world, spot, 0);
    const far = await located(world, spot, 45);
    const c = await located(world, spot, 10);
    expect((await near.api.block(far.user.id)).status).toBe(204);
    must(await signal(null, near)); // near signals first
    must(await signal(null, far)); // far is the most recent
    expect(must(await signal(null, c)).matched).toBe(true);
    expect(must(await c.api.listMatches()).matches[0].other.userId).toBe(near.user.id);
    await expectNoMatches(far.api);
  });

  test("a venue-only crowd: with no locations the most recent signal wins", async ({ world }) => {
    const pair = await world.pair(); // A and B in one venue
    const c = await world.person();
    await world.checkIn(c, pair.venue);
    must(await c.api.setMode(true));
    const control = await unansweredControl(world);

    // A and B are blocked, so both can wait in the same room.
    expect((await pair.a.api.block(pair.b.user.id)).status).toBe(204);
    const ackA = must(await signal(null, pair.a));
    const ackB = must(await signal(null, pair.b));
    expect(ackA.matched).toBe(false);
    expect(ackB.matched).toBe(false);

    expect(must(await signal(null, c)).matched).toBe(true);
    const cards = must(await c.api.listMatches()).matches;
    expect(cards).toHaveLength(1);
    expect(cards[0].other.userId, "the most recent signaller").toBe(pair.b.user.id);
    expect(cards[0].venueLabelSource).toBe("venue_checkin");

    // A was passed over and sees only what an unanswered signal looks like.
    expect(ackShape(ackA)).toEqual(ackShape(control.ack));
    expect(await ownView(pair.a)).toEqual(control.view);
  });

  test("an unmatched bystander in the same place never finds out anyone signalled", async ({ world }) => {
    const pair = await world.pair();
    const watcher = await world.person();
    await world.checkIn(watcher, pair.venue);
    must(await watcher.api.setMode(true));
    const before = await ownView(watcher);
    must(await signal(null, pair.a));
    expect(must(await signal(null, pair.b)).matched).toBe(true);
    const after = await ownView(watcher);
    expect(after).toEqual(before);
    const raw = [(await watcher.api.getEncounter()).text, (await watcher.api.listMatches()).text];
    expectNoLeak(raw, { "A's id": pair.a.user.id, "B's id": pair.b.user.id, "A's name": pair.a.displayName, "B's name": pair.b.displayName });
  });
});

test.describe("blocked and already-matched people are silently not candidates", () => {
  test("a blocked pair in the same place never matches, and the blocked person's responses look unanswered (venue)", async ({ world }) => {
    const pair = await world.pair();
    const control = await unansweredControl(world);
    expect((await pair.a.api.block(pair.b.user.id)).status).toBe(204);
    const fromBlocker = must(await signal(null, pair.a));
    const fromBlocked = must(await signal(null, pair.b));
    for (const ack of [fromBlocker, fromBlocked]) expect(ackShape(ack)).toEqual(ackShape(control.ack));
    expect(await ownView(pair.a)).toEqual(control.view);
    expect(await ownView(pair.b)).toEqual(control.view);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("a blocked pair in range never matches, and neither is told (location)", async ({ world }) => {
    const { a, b } = await world.nearbyPair({ metres: 5 });
    const control = await unansweredControl(world);
    expect((await b.api.block(a.user.id)).status).toBe(204);
    const fromBlocked = must(await signal(null, a));
    const fromBlocker = must(await signal(null, b));
    for (const ack of [fromBlocker, fromBlocked]) expect(ackShape(ack)).toEqual(ackShape(control.ack));
    await expectNoMatches(a.api, b.api);
  });

  test("a block does not stop either person matching a third person", async ({ world }) => {
    const pair = await world.pair();
    const c = await world.person();
    await world.checkIn(c, pair.venue);
    must(await c.api.setMode(true));
    expect((await pair.a.api.block(pair.b.user.id)).status).toBe(204);
    must(await signal(null, pair.a));
    expect(must(await signal(null, c)).matched).toBe(true);
    expect(must(await c.api.listMatches()).matches[0].other.userId).toBe(pair.a.user.id);
  });

  test("an already-matched pair does not match again, but each can still match a third person", async ({ world }) => {
    const pair = await world.pair();
    const c = await world.person();
    const d = await world.person();
    for (const x of [c, d]) {
      await world.checkIn(x, pair.venue);
      must(await x.api.setMode(true));
    }
    const control = await unansweredControl(world);

    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    // Both signal again: nobody to pair with but each other, and that match already exists.
    const againA = must(await signal(null, pair.a));
    const againB = must(await signal(null, pair.b));
    expect(ackShape(againA)).toEqual(ackShape(control.ack));
    expect(ackShape(againB)).toEqual(ackShape(control.ack));
    expect(await matchIds(pair.a.api)).toHaveLength(1);

    // C takes the most recent (B); D takes the one still waiting (A).
    expect(must(await signal(null, c)).matched).toBe(true);
    expect(must(await signal(null, d)).matched).toBe(true);
    const partnersOfA = must(await pair.a.api.listMatches()).matches.map((m) => m.other.userId).sort();
    const partnersOfB = must(await pair.b.api.listMatches()).matches.map((m) => m.other.userId).sort();
    expect(partnersOfA).toEqual([pair.b.user.id, d.user.id].sort());
    expect(partnersOfB).toEqual([pair.a.user.id, c.user.id].sort());
  });

  test("after an unmatch the pair is candidates again", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    expect((await pair.b.api.unmatch(forA.id)).status).toBe(204);
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
  });
});

test.describe("coordinates never leave the server", () => {
  test("no response contains lat, lng or the test coordinates", async ({ world }) => {
    const spot = freshSpot();
    const spotB = metresNorth(spot, 18);
    const a = await world.person();
    const b = await world.person();
    const texts: string[] = [];
    const keep = <T extends { text: string }>(r: T): T => {
      texts.push(r.text);
      return r;
    };
    for (const who of [a, b]) keep(await who.api.setMode(true));
    keep(await a.api.setLocation({ ...spot, accuracyM: 6 }));
    keep(await b.api.setLocation({ ...spotB, accuracyM: 6 }));
    keep(await a.api.getEncounter());
    const venue = await world.venue(a, "Leak Check Hall"); // venue creation while located
    keep(await b.api.checkIn(venue.code));
    keep(await a.api.setLocation({ ...spot, accuracyM: 6 }));
    keep(await a.api.getEncounter());
    keep(await b.api.getEncounter());

    const ackA = keep(await signal(null, a));
    const ackB = keep(await signal(null, b));
    expect(ackA.data?.matched).toBe(false); // a is a candidate for b only through the venue... and b signalled next:
    // (they share the venue and are in range, so B's signal completes the match)
    expect([ackA.data?.matched, ackB.data?.matched]).toEqual([false, true]);
    const cardsA = keep(await a.api.listMatches());
    const cardsB = keep(await b.api.listMatches());
    const id = cardsA.data!.matches[0].id;
    keep(await a.api.getMatch(id));
    keep(await b.api.getMatch(id));
    keep(await a.api.clearLocation());
    keep(await a.api.checkOut());
    keep(await a.api.reset(false));
    keep(await b.api.reset(true));
    expect(cardsB.data?.matches).toHaveLength(1);

    for (const t of texts) expect(coordinateLeak(t, [spot, spotB]), t.slice(0, 120)).toBeNull();
    expect(texts.length).toBeGreaterThan(15);
  });

  test("device and interest responses contain no coordinates either", async ({ world }) => {
    const { a, b, spot } = await world.nearbyPair({ metres: 12 });
    const { linkDevice } = await import("./helpers/device");
    const device = await linkDevice(a);
    try {
      const texts = [
        (await device.api.deviceMe()).text,
        (await device.api.interest(interestEvent({ source: "mentra_touch" }))).text,
        (await b.api.interest(interestEvent())).text,
        (await device.api.deviceMe()).text,
      ];
      for (const t of texts) expect(coordinateLeak(t, [spot, metresNorth(spot, 12)])).toBeNull();
    } finally {
      await device.ctx.dispose();
    }
  });
});

test.describe("demo reset", () => {
  test("reset ends the caller's matches for both people and clears the pending signal, keeping the place", async ({ world }) => {
    const pair = await world.pair();
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    must(await signal(pair, pair.a)); // pending again
    const st = must(await pair.a.api.reset(false));
    expect(st).toMatchObject({ encounterMode: true, ready: true, pendingSignal: null });
    expect(st.checkIn?.venueId).toBe(pair.venue.id);
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("reset with leave checks out, turns Encounter mode off and forgets the location", async ({ world }) => {
    const pair = await world.pair();
    await locate(pair.a, freshSpot(), 5);
    must(await signal(pair, pair.a));
    const st = must(await pair.a.api.reset(true));
    expect(st).toMatchObject({
      encounterMode: false,
      ready: false,
      checkIn: null,
      pendingSignal: null,
      location: { status: "none", accuracyM: null, locatedAt: null },
    });
    expect(wasRejected(await signal(pair, pair.a), "encounter_mode_off")).toBe(true);
  });
});

test.describe("rate limits", () => {
  test("check-in attempts are limited to 10 a minute per user", async ({ world }) => {
    const p = await world.person();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await p.api.checkIn(`ZZZZ${"23456789AB"[i]}Z`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(must(await p.api.getEncounter()).checkIn).toBeNull();
  });

  test("location reports are limited to 30 a minute per user", async ({ world }) => {
    const p = await world.person();
    must(await p.api.setMode(true));
    const spot = freshSpot();
    const statuses = await Promise.all(
      Array.from({ length: 32 }, () => p.api.setLocation({ ...spot, accuracyM: 5 })),
    ).then((rs) => rs.map((r) => r.status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  test("venue creation is limited to 10 a minute per user", async ({ world }) => {
    const p = await world.person();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await p.api.createVenue(`Rate Hall ${i}`);
      statuses.push(r.status);
      if (r.data?.checkIn) world.trackVenue(r.data.checkIn.venueId);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
