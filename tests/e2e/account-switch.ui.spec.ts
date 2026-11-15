import { BASE_URL } from "./helpers/env";
import { must } from "./helpers/api";
import { expect, test } from "./helpers/fixtures";
import { freshSpot, locate } from "./helpers/geo";
import { adminClient } from "./helpers/users";

/**
 * Tabs of one browser share a single login. Signing in as someone else in a
 * second tab must not leave the first tab showing the old account while its
 * requests go out as the new one.
 */
test.describe("one browser, two tabs, two accounts", () => {
  test("a tab reloads as the new account when another tab signs in as someone else", async ({ world, browser }) => {
    const a = await world.person();
    const b = await world.person();
    const venue = "Tab Switch Cafe";

    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      // Both tabs open the sign-in page before anyone signs in.
      const tabA = await context.newPage();
      const tabB = await context.newPage();
      await tabA.goto("/sign-in");
      await tabB.goto("/sign-in");

      // Tab A signs in as A and hosts a place (which checks A in).
      await tabA.getByLabel("Email").fill(a.user.email);
      await tabA.getByLabel("Password").fill(a.user.password);
      await tabA.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(tabA).toHaveURL(/\/encounter$/);
      await tabA.getByLabel("Name of the place").fill(venue);
      await tabA.getByRole("button", { name: "Host this place" }).click();
      await expect(tabA.getByText(`Checked in at ${venue}`, { exact: true })).toBeVisible();
      const hosted = must(await a.api.getEncounter(), "A encounter").checkIn;
      if (hosted) world.trackVenue(hosted.venueId);

      // Tab B (its sign-in page was already loaded) signs in as B.
      await tabB.getByLabel("Email").fill(b.user.email);
      await tabB.getByLabel("Password").fill(b.user.password);
      await tabB.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(tabB).toHaveURL(/\/encounter$/);

      // Back in tab A, without reloading it by hand: moving to Profile inside
      // the app must show the account the browser is really signed in as.
      await tabA.bringToFront();
      await tabA.getByRole("link", { name: "Profile" }).first().click();
      await expect(tabA).toHaveURL(/\/profile$/);
      await expect(tabA.getByText(b.user.email)).toBeVisible();
      await expect(tabA.getByText(a.user.email)).toHaveCount(0);

      // And the Encounter view is B's (not checked in anywhere), not A's.
      await tabA.getByRole("link", { name: "Encounter" }).first().click();
      await expect(tabA.getByText("Not checked in at a venue.")).toBeVisible();
      await expect(tabA.getByText(`Checked in at ${venue}`, { exact: true })).toHaveCount(0);

      // A's check-in was not touched by anything the stale tab did.
      const aEncounter = must(await a.api.getEncounter(), "A encounter");
      expect(aEncounter.checkIn?.name).toBe(venue);
      expect(must(await b.api.getEncounter(), "B encounter").checkIn).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("a tab goes to sign-in when another tab signs out", async ({ world, browser }) => {
    const a = await world.person();
    // A is open to signals, checked in and located before signing out.
    await world.venue(a, "Sign Out Cafe");
    must(await a.api.setMode(true));
    await locate(a, freshSpot(), 5);
    const context = await a.browserContext(browser);
    try {
      const tab1 = await context.newPage();
      const tab2 = await context.newPage();
      await tab1.goto("/encounter");
      await tab2.goto("/profile");
      await tab2.getByRole("button", { name: "Sign out" }).click();
      await expect(tab2).toHaveURL(/\/sign-in/);

      // Signing out turned Encounter mode off and forgot the location; the venue check-in is kept.
      // Read with the service role: the web session is gone.
      const { data: presence, error } = await adminClient()
        .from("user_presence")
        .select("encounter_mode, venue_id, lat, lng, accuracy_m, located_at")
        .eq("user_id", a.user.id)
        .single();
      expect(error).toBeNull();
      expect(presence).toMatchObject({ encounter_mode: false, lat: null, lng: null, accuracy_m: null, located_at: null });
      expect(presence?.venue_id).not.toBeNull();

      await tab1.bringToFront();
      await expect(tab1).toHaveURL(/\/sign-in/);
    } finally {
      await context.close();
    }
  });
});
