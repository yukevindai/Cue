import { describe, expect, it } from "vitest";
import { isGuestEmail, parseIntroName } from "./guest";

describe("parseIntroName", () => {
  it.each([
    ["Hi my name is Sam", "Sam"],
    ["hi, my name is sam.", "Sam"],
    ["Hey there! I'm Priya", "Priya"],
    ["hello im jordan", "Jordan"],
    ["Yo, it's Alex", "Alex"],
    ["I am Mary Jane", "Mary Jane"],
    ["call me DJ", "Dj"],
    ["My name's Jean-Luc, nice to meet you", "Jean-Luc"],
    ["um hi my name is O'Neil and I like hiking", "O'Neil"],
    ["Sam", "Sam"],
    ["mary jane watson", "Mary Jane Watson"],
    ["Hi, my name is María José", "María José"],
    ["this is McKenzie", "McKenzie"],
    ["  HI   MY NAME IS   SAM  ", "Sam"],
    ["Hi my name is Sam 😀", "Sam"],
  ])("%j -> %j", (said, name) => {
    expect(parseIntroName(said)).toBe(name);
  });

  it.each([
    "",
    "   ",
    "hi",
    "hey there",
    "hello hello",
    "12345",
    "!!!",
    "what is this app and how does it work",
    "my name is",
    "i'm",
    "x".repeat(201),
    "hi my name is " + "a".repeat(41),
  ])("rejects %j", (said) => {
    expect(parseIntroName(said)).toBeNull();
  });

  it("requireLeadIn accepts only real introductions", () => {
    expect(parseIntroName("Hi my name is Sam", { requireLeadIn: true })).toBe("Sam");
    expect(parseIntroName("I'm Sam", { requireLeadIn: true })).toBe("Sam");
    for (const said of ["Sam", "thank you", "oh no", "hey there", "turn left"]) {
      expect(parseIntroName(said, { requireLeadIn: true })).toBeNull();
    }
  });

  it("drops control characters and markup-like input rather than keeping it", () => {
    expect(parseIntroName("my name is Sam\u0000\u0007")).toBe("Sam");
    expect(parseIntroName("<script>alert(1)</script>")).not.toMatch(/[<>()]/);
  });
});

describe("isGuestEmail", () => {
  it("recognises only the guest domain", () => {
    expect(isGuestEmail("guest-1234@guest.cue.invalid")).toBe(true);
    expect(isGuestEmail("GUEST-1@GUEST.CUE.INVALID")).toBe(true);
    expect(isGuestEmail("alex@cue.demo")).toBe(false);
    expect(isGuestEmail("guest.cue.invalid@example.com")).toBe(false);
    expect(isGuestEmail(null)).toBe(false);
  });
});
