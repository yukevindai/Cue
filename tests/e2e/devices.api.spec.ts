// This exercises the server path for a device-token event only. It is not evidence that the physical glasses swipe works.
import { randomUUID } from "node:crypto";
import { anonymousApi, deviceApi } from "./helpers/auth";
import { apiFor, interestEvent, must, wasRejected } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches } from "./helpers/assertions";
import { expect, test } from "./helpers/fixtures";
import { signal, type Person } from "./helpers/scenario";

/** Pairs a device for `person` through the real pair/claim flow. */
async function linkDevice(person: Person) {
  const pairing = must(await person.api.devicePair(), "devicePair");
  expect(pairing.code).toMatch(/^[A-Z0-9]{6}$/);
  expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(Date.now());

  const anon = await anonymousApi(); // the pairing code is the credential
  try {
    const claim = must(
      await apiFor(anon).deviceClaim({ code: pairing.code, deviceLabel: "E2E Glasses", mentraUserId: null }),
      "deviceClaim",
    );
    const ctx = await deviceApi(claim.deviceToken);
    return { pairing, claim, ctx, api: apiFor(ctx) };
  } finally {
    await anon.dispose();
  }
}

test.describe("device-token path (glasses bridge, server side only)", () => {
  test("pair -> claim -> device interest -> web confirmation creates one match", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      // The device sees the user's session and encounter mode.
      const me = must(await device.api.deviceMe(), "deviceMe");
      expect(me.deviceId).toBe(device.claim.deviceId);
      expect(me.encounterMode).toBe(true);
      expect(me.encounterSessionId).toBe(pair.session.id);

      // The user's web view reports the device as linked.
      const status = must(await pair.a.api.getEncounter()).device;
      expect(status.linked).toBe(true);
      expect(status.deviceId).toBe(device.claim.deviceId);

      // A's backward swipe arrives with the device token only (no cookies, no user id).
      const swipe = interestEvent(pair.session.id, { source: "mentra_touch" });
      expect(swipe).toMatchObject({ source: "mentra_touch", gesture: "backward_swipe" });
      const ack = must(await device.api.interest(swipe), "device interest");
      expect(ack.status).toBe("accepted");
      expect(ack.matched).toBe(false);
      await expectNoMatches(pair.a.api, pair.b.api);

      // The pending signal is attributed to A (their own encounter view shows it).
      const pending = must(await pair.a.api.getEncounter()).pendingSignal;
      expect(pending?.eventId).toBe(swipe.eventId);
      expect(pending?.source).toBe("mentra_touch");

      // B confirms on the web.
      const confirm = must(await signal(pair, pair.b, { source: "web_demo" }), "B web confirm");
      expect(confirm.matched).toBe(true);
      await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

      // A repeated device event is a duplicate and adds nothing.
      expect(must(await device.api.interest(swipe)).status).toBe("duplicate");
      await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("web confirmation first, then the device swipe, also matches", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      must(await signal(pair, pair.b));
      const ack = must(await device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" })));
      expect(ack.matched).toBe(true);
      await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("a device token only speaks for glasses input, and is not a web session", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      // The device credential cannot submit the web-button source.
      const web = await device.api.interest(interestEvent(pair.session.id, { source: "web_demo" }));
      expect(web.status).toBe(403);
      expect(web.error?.code).toBe("forbidden");
      // The web session cannot submit the glasses source.
      const spoof = await pair.a.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" }));
      expect(spoof.status).toBe(403);
      expect(spoof.error?.code).toBe("forbidden");

      // Device token never reaches profile or match routes.
      for (const r of [
        await device.api.getProfile(),
        await device.api.listMatches(),
        await device.api.getEncounter(),
        await device.api.devicePair(),
      ]) {
        expect(r.status).toBe(401);
      }
      await expectNoMatches(pair.a.api, pair.b.api);
      expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
    } finally {
      await device.ctx.dispose();
    }
  });

  test("only the swipe-backward gesture is accepted; other gestures and a user id are rejected", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      const base = interestEvent(pair.session.id, { source: "mentra_touch" });
      const bad: Array<Record<string, unknown>> = [
        { ...base, gesture: "forward_swipe" },
        { ...base, gesture: "tap" },
        { ...base, gesture: "web_confirm" }, // gesture does not belong to source
        { ...base, userId: pair.b.user.id }, // never trust a client-supplied user id
        { ...base, eventId: "not-a-uuid" },
      ];
      for (const body of bad) {
        const r = await device.api.interest(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.error?.code).toBe("invalid_request");
      }
      expect(must(await pair.a.api.getEncounter()).pendingSignal, "no signal was recorded").toBeNull();
    } finally {
      await device.ctx.dispose();
    }
  });

  test("device events respect encounter mode", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      must(await pair.a.api.setMode(false));
      expect(must(await device.api.deviceMe()).encounterMode).toBe(false);
      const r = await device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" }));
      expect(wasRejected(r, "encounter_mode_off")).toBe(true);
      await expectNoMatches(pair.a.api, pair.b.api);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("pairing codes are single use and bad credentials are refused", async ({ world }) => {
    const user = await world.person();
    const pairing = must(await user.api.devicePair());
    const anon = await anonymousApi();
    try {
      const claimed = await apiFor(anon).deviceClaim({ code: pairing.code, deviceLabel: "E2E Glasses", mentraUserId: null });
      expect(claimed.ok).toBe(true);
      // Same code again.
      const second = await apiFor(anon).deviceClaim({ code: pairing.code, deviceLabel: "E2E Glasses", mentraUserId: null });
      expect(second.ok).toBe(false);
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);
      expect(second.data).toBeUndefined();
    } finally {
      await anon.dispose();
    }

    // A made-up device token is not authenticated, and does not fall back to anything.
    const fake = await deviceApi(`cue_dev_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`);
    try {
      expect((await apiFor(fake).deviceMe()).status).toBe(401);
      expect((await apiFor(fake).interest(interestEvent(randomUUID(), { source: "mentra_touch" }))).status).toBe(401);
    } finally {
      await fake.dispose();
    }
  });

  test("unlinking revokes the token and cancels a pending glasses signal", async ({ world }) => {
    const pair = await world.pair();
    const device = await linkDevice(pair.a);
    try {
      must(await device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" })));
      expect(must(await pair.a.api.getEncounter()).pendingSignal).not.toBeNull();

      expect((await pair.a.api.deviceUnlink()).status).toBe(204);

      expect((await device.api.deviceMe()).status).toBe(401);
      expect((await device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" }))).status).toBe(401);
      expect(must(await pair.a.api.getEncounter()).device.linked).toBe(false);
      expect(must(await pair.a.api.getEncounter()).pendingSignal).toBeNull();
      // B's confirmation finds nothing to match.
      expect((await signal(pair, pair.b)).data?.matched).toBe(false);
      await expectNoMatches(pair.a.api, pair.b.api);
    } finally {
      await device.ctx.dispose();
    }
  });
});
