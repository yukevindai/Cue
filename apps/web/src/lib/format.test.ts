import { describe, expect, it } from "vitest";
import { matchPlace } from "./format";

describe("matchPlace", () => {
  it("names the venue for a check-in match", () => {
    expect(matchPlace({ venueLabel: "Main hall", venueLabelSource: "venue_checkin" })).toMatchObject({
      line: "Met at Main hall",
      phrase: "at Main hall",
    });
  });

  it("names no place for a phone-location match", () => {
    const p = matchPlace({ venueLabel: "Nearby", venueLabelSource: "phone_location" });
    expect(p.line).toBe("You were near each other");
    expect(`${p.line} ${p.phrase} ${p.note}`).not.toMatch(/Nearby/);
  });

  it("keeps the hand-entered note for older matches", () => {
    expect(matchPlace({ venueLabel: "Hall B", venueLabelSource: "manual" })).toEqual({
      line: "Met at Hall B",
      phrase: "at Hall B",
      note: "Venue entered by hand, not GPS.",
    });
  });
});
