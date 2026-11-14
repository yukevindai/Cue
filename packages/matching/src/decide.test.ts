import { describe, expect, it } from "vitest";
import { decideInterest, type InterestInput, type OwnEvent } from "./index";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const ME = "bbbbbbbb-0000-4000-8000-000000000002";
const THEM = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION = "11111111-0000-4000-8000-000000000000";
const EVENT = "eeeeeeee-0000-4000-8000-000000000000";

const base = (over: Partial<InterestInput> = {}): InterestInput => ({
  now: NOW,
  userId: ME,
  sessionId: SESSION,
  event: { eventId: EVENT, source: "mentra_touch", gesture: "backward_swipe" },
  session: { status: "active" },
  member: { encounterMode: true },
  ownEvents: [],
  other: {
    userId: THEM,
    blockedByCaller: false,
    blocksCaller: false,
    activeMatchWithCaller: false,
    pendingSignal: null,
  },
  ...over,
});
const other = (o: Partial<NonNullable<InterestInput["other"]>>): InterestInput["other"] => ({
  ...base().other!,
  ...o,
});
const own = (o: Partial<OwnEvent>): OwnEvent => ({
  eventId: "99999999-0000-4000-8000-000000000000",
  sessionId: SESSION,
  status: "pending",
  receivedAt: at(-5000),
  expiresAt: at(10_000),
  ...o,
});
const theirs = (receivedAgoMs: number) => ({ receivedAt: at(-receivedAgoMs), expiresAt: at(15_000 - receivedAgoMs) });

describe("rejections and order", () => {
  it("invalid_event for a mismatched gesture, before anything else", () => {
    const d = decideInterest(base({ event: { eventId: EVENT, source: "web_demo", gesture: "backward_swipe" }, member: null }));
    expect(d).toEqual({ status: "rejected", reason: "invalid_event" });
  });
  it("not_in_session for a non-member or third party", () => {
    expect(decideInterest(base({ member: null }))).toEqual({ status: "rejected", reason: "not_in_session" });
  });
  it("not_in_session for a missing session", () => {
    expect(decideInterest(base({ session: null }))).toEqual({ status: "rejected", reason: "not_in_session" });
  });
  it("non-member is rejected even when the event id was seen before", () => {
    const d = decideInterest(base({ member: null, ownEvents: [own({ eventId: EVENT })] }));
    expect(d).toEqual({ status: "rejected", reason: "not_in_session" });
  });
  it("session_inactive when ended", () => {
    expect(decideInterest(base({ session: { status: "ended" } }))).toEqual({ status: "rejected", reason: "session_inactive" });
  });
  it("encounter_mode_off", () => {
    expect(decideInterest(base({ member: { encounterMode: false } }))).toEqual({ status: "rejected", reason: "encounter_mode_off" });
  });
  it("session_inactive wins over encounter_mode_off", () => {
    const d = decideInterest(base({ session: { status: "ended" }, member: { encounterMode: false } }));
    expect(d).toEqual({ status: "rejected", reason: "session_inactive" });
  });
  it("blocked when caller blocked the other, even if already matched", () => {
    const d = decideInterest(base({ other: other({ blockedByCaller: true, activeMatchWithCaller: true, pendingSignal: theirs(1000) }) }));
    expect(d).toEqual({ status: "rejected", reason: "blocked" });
  });
  it("already_matched", () => {
    const d = decideInterest(base({ other: other({ activeMatchWithCaller: true, pendingSignal: theirs(1000) }) }));
    expect(d).toEqual({ status: "rejected", reason: "already_matched" });
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
  it("repeated event id answers duplicate even after the session ended or encounter mode is off", () => {
    const e = own({ eventId: EVENT, status: "consumed" });
    expect(decideInterest(base({ ownEvents: [e], session: { status: "ended" } })).status).toBe("duplicate");
    expect(decideInterest(base({ ownEvents: [e], member: { encounterMode: false } })).status).toBe("duplicate");
  });
  it("a new event id while own signal is pending is a duplicate and never matches", () => {
    const e = own({});
    const d = decideInterest(base({ ownEvents: [e], other: other({ pendingSignal: theirs(1000) }) }));
    expect(d).toEqual({ status: "duplicate", receivedAt: e.receivedAt, expiresAt: e.expiresAt, matched: false });
  });
  it("own pending exactly at expiry does not count; a fresh signal is accepted", () => {
    const d = decideInterest(base({ ownEvents: [own({ expiresAt: NOW })] }));
    expect(d).toEqual({ status: "accepted", matched: false, receivedAt: NOW, expiresAt: at(15_000) });
  });
  it("own expired/consumed/cancelled events and pending in another session do not count", () => {
    const ownEvents = [
      own({ status: "expired" }), own({ status: "consumed" }), own({ status: "cancelled" }),
      own({ sessionId: "22222222-0000-4000-8000-000000000000" }),
    ];
    expect(decideInterest(base({ ownEvents })).status).toBe("accepted");
  });
});

describe("matching", () => {
  it("accepted pending when nobody else is in the session", () => {
    expect(decideInterest(base({ other: null }))).toEqual({
      status: "accepted", matched: false, receivedAt: NOW, expiresAt: at(15_000),
    });
  });
  it("accepted pending when other has no signal", () => {
    expect(decideInterest(base()).status).toBe("accepted");
    expect(decideInterest(base())).toMatchObject({ matched: false });
  });
  it("matches when other's signal is alive; firstSignalAt is theirs; pair ordered", () => {
    const d = decideInterest(base({ other: other({ pendingSignal: theirs(5000) }) }));
    expect(d).toEqual({
      status: "accepted", matched: true, receivedAt: NOW, firstSignalAt: at(-5000),
      pair: { userA: THEM, userB: ME },
    });
  });
  it("pair order does not depend on who goes second", () => {
    const d = decideInterest(base({ userId: THEM, other: other({ userId: ME, pendingSignal: theirs(1) }) }));
    expect(d).toMatchObject({ matched: true, pair: { userA: THEM, userB: ME } });
  });
  it("matches 1 ms before the other's expiry", () => {
    const d = decideInterest(base({ other: other({ pendingSignal: theirs(14_999) }) }));
    expect(d).toMatchObject({ matched: true });
  });
  it("does not match exactly at the other's expiry: stays pending", () => {
    const d = decideInterest(base({ other: other({ pendingSignal: theirs(15_000) }) }));
    expect(d).toEqual({ status: "accepted", matched: false, receivedAt: NOW, expiresAt: at(15_000) });
  });
  it("does not match against an older expired signal", () => {
    expect(decideInterest(base({ other: other({ pendingSignal: theirs(40_000) }) }))).toMatchObject({ matched: false });
  });
  it("other blocked caller: accepted pending, never matched, no disclosure", () => {
    const d = decideInterest(base({ other: other({ blocksCaller: true, pendingSignal: theirs(1000) }) }));
    expect(d).toEqual({ status: "accepted", matched: false, receivedAt: NOW, expiresAt: at(15_000) });
  });
  it("other blocked caller but there is an active match: already_matched still wins", () => {
    const d = decideInterest(base({ other: other({ blocksCaller: true, activeMatchWithCaller: true }) }));
    expect(d).toEqual({ status: "rejected", reason: "already_matched" });
  });
});
