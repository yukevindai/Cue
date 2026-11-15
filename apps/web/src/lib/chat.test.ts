import type { ChatMessage } from "@cue/contracts";
import { describe, expect, it } from "vitest";
import { buildTimeline, canSend, dayLabel, mergeMessages, type OutgoingMessage } from "./chat";

const MATCH = "22222222-2222-4222-8222-222222222222";
let n = 0;
function msg(at: string, mine: boolean, body = "hi"): ChatMessage {
  n += 1;
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, matchId: MATCH, mine, body, createdAt: at };
}

describe("mergeMessages", () => {
  it("dedupes by id and sorts oldest first", () => {
    const a = msg("2026-11-15T10:00:00.000Z", true);
    const b = msg("2026-11-15T10:01:00.000Z", false);
    const merged = mergeMessages([b], [a, b]);
    expect(merged.map((m) => m.id)).toEqual([a.id, b.id]);
  });
});

describe("buildTimeline", () => {
  const now = new Date(2026, 10, 15, 12, 0);
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();

  it("adds a day label when the day changes and groups runs by sender and gap", () => {
    const list = [
      msg(at(14, 20, 0), false),
      msg(at(15, 9, 0), false),
      msg(at(15, 9, 2), false),
      msg(at(15, 9, 3), true),
      msg(at(15, 9, 30), true),
    ];
    const t = buildTimeline(list, [], now);
    expect(t.filter((e) => e.kind === "day").map((e) => e.kind === "day" && e.label)).toEqual(["Yesterday", "Today"]);
    const msgs = t.flatMap((e) => (e.kind === "message" ? [e] : []));
    expect(msgs.map((m) => [m.runStart, m.runEnd])).toEqual([
      [true, true],
      [true, false],
      [false, true],
      [true, true], // own message starts a new run
      [true, true], // 27 minutes later: a new run
    ]);
  });

  it("puts the outbox after confirmed messages and isolates failed sends", () => {
    const sent = msg(at(15, 11, 0), true);
    const outbox: OutgoingMessage[] = [
      { clientId: "c1", body: "a", createdAt: at(15, 11, 1), status: "sending" },
      { clientId: "c2", body: "b", createdAt: at(15, 11, 1), status: "failed", error: "x" },
    ];
    const msgs = buildTimeline([sent], outbox, now).flatMap((e) => (e.kind === "message" ? [e] : []));
    expect(msgs.map((m) => m.key)).toEqual([sent.id, "out-c1", "out-c2"]);
    expect(msgs[1].runEnd).toBe(true);
    expect(msgs[2].runStart).toBe(true);
  });

  it("keeps bodies exactly as written", () => {
    const body = "line one\n<b>not bold</b> https://example.com";
    const [, m] = buildTimeline([msg(at(15, 8, 0), false, body)], [], now);
    expect(m.kind === "message" && m.body).toBe(body);
  });
});

describe("dayLabel", () => {
  it("names recent days and dates older ones", () => {
    const now = new Date(2026, 10, 15, 12, 0);
    expect(dayLabel(new Date(2026, 10, 15, 1).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 14, 23).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1).toISOString(), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 9, 1).toISOString(), now)).toMatch(/2025/);
  });
});

describe("canSend", () => {
  it("needs non-blank text within the limit", () => {
    expect(canSend("   ", 10)).toBe(false);
    expect(canSend(" hi ", 10)).toBe(true);
    expect(canSend("x".repeat(11), 10)).toBe(false);
  });
});
