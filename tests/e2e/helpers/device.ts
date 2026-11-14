import { anonymousApi, deviceApi } from "./auth";
import { apiFor, must } from "./api";
import type { Person } from "./scenario";

/**
 * Links a simulated glasses device for `person` through the real pair/claim
 * flow and returns an API client that carries only the device bearer token.
 * This is the server path only; it is not the physical glasses.
 */
export async function linkDevice(person: Person) {
  const pairing = must(await person.api.devicePair(), "devicePair");
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
