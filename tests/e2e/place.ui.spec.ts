// Place-based matching in the browser, at phone size. Geolocation is the
// browser's own (Playwright grants the permission and sets the position), so
// the page reports it exactly as it would from a phone. This is not a test of
// real GPS or of the glasses.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { BASE_URL } from "./helpers/env";
import { must } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches, sleep } from "./helpers/assertions";
import { freshSpot, metresNorth, type Spot } from "./helpers/geo";
import { expect, test } from "./helpers/fixtures";
import type { Person } from "./helpers/scenario";
import { adminClient } from "./helpers/users";

const PHONE = { width: 390, height: 844 };

interface Phone {
  person: Person;
  context: BrowserContext;
  page: Page;
}

/** A phone-sized browser for `person`; with `at` the location permission is granted and the position set. */
async function phone(browser: Browser, person: Person, at?: Spot): Promise<Phone> {
  const context = await person.browserContext(
    browser,
    at
      ? { viewport: PHONE, permissions: ["geolocation"], geolocation: { latitude: at.lat, longitude: at.lng, accuracy: 5 } }
      : { viewport: PHONE },
  );
  const page = await context.newPage();
  await page.goto("/encounter");
  return { person, context, page };
}

const modeSwitch = (page: Page) => page.getByRole("switch", { name: "Encounter mode" });
const placeStatus = (page: Page) => page.getByRole("status", { name: "Place status" });
const interested = (page: Page) => page.getByRole("button", { name: "Interested", exact: true });
const moment = (page: Page) => page.getByRole("dialog", { name: /mutual/i });

async function turnOn(page: Page): Promise<void> {
  await modeSwitch(page).click();
  await expect(modeSwitch(page)).toHaveAttribute("aria-checked", "true");
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
}

/** Waits until the server holds a location for `who` close to `at` (read with the service role, test only). */
async function waitForReportedAt(who: Person, at: Spot): Promise<void> {
  await expect
    .poll(
      async () => {
        const { data } = await adminClient().from("user_presence").select("lat, lng").eq("user_id", who.user.id).maybeSingle();
        return data?.lat == null ? null : Math.abs(data.lat - at.lat) < 1e-6 && Math.abs(data.lng - at.lng) < 1e-6;
      },
      { timeout: 20_000, message: "the page reports the new position" },
    )
    .toBe(true);
}

/** Two phones at `spot` and 20 m north of it, both ready to signal (mode on, located). */
async function readyNearbyPhones(browser: Browser, a: Person, b: Person, spot: Spot) {
  const pa = await phone(browser, a, spot);
  const pb = await phone(browser, b, metresNorth(spot, 20));
  for (const p of [pa, pb]) {
    await turnOn(p.page);
    await expect(placeStatus(p.page)).toContainText("Ready to signal");
    await expect(interested(p.page)).toBeEnabled();
  }
  return { pa, pb };
}

