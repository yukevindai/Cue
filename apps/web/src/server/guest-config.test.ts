import { describe, expect, it } from "vitest";
import { guestsEnabled } from "./guest-config";

describe("guestsEnabled", () => {
  it("is on by default and for any value other than off/false/0", () => {
    expect(guestsEnabled({})).toBe(true);
    for (const v of ["on", "true", "1", "yes", "", "  ", "of"]) expect(guestsEnabled({ CUE_GUESTS_ENABLED: v })).toBe(true);
  });
  it("is off for off, false and 0 in any case", () => {
    for (const v of ["off", "OFF", " false ", "False", "0"]) expect(guestsEnabled({ CUE_GUESTS_ENABLED: v })).toBe(false);
  });
});
