import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import { decideIntro, guestRequestProblem, phaseAfterListen, statusLines, welcomeLine } from "./guest-entry";

describe("decideIntro", () => {
  it("creates when a name can be read", () => {
    expect(decideIntro("  hi my name is sam ")).toEqual({ action: "create", intro: "hi my name is sam", name: "Sam" });
    expect(decideIntro("Riley")).toMatchObject({ action: "create", name: "Riley" });
  });
  it("says no name for a bare greeting, empty for nothing", () => {
    expect(decideIntro("hello there")).toEqual({ action: "no_name", heard: "hello there" });
    expect(decideIntro("   ")).toEqual({ action: "empty" });
  });
});

describe("phaseAfterListen", () => {
  it("goes straight to creating on a name", () => {
    expect(phaseAfterListen({ kind: "heard", transcript: "hi my name is Sam" })).toEqual({
      kind: "creating",
      heard: "hi my name is Sam",
      name: "Sam",
    });
  });
  it("keeps what was heard when no name is understood", () => {
    expect(phaseAfterListen({ kind: "heard", transcript: "hey" })).toEqual({ kind: "no_name", heard: "hey" });
  });
  it("maps problems, and an abort back to idle", () => {
    expect(phaseAfterListen({ kind: "problem", problem: "denied", heard: "" })).toEqual({
      kind: "listen_problem",
      problem: "denied",
      heard: "",
    });
    expect(phaseAfterListen({ kind: "problem", problem: "aborted", heard: "" })).toEqual({ kind: "idle" });
  });
});

describe("guestRequestProblem", () => {
  it("maps server answers", () => {
    expect(guestRequestProblem(new ApiRequestError("invalid_request", "x", 400))).toBe("no_name");
    expect(guestRequestProblem(new ApiRequestError("rate_limited", "x", 429))).toBe("rate_limited");
    expect(guestRequestProblem(new ApiRequestError("not_found", "x", 404))).toBe("off");
    expect(guestRequestProblem(new ApiRequestError("internal", "x", 404))).toBe("off");
    expect(guestRequestProblem(new ApiRequestError("network", "x"))).toBe("network");
    expect(guestRequestProblem(new ApiRequestError("timeout", "x"))).toBe("network");
    expect(guestRequestProblem(new ApiRequestError("internal", "x", 500))).toBe("failed");
    expect(guestRequestProblem(new Error("x"))).toBe("failed");
  });
});

describe("statusLines", () => {
  it("shows listening, heard and name", () => {
    expect(statusLines({ kind: "idle" })).toEqual([]);
    expect(statusLines({ kind: "listening", heard: "" })).toEqual(["Listening… Say 'Hi, my name is …'"]);
    expect(statusLines({ kind: "listening", heard: "hi my" })[1]).toBe("Heard: “hi my”");
    expect(statusLines({ kind: "creating", heard: "hi my name is Sam", name: "Sam" })).toEqual([
      "Heard: “hi my name is Sam”",
      "Name: Sam",
      "Getting you in…",
    ]);
    expect(statusLines({ kind: "creating", heard: null, name: "Sam" })).toEqual(["Name: Sam", "Getting you in…"]);
    expect(statusLines({ kind: "in", name: "Sam" })).toEqual([welcomeLine("Sam")]);
    expect(welcomeLine("Sam")).toBe("Yo Sam, you're in.");
  });
  it("keeps what was heard visible on a miss", () => {
    const lines = statusLines({ kind: "no_name", heard: "hello" });
    expect(lines[0]).toBe("Heard: “hello”");
    expect(lines[1]).toMatch(/Couldn't pick out a name/);
  });
});
