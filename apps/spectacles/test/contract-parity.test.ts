// The Lens cannot bundle zod, so Core/ mirrors the wire shapes by hand. These
// tests hold the mirror to the real schemas in @cue/contracts.
import {
  DEVICE_SOURCES,
  DeviceClaimInput,
  DeviceClaimResult,
  DeviceContext,
  GESTURE_DEBOUNCE_MS as CONTRACT_DEBOUNCE,
  GESTURES_BY_SOURCE,
  InterestAck,
  InterestEvent,
  routes,
} from "@cue/contracts";
import { describe, expect, it } from "vitest";
import { DEVICE_LABEL, GESTURE, GESTURE_DEBOUNCE_MS, ROUTES, SOURCE } from "../lens/Assets/Scripts/Cue/Core/config";
import { uuidV4 } from "../lens/Assets/Scripts/Cue/Core/uuid";
import { normalizePairingCode, parseDeviceClaimResult, parseDeviceContext, parseInterestAck } from "../lens/Assets/Scripts/Cue/Core/wire";
import { ack, deviceContext } from "./fakes";

describe("contract parity", () => {
  it("source/gesture is an allowed device pair", () => {
    expect(GESTURES_BY_SOURCE[SOURCE]).toContain(GESTURE);
    expect(DEVICE_SOURCES).toContain(SOURCE);
  });

  it("routes and debounce match the contracts", () => {
    expect(ROUTES).toEqual({ deviceClaim: routes.deviceClaim, deviceMe: routes.deviceMe, interest: routes.interest });
    expect(GESTURE_DEBOUNCE_MS).toBe(CONTRACT_DEBOUNCE);
  });

  it("an event built by the Lens parses as a strict InterestEvent", () => {
    for (let i = 0; i < 200; i++) {
      const event = { eventId: uuidV4(), source: SOURCE, gesture: GESTURE, occurredAt: new Date().toISOString() };
      expect(InterestEvent.safeParse(event).success).toBe(true);
    }
  });

  it("the claim body parses as DeviceClaimInput and keeps the Spectacles label", () => {
    const parsed = DeviceClaimInput.parse({ code: normalizePairingCode("ab c-123"), deviceLabel: DEVICE_LABEL, mentraUserId: null });
    expect(parsed).toEqual({ code: "ABC123", deviceLabel: "Snap Spectacles", mentraUserId: null });
  });

  it("hand parsers accept what the zod schemas accept", () => {
    const a = ack("11111111-1111-4111-8111-111111111111");
    expect(InterestAck.parse(a)).toEqual(parseInterestAck(a));
    const matched = ack("11111111-1111-4111-8111-111111111111", { matched: true, expiresAt: null });
    expect(InterestAck.parse(matched)).toEqual(parseInterestAck(matched));
    const rejected = ack("11111111-1111-4111-8111-111111111111", { status: "rejected", reason: "no_place", expiresAt: null });
    expect(InterestAck.parse(rejected)).toEqual(parseInterestAck(rejected));
    const ctx = deviceContext({ ready: false, encounterMode: false });
    expect(DeviceContext.parse(ctx)).toEqual(parseDeviceContext(ctx));
    const withMatch = deviceContext({ activeMatchId: "44444444-4444-4444-8444-444444444444" });
    expect(DeviceContext.parse(withMatch)).toEqual(parseDeviceContext(withMatch));
    const noMatch = deviceContext({ activeMatchId: null });
    expect(DeviceContext.parse(noMatch)).toEqual(parseDeviceContext(noMatch));
    const claim = { deviceId: "33333333-3333-4333-8333-333333333333", deviceToken: "t".repeat(43) };
    expect(DeviceClaimResult.parse(claim)).toEqual(parseDeviceClaimResult(claim));
  });

  it("hand parsers reject malformed bodies", () => {
    expect(parseDeviceContext({ ...deviceContext(), ready: undefined })).toBeNull();
    expect(parseInterestAck({ ...ack("nope") })).toBeNull();
    expect(parseInterestAck({ ...ack("11111111-1111-4111-8111-111111111111"), status: "maybe" })).toBeNull();
    expect(parseInterestAck(null)).toBeNull();
    expect(parseDeviceContext({ ...deviceContext(), encounterMode: "yes" })).toBeNull();
    expect(parseDeviceClaimResult({ deviceId: "33333333-3333-4333-8333-333333333333", deviceToken: "short" })).toBeNull();
  });
});
