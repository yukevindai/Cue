import { describe, expect, it } from "vitest";
import { Debouncer, DoublePinchDetector, type Hand } from "../lens/Assets/Scripts/Cue/Core/double-pinch";

const pinch = (hand: Hand, timestampMs: number, confidence = 0.9) => ({ hand, timestampMs, confidence });

describe("DoublePinchDetector", () => {
  it("one pinch alone never fires", () => {
    const d = new DoublePinchDetector();
    expect(d.feed(pinch("right", 0))).toBe(false);
  });

  it("two same-hand pinches inside the window fire once", () => {
    const d = new DoublePinchDetector();
    expect(d.feed(pinch("right", 0))).toBe(false);
    expect(d.feed(pinch("right", 300))).toBe(true);
  });

  it("a third pinch does not chain into a second double", () => {
    const d = new DoublePinchDetector();
    d.feed(pinch("left", 0));
    expect(d.feed(pinch("left", 200))).toBe(true);
    expect(d.feed(pinch("left", 400))).toBe(false);
    expect(d.feed(pinch("left", 600))).toBe(true);
  });

  it("pinches too far apart do not pair, but the later one can start a new pair", () => {
    const d = new DoublePinchDetector({ windowMs: 450 });
    d.feed(pinch("right", 0));
    expect(d.feed(pinch("right", 451))).toBe(false);
    expect(d.feed(pinch("right", 700))).toBe(true);
  });

  it("different hands never pair", () => {
    const d = new DoublePinchDetector();
    d.feed(pinch("left", 0));
    expect(d.feed(pinch("right", 100))).toBe(false);
  });

  it("jitter closer than the minimum gap counts as one pinch", () => {
    const d = new DoublePinchDetector({ minGapMs: 60 });
    d.feed(pinch("right", 0));
    expect(d.feed(pinch("right", 20))).toBe(false);
    // The jitter did not consume the first pinch, so a real second pinch still pairs with it.
    expect(d.feed(pinch("right", 300))).toBe(true);
  });

  it("ignores low-confidence pinches", () => {
    const d = new DoublePinchDetector({ minConfidence: 0.5 });
    d.feed(pinch("right", 0));
    expect(d.feed(pinch("right", 200, 0.2))).toBe(false);
    expect(d.feed(pinch("right", 300, Number.NaN))).toBe(false);
    expect(d.feed(pinch("right", 400))).toBe(true);
  });

  it("reset forgets a half-finished double", () => {
    const d = new DoublePinchDetector();
    d.feed(pinch("right", 0));
    d.reset();
    expect(d.feed(pinch("right", 100))).toBe(false);
  });
});

describe("Debouncer", () => {
  it("drops gestures inside the window after an accepted one", () => {
    const db = new Debouncer(1000);
    expect(db.tryAccept(0)).toBe(true);
    expect(db.tryAccept(999)).toBe(false);
    expect(db.tryAccept(1000)).toBe(true);
  });
});
