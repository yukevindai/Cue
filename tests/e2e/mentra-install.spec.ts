import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers/env";

/**
 * The Mentra Live mini app is installed from this website. The site serves the
 * files `mentra-miniapp release` would serve from a laptop, without sign-in,
 * and a public page with the install QR code. Nothing here runs on glasses or
 * in the Mentra app: whether that app accepts the link is checked on a phone.
 */
const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../apps/mentra/miniapp.json"), "utf8")) as {
  packageName: string;
  version: string;
  name: string;
  entry: { background: string; ui: string };
};

test.describe("Mentra mini app release files", () => {
  test("manifest, icon and health are served to a signed-out visitor", async ({ request }) => {
    const m = await request.get("/mentra/miniapp.json");
    expect(m.status()).toBe(200);
    expect(await m.json()).toMatchObject({ packageName: manifest.packageName, version: manifest.version });

    const icon = await request.get("/mentra/icon.png");
    expect(icon.status()).toBe(200);
    expect((await icon.body()).subarray(1, 4).toString("latin1")).toBe("PNG");

    const health = await request.get("/mentra/__mentra_release/health");
    expect(health.status()).toBe(200);
    expect(JSON.parse(await health.text())).toEqual({ ok: true });
  });

  test("bundle.zip is a zip holding the mini app's entry files", async ({ request }) => {
    const res = await request.get("/mentra/bundle.zip");
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // Entry names are stored uncompressed in the archive's directory.
    const text = body.toString("latin1");
    for (const name of [manifest.entry.background, manifest.entry.ui, "miniapp.json", "icon.png"]) {
      expect(text, `archive lists ${name}`).toContain(name);
    }
    expect(body.length).toBeGreaterThan(20_000);
  });

  test("the bundle carries no secrets", async ({ request }) => {
    const text = (await (await request.get("/mentra/bundle.zip")).body()).toString("latin1");
    for (const marker of ["service_role", "sk-ant-", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"]) {
      expect(text).not.toContain(marker);
    }
  });
});

test.describe("UI: install page", () => {
  test("a signed-out visitor sees the QR code and an install link for this site", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mentra");
    await expect(page).toHaveURL(/\/mentra$/); // not sent to sign-in
    await expect(page.getByRole("heading", { level: 1, name: "Install on Mentra Live" })).toBeVisible();
    await expect(page.getByRole("img", { name: "QR code that installs the Cue mini app in the Mentra app" })).toBeVisible();
    await expect(page.getByText(`${manifest.name} mini app, version ${manifest.version}`)).toBeVisible();

    const href = await page.getByRole("link", { name: "Open in the Mentra app" }).getAttribute("href");
    expect(href).toBeTruthy();
    expect(href!.startsWith("miniapp://release?")).toBe(true);
    const params = Object.fromEntries(new URLSearchParams(href!.slice(href!.indexOf("?") + 1)));
    expect(params).toEqual({
      url: `${new URL(BASE_URL).origin}/mentra`,
      package: manifest.packageName,
      version: manifest.version,
      name: manifest.name,
    });
  });
});
