import { describe, expect, it } from "vitest";
import {
  decideInterest,
  EARTH_RADIUS_M,
  type Candidate,
  type InterestInput,
  type OwnEvent,
  type PhoneLocation,
  type Presence,
} from "./index";

// Synthetic coordinates only: small offsets around latitude 0, longitude 0.
const NOW = new Date("2026-11-14T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ME = "bbbbbbbb-0000-4000-8000-000000000002";
const THEM = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "cccccccc-0000-4000-8000-000000000003";
const VENUE = "11111111-0000-4000-8000-000000000000";
const VENUE2 = "22222222-0000-4000-8000-000000000000";
const EVENT = "eeeeeeee-0000-4000-8000-000000000000";
const M_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

const loc = (northM: number, over: Partial<PhoneLocation> = {}): PhoneLocation => ({
  lat: northM / M_PER_DEG,
  lng: 0,
  accuracyM: 5,
  locatedAt: at(-2000),
  ...over,
});
const checkIn = (venueId = VENUE, agoMs = 60_000) => ({ venueId, active: true, checkedInAt: at(-agoMs) });
const presence = (over: Partial<Presence> = {}): Presence => ({
  encounterMode: true,
  checkIn: null,
  location: loc(0),
  ...over,
});
const candidate = (over: Partial<Candidate> & { receivedAgoMs?: number } = {}): Candidate => {
  const { receivedAgoMs = 1000, ...rest } = over;
  return {
    userId: THEM,
    presence: presence({ location: loc(10) }),
    pendingSignal: { receivedAt: at(-receivedAgoMs), expiresAt: at(15_000 - receivedAgoMs) },
    blocked: false,
    activeMatchWithCaller: false,
    ...rest,
  };
};
const base = (over: Partial<InterestInput> = {}): InterestInput => ({
  now: NOW,
  userId: ME,
  event: { eventId: EVENT, source: "mentra_touch", gesture: "backward_swipe" },
  presence: presence(),
  ownEvents: [],
  candidates: [],
  ...over,
});
const own = (o: Partial<OwnEvent>): OwnEvent => ({
  eventId: "99999999-0000-4000-8000-000000000000",
  status: "pending",
  receivedAt: at(-5000),
  expiresAt: at(10_000),
  ...o,
});
const PENDING = { status: "accepted", matched: false, receivedAt: NOW, expiresAt: at(15_000) } as const;

describe("rejections and order", () => {
  it("invalid_event for a mismatched gesture, before anything else", () => {
    const d = decideInterest(base({ event: { eventId: EVENT, source: "web_demo", gesture: "backward_swipe" }, presence: null }));
    expect(d).toEqual({ status: "rejected", reason: "invalid_event" });
  });
  it("encounter_mode_off with no presence row or mode off", () => {
    expect(decideInterest(base({ presence: null }))).toEqual({ status: "rejected", reason: "encounter_mode_off" });
    expect(decideInterest(base({ presence: presence({ encounterMode: false }) }))).toEqual({
      status: "rejected",
      reason: "encounter_mode_off",
    });
  });
  it("no_place without a check-in or a usable location", () => {
    const cases: Partial<Presence>[] = [
      { location: null },
      { location: loc(0, { locatedAt: at(-60_000) }) },
      { location: loc(0, { accuracyM: 101 }) },
      { location: null, checkIn: checkIn(VENUE, 8 * 3600_000) },
      { location: null, checkIn: { ...checkIn(), active: false } },
    ];
    for (const c of cases) {
      expect(decideInterest(base({ presence: presence(c) }))).toEqual({ status: "rejected", reason: "no_place" });
    }
  });
  it("encounter_mode_off wins over no_place", () => {
    const d = decideInterest(base({ presence: presence({ encounterMode: false, location: null }) }));
    expect(d).toEqual({ status: "rejected", reason: "encounter_mode_off" });
  });
  it("a check-in alone is a place", () => {
    expect(decideInterest(base({ presence: presence({ location: null, checkIn: checkIn() }) }))).toEqual(PENDING);
  });
});

describe("duplicates", () => {
  it("repeated pending event id returns original times", () => {
    const e = own({ eventId: EVENT });
    expect(decideInterest(base({ ownEvents: [e] }))).toEqual({
      status: "duplicate", receivedAt: e.receivedAt, expiresAt: e.expiresAt, matched: false,
    });
  });
  it("repeated pending event id exactly at expiry has no expiresAt", () => {
    const e = own({ eventId: EVENT, expiresAt: NOW });
    expect(decideInterest(base({ ownEvents: [e] }))).toMatchObject({ status: "duplicate", expiresAt: null, matched: false });
  });
  it("repeated consumed event id reports matched true", () => {
    const e = own({ eventId: EVENT, status: "consumed" });
    expect(decideInterest(base({ ownEvents: [e] }))).toMatchObject({ status: "duplicate", expiresAt: null, matched: true });
  });
  it.each(["expired", "cancelled"] as const)("repeated %s event id is a duplicate, not matched", (status) => {
    expect(decideInterest(base({ ownEvents: [own({ eventId: EVENT, status })] }))).toMatchObject({
      status: "duplicate", expiresAt: null, matched: false,
    });
  });
  it("repeated event id answers duplicate even with mode off or no place", () => {
    const e = own({ eventId: EVENT, status: "consumed" });
    expect(decideInterest(base({ ownEvents: [e], presence: null })).status).toBe("duplicate");
    expect(decideInterest(base({ ownEvents: [e], presence: presence({ location: null }) })).status).toBe("duplicate");
  });
  it("a new event id while own signal is pending is a duplicate and never matches", () => {
    const e = own({});
    const d = decideInterest(base({ ownEvents: [e], candidates: [candidate()] }));
    expect(d).toEqual({ status: "duplicate", receivedAt: e.receivedAt, expiresAt: e.expiresAt, matched: false });
  });
  it("own pending exactly at expiry does not count; a fresh signal is accepted", () => {
    expect(decideInterest(base({ ownEvents: [own({ expiresAt: NOW })] }))).toEqual(PENDING);
  });
  it("own expired/consumed/cancelled events do not count", () => {
    const ownEvents = [own({ status: "expired" }), own({ status: "consumed" }), own({ status: "cancelled" })];
    expect(decideInterest(base({ ownEvents })).status).toBe("accepted");
  });
});

describe("matching by phone location", () => {
  it("accepted pending when nobody else has signalled", () => {
    expect(decideInterest(base())).toEqual(PENDING);
  });
  it("matches a nearby pending signal: Nearby, firstSignalAt theirs, pair ordered", () => {
    const d = decideInterest(base({ candidates: [candidate({ receivedAgoMs: 5000 })] }));
    expect(d).toEqual({
      status: "accepted", matched: true, receivedAt: NOW, firstSignalAt: at(-5000),
      pair: { userA: THEM, userB: ME }, otherUserId: THEM, place: { kind: "nearby" },
    });
  });
  it("radius allows for both accuracies: in range at 40 m net, out of range just beyond", () => {
    const inRange = candidate({ presence: presence({ location: loc(49.9) }) }); // 49.9 - 5 - 5 = 39.9
    const outOfRange = candidate({ presence: presence({ location: loc(50.1) }) });
    expect(decideInterest(base({ candidates: [inRange] }))).toMatchObject({ matched: true });
    expect(decideInterest(base({ candidates: [outOfRange] }))).toEqual(PENDING);
  });
  it("a candidate whose location is stale or inaccurate cannot match by location", () => {
    for (const l of [loc(1, { locatedAt: at(-60_000) }), loc(1, { accuracyM: 150 })]) {
      expect(decideInterest(base({ candidates: [candidate({ presence: presence({ location: l }) })] }))).toEqual(PENDING);
    }
  });
  it("matches 1 ms before the other's expiry, not at it", () => {
    expect(decideInterest(base({ candidates: [candidate({ receivedAgoMs: 14_999 })] }))).toMatchObject({ matched: true });
    expect(decideInterest(base({ candidates: [candidate({ receivedAgoMs: 15_000 })] }))).toEqual(PENDING);
  });
  it("the nearest candidate wins, whatever the signal order", () => {
    const near = candidate({ userId: OTHER, presence: presence({ location: loc(20) }), receivedAgoMs: 9000 });
    const far = candidate({ presence: presence({ location: loc(30) }), receivedAgoMs: 1000 });
    expect(decideInterest(base({ candidates: [far, near] }))).toMatchObject({ matched: true, otherUserId: OTHER });
  });
  it("equal distances: the most recent signal wins", () => {
    const older = candidate({ userId: OTHER, receivedAgoMs: 9000 });
    const newer = candidate({ receivedAgoMs: 1000 });
    expect(decideInterest(base({ candidates: [older, newer] }))).toMatchObject({ otherUserId: THEM });
  });
  it("candidates with mode off, the caller themself, blocked or already matched are skipped", () => {
    const skip = [
      candidate({ presence: presence({ encounterMode: false, location: loc(1) }) }),
      candidate({ userId: ME }),
      candidate({ blocked: true }),
      candidate({ activeMatchWithCaller: true }),
    ];
    for (const c of skip) expect(decideInterest(base({ candidates: [c] }))).toEqual(PENDING);
    const fallback = candidate({ userId: OTHER, presence: presence({ location: loc(35) }) });
    expect(decideInterest(base({ candidates: [...skip, fallback] }))).toMatchObject({ otherUserId: OTHER });
  });
});

describe("matching by venue", () => {
  const atVenue = (venueId = VENUE): Presence => presence({ location: null, checkIn: checkIn(venueId) });
  it("same venue with no locations matches, labelled by the venue", () => {
    const d = decideInterest(base({ presence: atVenue(), candidates: [candidate({ presence: atVenue() })] }));
    expect(d).toMatchObject({ matched: true, place: { kind: "venue", venueId: VENUE } });
  });
  it("different venues and no locations never match", () => {
    expect(decideInterest(base({ presence: atVenue(), candidates: [candidate({ presence: atVenue(VENUE2) })] }))).toEqual(PENDING);
  });
  it("a candidate whose check-in is over 8 hours old does not share the venue", () => {
    const stale = presence({ location: null, checkIn: checkIn(VENUE, 8 * 3600_000) });
    expect(decideInterest(base({ presence: atVenue(), candidates: [candidate({ presence: stale })] }))).toEqual(PENDING);
  });
  it("venue-only candidates: the most recent signal wins", () => {
    const older = candidate({ userId: OTHER, presence: atVenue(), receivedAgoMs: 8000 });
    const newer = candidate({ presence: atVenue(), receivedAgoMs: 2000 });
    expect(decideInterest(base({ presence: atVenue(), candidates: [older, newer] }))).toMatchObject({ otherUserId: THEM });
  });
  it("same venue far apart by location still matches by venue; label is the venue", () => {
    const me = presence({ checkIn: checkIn(), location: loc(0) });
    const them = presence({ checkIn: checkIn(), location: loc(500) });
    expect(decideInterest(base({ presence: me, candidates: [candidate({ presence: them })] }))).toMatchObject({
      matched: true, place: { kind: "venue", venueId: VENUE },
    });
  });
  it("a located candidate ranks before a venue-only one", () => {
    const me = presence({ checkIn: checkIn(), location: loc(0) });
    const venueOnly = candidate({ userId: OTHER, presence: atVenue(), receivedAgoMs: 100 });
    const located = candidate({ presence: presence({ location: loc(30) }), receivedAgoMs: 9000 });
    expect(decideInterest(base({ presence: me, candidates: [venueOnly, located] }))).toMatchObject({
      otherUserId: THEM, place: { kind: "nearby" },
    });
  });
});