test.describe("UI: matching by place, phone viewport", () => {
  test("two people turn on Encounter mode, become ready by location alone, signal and match with no code shared", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const { pa, pb } = await readyNearbyPhones(browser, a, b, freshSpot());

    // Ready by location: no venue, location line says how accurate.
    await expect(pa.page.getByText("Not checked in at a venue.")).toBeVisible();
    await expect(pa.page.getByText(/Location on, accurate to about \d+ m/)).toBeVisible();
    await expect(modeSwitch(pa.page).locator("xpath=ancestor::section[1]")).toContainText("On. Your signals can match with someone near you.");
    await expectNoHorizontalScroll(pa.page);

    await interested(pa.page).click();
    await expect(pa.page.getByText("Your signal is out", { exact: true })).toBeVisible();
    await sleep(1500);
    await expect(moment(pb.page)).toHaveCount(0);
    await interested(pb.page).click();

    for (const [me, other] of [[pa, pb], [pb, pa]] as const) {
      const dialog = moment(me.page);
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText(other.person.displayName);
      await expect(dialog).toContainText("You were near each other");
      await expect(dialog).toContainText("SocialEyes pairs you with the nearest person who signalled within the same few seconds. In a crowd, that can be the wrong person.");
    }
    const { forA, forB } = await expectExactlyOneSharedMatch(a.api, b.api);
    for (const card of [forA, forB]) expect(card).toMatchObject({ venueLabel: "Nearby", venueLabelSource: "phone_location" });

    // Match card and detail on the matches page.
    await pa.page.getByRole("button", { name: "Not now" }).click();
    await pa.page.goto("/matches");
    const link = pa.page.getByRole("link", { name: new RegExp(`${b.displayName}, you were near each other`) });
    await expect(link).toBeVisible();
    await expect(link).toContainText("You were near each other");
    await link.click();
    await expect(pa.page.getByText(/near each other/).first()).toBeVisible();
    await expectNoHorizontalScroll(pa.page);
  });

  test("moving one phone 500 m away: signalling again does not match", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const spot = freshSpot();
    const { pa, pb } = await readyNearbyPhones(browser, a, b, spot);

    const away = metresNorth(spot, 500);
    await pb.context.setGeolocation({ latitude: away.lat, longitude: away.lng, accuracy: 5 });
    await waitForReportedAt(b, away);

    await interested(pa.page).click();
    await expect(pa.page.getByText("Your signal is out", { exact: true })).toBeVisible();
    await interested(pb.page).click();
    await expect(pb.page.getByText("Your signal is out", { exact: true })).toBeVisible();
    await sleep(2000);
    for (const p of [pa, pb]) await expect(moment(p.page)).toHaveCount(0);
    await expectNoMatches(a.api, b.api);
  });

  test("turning Encounter mode off makes the server forget the location", async ({ world, browser }) => {
    const a = await world.person();
    const p = await phone(browser, a, freshSpot());
    await turnOn(p.page);
    await expect(placeStatus(p.page)).toContainText("Ready to signal");
    await expect.poll(async () => must(await a.api.getEncounter()).location.status).toBe("fresh");

    await modeSwitch(p.page).click();
    await expect(modeSwitch(p.page)).toHaveAttribute("aria-checked", "false");
    await expect(placeStatus(p.page)).toContainText("Encounter mode is off");
    await expect(p.page.getByText("Location off. SocialEyes only uses it while Encounter mode is on.")).toBeVisible();
    await expect.poll(async () => must(await a.api.getEncounter()).location.status).toBe("none");
    expect(must(await a.api.getEncounter())).toMatchObject({ encounterMode: false, ready: false });
  });

  test("location not granted: blocked message, Not ready, Interested disabled; hosting a place fixes it and a QR link checks the other person in", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const venueName = "Phone Test Hall";
    const pa = await phone(browser, a); // no geolocation permission
    await turnOn(pa.page);
    await expect(pa.page.getByText(/Location is blocked for SocialEyes in this browser\./)).toBeVisible();
    await expect(pa.page.getByRole("button", { name: "Try location again" })).toBeVisible();
    await expect(placeStatus(pa.page)).toContainText("SocialEyes doesn't know where you are yet");
    await expect(pa.page.getByText("Not ready", { exact: true })).toBeVisible();
    await expect(interested(pa.page)).toBeDisabled();
    await expect(pa.page.getByText("SocialEyes doesn't know where you are yet. Allow location, or check in with a venue code, then signal.")).toBeVisible();

    // Host a place: checked in, QR visible, ready without location.
    await pa.page.getByLabel("Name of the place").fill(venueName);
    await pa.page.getByRole("button", { name: "Host this place" }).click();
    const hosted = await expect.poll(async () => must(await a.api.getEncounter()).checkIn?.code).toBeTruthy().then(async () => must(await a.api.getEncounter()).checkIn!);
    world.trackVenue(hosted.venueId);
    const qr = pa.page.getByRole("region", { name: `Check in at ${venueName}` });
    await expect(qr).toBeVisible();
    await expect(qr.getByRole("img", { name: `QR code that opens ${BASE_URL}/v/${hosted.code}` })).toBeVisible();
    await expect(qr.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(qr.getByRole("button", { name: "Hide QR code" })).toBeVisible();
    await expect(placeStatus(pa.page)).toContainText("Ready to signal");
    await expect(pa.page.getByText("Not ready", { exact: true })).toHaveCount(0);
    await expect(interested(pa.page)).toBeEnabled();
    await expectNoHorizontalScroll(pa.page);

    // B, signed out, opens the QR link: sign-in first, then straight back to the check-in.
    const bContext = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE });
    try {
      const pb = await bContext.newPage();
      await pb.goto(`/v/${hosted.code}`);
      await expect(pb).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(`/v/${hosted.code}`).replace(/%/g, "%")}`));
      await pb.getByLabel("Email").fill(b.user.email);
      await pb.getByLabel("Password").fill(b.user.password);
      await pb.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(pb.getByText(`You're checked in at ${venueName}`, { exact: true })).toBeVisible();
      await expect(pb).toHaveURL(/\/encounter$/); // the code is cleaned from the address
      await expect(pb.getByText(`Checked in at ${venueName}`, { exact: true })).toBeVisible();
      await turnOn(pb);
      await expect(interested(pb)).toBeEnabled();

      await interested(pa.page).click();
      await expect(pa.page.getByText("Your signal is out", { exact: true })).toBeVisible();
      await interested(pb).click();
      for (const [page, other] of [[pa.page, b], [pb, a]] as const) {
        await expect(moment(page)).toBeVisible({ timeout: 5000 });
        await expect(moment(page)).toContainText(other.displayName);
        await expect(moment(page)).toContainText(`Met at ${venueName}`);
      }
      const { forA, forB } = await expectExactlyOneSharedMatch(a.api, b.api);
      for (const card of [forA, forB]) expect(card).toMatchObject({ venueLabel: venueName, venueLabelSource: "venue_checkin" });
    } finally {
      await bContext.close();
    }
  });

  test("a QR link with an unknown code says so", async ({ world, browser }) => {
    const a = await world.person();
    const p = await phone(browser, a);
    await p.page.goto("/v/ZZZZZZ");
    await expect(p.page.getByText("That venue code isn't known")).toBeVisible();
    expect(must(await a.api.getEncounter()).checkIn).toBeNull();
  });

  test("typing an unknown venue code shows an error; a known one checks in", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const venue = await world.venue(a, "Typed Code Hall");
    const p = await phone(browser, b);
    await p.page.getByLabel("Venue code", { exact: true }).fill("ZZZZZZ");
    await p.page.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(p.page.getByText("No place has the code ZZZZZZ. Check it and try again.")).toBeVisible();
    await p.page.getByLabel("Venue code", { exact: true }).fill(venue.code);
    await p.page.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(p.page.getByText("You're checked in at Typed Code Hall.")).toBeVisible();
    await p.page.getByRole("button", { name: "Leave" }).click();
    await expect(p.page.getByText("Not checked in at a venue.")).toBeVisible();
    expect(must(await b.api.getEncounter()).checkIn).toBeNull();
  });

  test("\"Not who you meant? Unmatch\" ends the match for both people", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const { pa, pb } = await readyNearbyPhones(browser, a, b, freshSpot());
    await interested(pa.page).click();
    await interested(pb.page).click();
    for (const p of [pa, pb]) await expect(moment(p.page)).toBeVisible({ timeout: 5000 });
    const { forA } = await expectExactlyOneSharedMatch(a.api, b.api);

    await pa.page.getByRole("button", { name: "Not who you meant? Unmatch" }).click();
    const confirm = pa.page.getByRole("dialog", { name: `Unmatch ${b.displayName}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Unmatch", exact: true }).click();
    await expect(moment(pa.page)).toHaveCount(0);
    await expectNoMatches(a.api, b.api);
    for (const who of [a, b]) expect((await who.api.getMatch(forA.id)).status).toBe(404);
    // The other person's open moment goes away too.
    await expect(moment(pb.page)).toHaveCount(0, { timeout: 5000 });
  });

  test("End demo leaves the person off, checked out and without a location", async ({ world, browser }) => {
    const a = await world.person();
    const venue = await world.venue(a, "End Demo Hall");
    expect(venue.name).toBe("End Demo Hall");
    const p = await phone(browser, a, freshSpot());
    await turnOn(p.page);
    await expect(placeStatus(p.page)).toContainText("Ready to signal");
    await expect.poll(async () => must(await a.api.getEncounter()).location.status).toBe("fresh");

    await p.page.getByText("Demo controls").click();
    await p.page.getByRole("button", { name: "End demo" }).click();
    const dialog = p.page.getByRole("dialog", { name: "End the demo?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "End demo" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(modeSwitch(p.page)).toHaveAttribute("aria-checked", "false");
    await expect(p.page.getByText("Not checked in at a venue.")).toBeVisible();
    const st = must(await a.api.getEncounter());
    expect(st).toMatchObject({ encounterMode: false, checkIn: null, ready: false, pendingSignal: null, location: { status: "none" } });
    await sleep(1500);
    expect(must(await a.api.getEncounter()).location.status, "the page does not report again").toBe("none");
  });

  test("Reset demo ends the match for both and keeps the place", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const { pa, pb } = await readyNearbyPhones(browser, a, b, freshSpot());
    await interested(pa.page).click();
    await interested(pb.page).click();
    for (const p of [pa, pb]) await expect(moment(p.page)).toBeVisible({ timeout: 5000 });
    await pa.page.getByRole("button", { name: "Not now" }).click();
    await pa.page.getByText("Demo controls").click();
    await pa.page.getByRole("button", { name: "Reset demo" }).click();
    const dialog = pa.page.getByRole("dialog", { name: "Reset the demo?" });
    await dialog.getByRole("button", { name: "Reset demo" }).click();
    await expect(dialog).toHaveCount(0);
    await expectNoMatches(a.api, b.api);
    expect(must(await a.api.getEncounter())).toMatchObject({ encounterMode: true, ready: true });
  });
});
