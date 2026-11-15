import { describe, expect, it } from "vitest";
import { mentraInstallLink, mentraReleaseBase, readMentraManifest } from "./mentra-install";

const manifest = { packageName: "demo.cue.mentra", version: "0.2.0", name: "SocialEyes" };

describe("readMentraManifest", () => {
  it("keeps the fields the install link needs", () => {
    expect(readMentraManifest({ ...manifest, permissions: [], port: 3100 })).toEqual(manifest);
  });
  it("falls back to the package name when there is no display name", () => {
    expect(readMentraManifest({ packageName: "demo.cue.mentra", version: "1.0.0" })?.name).toBe("demo.cue.mentra");
  });
  it.each([null, "x", {}, { packageName: "cue", version: "0.2.0" }, { packageName: "demo.cue.mentra", version: "two" }, { packageName: 5, version: "0.2.0" }])(
    "rejects %j",
    (bad) => {
      expect(readMentraManifest(bad)).toBeNull();
    },
  );
});

describe("mentraInstallLink", () => {
  it("points the Mentra app at <origin>/mentra", () => {
    expect(mentraReleaseBase("https://socialeyes.example/")).toBe("https://socialeyes.example/mentra");
    const link = mentraInstallLink("https://socialeyes.example", manifest);
    expect(link.startsWith("miniapp://release?")).toBe(true);
    const params = new URLSearchParams(link.slice(link.indexOf("?") + 1));
    expect(Object.fromEntries(params)).toEqual({
      url: "https://socialeyes.example/mentra",
      package: "demo.cue.mentra",
      version: "0.2.0",
      name: "SocialEyes",
    });
  });
  it("escapes values", () => {
    const link = mentraInstallLink("https://socialeyes.example", { ...manifest, name: "SocialEyes & co" });
    expect(link).toContain("name=SocialEyes%20%26%20co");
    expect(link).toContain("url=https%3A%2F%2Fsocialeyes.example%2Fmentra");
  });
});
