import type { Browser, BrowserContext, Page } from "@playwright/test";
import { MATCH_WINDOW_SECONDS, type WingmanModelOutput } from "@cue/contracts";
import { BASE_URL } from "./helpers/env";
import { interestEvent, must } from "./helpers/api";
import { expectExactlyOneSharedMatch, expectNoMatches, sleep, sleepPast } from "./helpers/assertions";
import { linkDevice } from "./helpers/device";
import { expect, test } from "./helpers/fixtures";
import { signal, type Pair, type Person } from "./helpers/scenario";

/** Both people must see the match moment within this long of the completing click. */
const NOTIFY_BUDGET_MS = 2000;
/** Time given to a (wrong) update to reach the other browser before asserting it did not. */
const PROPAGATION_GRACE_MS = 1500;
const VENUE = "E2E Test Cafe";

/** One signed-in browser window for one person. */
interface Browsing {
  person: Person;
  context: BrowserContext;
  page: Page;
}

async function openEncounter(browser: Browser, person: Person): Promise<Browsing> {
  const context = await person.browserContext(browser);
  const page = await context.newPage();
  await page.goto("/encounter");
  return { person, context, page };
}

/** Encounter page of someone in a two-person session with encounter mode on: the signal control is ready. */
async function openReadyEncounter(browser: Browser, person: Person): Promise<Browsing> {
  const b = await openEncounter(browser, person);
  await expect(interestedButton(b.page)).toBeEnabled();
  return b;
}

const interestedButton = (page: Page) => page.getByRole("button", { name: "Interested", exact: true });
const matchMoment = (page: Page) => page.getByRole("dialog", { name: /mutual/i });
const noMatchesYet = (page: Page) => page.getByText("No matches yet");

/** Clicks "Interested" and returns once the click has resolved. */
async function clickInterested(b: Browsing): Promise<void> {
  await interestedButton(b.page).click();
}

async function expectSignalOut(b: Browsing): Promise<void> {
  await expect(b.page.getByText("Your signal is out", { exact: true })).toBeVisible();
}

/**
 * Nothing about the other person, a signal or a match is visible in this
 * browser: the signal control is untouched, and /matches is empty (checked on
 * the live page and again after a full reload).
 */
async function expectNoHintOfOther(b: Browsing, other: Person): Promise<void> {
  const { page } = b;
  await page.goto("/encounter");
  await expect(interestedButton(page)).toBeEnabled();
  await expect(page.getByText("Whenever you're ready")).toBeVisible();
  await expect(page.getByText("Your signal is out", { exact: true })).toHaveCount(0);
  await expect(matchMoment(page)).toHaveCount(0);
  await expectPageHasNothingOf(page, other);

  await page.goto("/matches");
  await expect(noMatchesYet(page)).toBeVisible();
  await expectPageHasNothingOf(page, other);
  await page.reload();
  await expect(noMatchesYet(page)).toBeVisible();
  await expectPageHasNothingOf(page, other);
}

async function expectPageHasNothingOf(page: Page, other: Person): Promise<void> {
  const text = await page.locator("body").innerText();
  const html = await page.content();
  for (const needle of [other.displayName, other.user.marker, other.user.email, other.user.id]) {
    expect(text, `page text must not contain ${needle}`).not.toContain(needle);
    expect(html, `page html must not contain ${needle}`).not.toContain(needle);
  }
}

/**
 * Waits for the match moment in every given browser and returns how long it
 * took, measured from now (call it right after the completing click resolved).
 */
async function momentsWithin(browsings: Browsing[], budgetMs: number): Promise<number[]> {
  const t0 = Date.now();
  return Promise.all(
    browsings.map(async (b) => {
      await matchMoment(b.page).waitFor({ state: "visible", timeout: budgetMs });
      return Date.now() - t0;
    }),
  );
}

function reportLatency(label: string, latencies: number[]): void {
  const msg = `${label}: match moment after ${latencies.map((ms) => `${ms} ms`).join(" / ")} (completing browser last)`;
  console.log(`[latency] ${msg}`);
  test.info().annotations.push({ type: "latency", description: msg });
}

/** Both people got the moment, within budget, naming the other person, venue and time. */
async function expectMomentsShowOther(a: Browsing, b: Browsing): Promise<void> {
  for (const [me, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const dialog = matchMoment(me.page);
    await expect(dialog).toContainText(other.person.displayName);
    await expect(dialog).toContainText(VENUE);
    await expect(dialog).not.toContainText(me.person.displayName);
  }
}

/** Time text exactly as the page formats it in this browser (locale and zone of the browser). */
async function browserTime(page: Page, iso: string): Promise<string> {
  return page.evaluate(
    (v) => new Date(v).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    iso,
  );
}

/** The matches page of `me` shows the other person's approved profile fields, venue and encounter time. */
async function expectMatchesPageShowsOther(me: Browsing, other: Person, encounterAt: string): Promise<void> {
  const { page } = me;
  await page.goto("/matches");
  const card = page.getByRole("link", { name: new RegExp(`${other.displayName}.*met at ${VENUE}`) });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`Met at ${VENUE}`);
  await expect(card).toContainText(await browserTime(page, encounterAt));
  await expect(card).toContainText(other.profile.bio ?? "");
  for (const interest of other.profile.interests ?? []) await expect(card).toContainText(interest);
}

/** Opens the match detail through the card and checks the approved fields. */
async function expectMatchDetailShowsOther(me: Browsing, other: Person): Promise<void> {
  const { page } = me;
  await page.goto("/matches");
  await page.getByRole("link", { name: new RegExp(`${other.displayName}.*met at ${VENUE}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: other.displayName })).toBeVisible();
  await expect(page.getByText(other.profile.bio ?? "")).toBeVisible();
  for (const interest of other.profile.interests ?? []) {
    await expect(page.getByRole("listitem").filter({ hasText: interest }).first()).toBeVisible();
  }
  await expect(page.getByText(`at ${VENUE}`)).toBeVisible();
  await expect(page.getByRole("link", { name: /Site/ })).toHaveAttribute("href", `https://example.com/${other.user.marker}`);
}

test.describe("UI: two browsers, two signed-in people", () => {
  for (const order of ["A then B", "B then A"] as const) {
    test(`both browsers show the match within 2 s of the second click (${order})`, async ({ world, browser }) => {
      const pair = await world.pair({ venue: VENUE });
      const [first, second] = order === "A then B" ? [pair.a, pair.b] : [pair.b, pair.a];
      const bFirst = await openReadyEncounter(browser, first);
      const bSecond = await openReadyEncounter(browser, second);

      // The first person signals in their own browser.
      await clickInterested(bFirst);
      await expectSignalOut(bFirst);

      // The second person's browser shows nothing: not on Encounter, not on Matches.
      await sleep(PROPAGATION_GRACE_MS);
      await expect(matchMoment(bSecond.page)).toHaveCount(0);
      await expectNoHintOfOther(bSecond, first);
      // Still nothing in the first person's own list either (one-sided is not a match).
      await expectNoMatches(pair.a.api, pair.b.api);

      // Back on Encounter, the second person signals.
      await bSecond.page.goto("/encounter");
      await expect(interestedButton(bSecond.page)).toBeEnabled();
      await clickInterested(bSecond);
      const latencies = await momentsWithin([bFirst, bSecond], NOTIFY_BUDGET_MS);
      reportLatency(`web ${order}`, latencies);
      expect(Math.max(...latencies), "both browsers within 2 s of the click resolving").toBeLessThanOrEqual(NOTIFY_BUDGET_MS);
      await expectMomentsShowOther(bFirst, bSecond);

      // The matches page carries the other person's approved profile, venue and encounter time.
      const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
      await expectMatchesPageShowsOther(bFirst, second, forA.encounterAt);
      await expectMatchesPageShowsOther(bSecond, first, forA.encounterAt);
      await expectMatchDetailShowsOther(bFirst, second);
      await expectMatchDetailShowsOther(bSecond, first);
    });
  }

  test("full UI happy path: sign-in form, start/join with a code, encounter mode, signal, match overlay, match detail", async ({
    world,
    browser,
  }) => {
    // Users come from the factory (account + saved profile); everything else is the UI.
    const a = await world.person();
    const b = await world.person();
    const venue = "UI Happy Path Cafe";

    // A: real sign-in form in a context that carries no cookies.
    const aContext = await browser.newContext({ baseURL: BASE_URL });
    const aPage = await aContext.newPage();
    try {
      await aPage.goto("/sign-in");
      await aPage.getByLabel("Email").fill(a.user.email);
      await aPage.getByLabel("Password").fill(a.user.password);
      await aPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(aPage).toHaveURL(/\/encounter$/);

      // A starts a session in the UI.
      await aPage.getByLabel("Where are you?").fill(venue);
      await aPage.getByRole("button", { name: "Start a session" }).click();
      await expect(aPage.getByText(venue, { exact: true })).toBeVisible();
      const joinCode = must(await a.api.getEncounter(), "A encounter").session?.joinCode;
      expect(joinCode, "A's session has a join code").toBeTruthy();

      // B (signed in by cookie) joins through the join form.
      const bContext = await b.browserContext(browser);
      const bPage = await bContext.newPage();
      await bPage.goto("/encounter");
      await bPage.getByLabel("Session code").fill(joinCode!);
      await bPage.getByRole("button", { name: "Join session" }).click();
      await expect(bPage.getByText(venue, { exact: true })).toBeVisible();

      // Encounter mode on for both, in the UI, if the UI does not default to it.
      for (const page of [aPage, bPage]) {
        const resume = page.getByRole("button", { name: "Resume" });
        if (await resume.isVisible().catch(() => false)) await resume.click();
        await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
        await expect(interestedButton(page)).toBeEnabled();
      }

      // Signals and the overlay.
      const ba: Browsing = { person: a, context: aContext, page: aPage };
      const bb: Browsing = { person: b, context: bContext, page: bPage };
      await clickInterested(ba);
      await expectSignalOut(ba);
      await sleep(PROPAGATION_GRACE_MS);
      await expect(matchMoment(bPage)).toHaveCount(0);
      await clickInterested(bb);
      const latencies = await momentsWithin([ba, bb], NOTIFY_BUDGET_MS);
      reportLatency("happy path (UI session, UI signals)", latencies);
      expect(Math.max(...latencies)).toBeLessThanOrEqual(NOTIFY_BUDGET_MS);
      await expect(matchMoment(aPage)).toContainText(b.displayName);
      await expect(matchMoment(aPage)).toContainText(venue);

      // Overlay -> match detail for A; "Not now" -> Matches list for B.
      await aPage.getByRole("button", { name: new RegExp(`See ${b.displayName}`) }).click();
      await expect(aPage).toHaveURL(/\/matches\/[0-9a-f-]+$/);
      await expect(aPage.getByRole("heading", { level: 1, name: b.displayName })).toBeVisible();
      await expect(aPage.getByText(b.profile.bio ?? "")).toBeVisible();
      await expect(aPage.getByText(`at ${venue}`)).toBeVisible();

      await bPage.getByRole("button", { name: "Not now" }).click();
      await expect(matchMoment(bPage)).toHaveCount(0);
      await bPage.getByRole("link", { name: "Matches", exact: true }).first().click();
      await expect(bPage.getByRole("link", { name: new RegExp(`${a.displayName}.*met at ${venue}`) })).toBeVisible();
      await expectExactlyOneSharedMatch(a.api, b.api);
    } finally {
      await aContext.close();
    }
  });

  test("a device-token backward swipe followed by the other person's click matches in both browsers within 2 s", async ({
    world,
    browser,
  }) => {
    // NOTE: this is server-path coverage only. The "glasses" side is a device
    // token calling POST /api/interest with a mentra_touch / backward_swipe
    // event. It is NOT evidence that the physical Mentra Live swipe works.
    const pair = await world.pair({ venue: VENUE });
    const device = await linkDevice(pair.a);
    try {
      const a = await openReadyEncounter(browser, pair.a);
      const b = await openReadyEncounter(browser, pair.b);

      const ack = must(await device.api.interest(interestEvent(pair.session.id, { source: "mentra_touch" })), "device swipe");
      expect(ack).toMatchObject({ status: "accepted", matched: false });

      // A's own browser learns of its own glasses signal; B's browser learns nothing.
      await expect(a.page.getByText("Sent from your glasses")).toBeVisible();
      await sleep(PROPAGATION_GRACE_MS);
      await expect(matchMoment(b.page)).toHaveCount(0);
      await expect(interestedButton(b.page)).toBeEnabled();
      await expect(b.page.getByText("Your signal is out", { exact: true })).toHaveCount(0);
      await expectPageHasNothingOf(b.page, pair.a);

      await clickInterested(b);
      const latencies = await momentsWithin([a, b], NOTIFY_BUDGET_MS);
      reportLatency("device swipe then web click", latencies);
      expect(Math.max(...latencies)).toBeLessThanOrEqual(NOTIFY_BUDGET_MS);
      await expectMomentsShowOther(a, b);
      const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
      expect(forA.venueLabel).toBe(VENUE);
    } finally {
      await device.ctx.dispose();
    }
  });

  test("a third signed-in account cannot join and sees nothing about the pair, before or after they match", async ({
    world,
    browser,
  }) => {
    const pair = await world.pair({ venue: VENUE });
    const third = await world.person();
    const a = await openReadyEncounter(browser, pair.a);
    const b = await openReadyEncounter(browser, pair.b);
    const c = await openEncounter(browser, third);

    // Join flow in the UI: the session is full.
    await c.page.getByLabel("Session code").fill(pair.session.joinCode);
    await c.page.getByRole("button", { name: "Join session" }).click();
    await expect(c.page.getByText("That session is full")).toBeVisible();
    await expect(c.page.getByRole("button", { name: "Join session" })).toBeVisible();
    await expect(interestedButton(c.page)).toHaveCount(0);
    for (const p of [pair.a, pair.b]) await expectPageHasNothingOf(c.page, p);
    await expect(c.page.getByText(VENUE)).toHaveCount(0);
    expect(must(await third.api.getEncounter()).session).toBeNull();

    // The pair matches through the UI while the third browser is open.
    await clickInterested(a);
    await clickInterested(b);
    await momentsWithin([a, b], NOTIFY_BUDGET_MS);
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    await sleep(PROPAGATION_GRACE_MS);
    await expect(matchMoment(c.page)).toHaveCount(0);
    for (const p of [pair.a, pair.b]) await expectPageHasNothingOf(c.page, p);

    // Fresh loads of every page, and the pair's match URL itself.
    await c.page.goto("/encounter");
    await expect(c.page.getByRole("button", { name: "Start a session" })).toBeVisible();
    for (const p of [pair.a, pair.b]) await expectPageHasNothingOf(c.page, p);
    await expect(c.page.getByText(VENUE)).toHaveCount(0);
    await c.page.goto("/matches");
    await expect(noMatchesYet(c.page)).toBeVisible();
    for (const p of [pair.a, pair.b]) await expectPageHasNothingOf(c.page, p);
    await c.page.goto(`/matches/${forA.id}`);
    await expect(c.page.getByText("This match is no longer available")).toBeVisible();
    for (const p of [pair.a, pair.b]) await expectPageHasNothingOf(c.page, p);
    await expectNoMatches(third.api);
  });

  test("paused encounter mode: no signal control, and no match results", async ({ world, browser }) => {
    const pair = await world.pair({ venue: VENUE });
    const a = await openReadyEncounter(browser, pair.a);
    const b = await openReadyEncounter(browser, pair.b);

    // A pauses in the UI. The real UI removes the "Interested" control entirely.
    await a.page.getByRole("button", { name: "Pause" }).click();
    await expect(a.page.getByRole("status").filter({ hasText: "Paused" })).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(interestedButton(a.page)).toHaveCount(0);
    expect(must(await pair.a.api.getEncounter()).encounterMode).toBe(false);

    // B signals; A is paused so nothing can match.
    await clickInterested(b);
    await expectSignalOut(b);
    await sleep(PROPAGATION_GRACE_MS);
    await expect(matchMoment(a.page)).toHaveCount(0);
    await expect(matchMoment(b.page)).toHaveCount(0);
    await expect(interestedButton(a.page)).toHaveCount(0);
    await expectPageHasNothingOf(a.page, pair.b);
    await expectNoMatches(pair.a.api, pair.b.api);

    // Resuming does not retroactively signal for A.
    await a.page.getByRole("button", { name: "Resume" }).click();
    await expect(interestedButton(a.page)).toBeEnabled();
    await expect(a.page.getByText("Your signal is out", { exact: true })).toHaveCount(0);
    await sleep(PROPAGATION_GRACE_MS);
    await expect(matchMoment(a.page)).toHaveCount(0);
    await expectNoMatches(pair.a.api, pair.b.api);
    for (const who of [a, b]) {
      await who.page.goto("/matches");
      await expect(noMatchesYet(who.page)).toBeVisible();
    }
  });

  test("a first click that expires after the 15 s window does not match when the second click comes later", async ({
    world,
    browser,
  }) => {
    test.slow();
    const pair = await world.pair({ venue: VENUE });
    const a = await openReadyEncounter(browser, pair.a);
    const b = await openReadyEncounter(browser, pair.b);

    await clickInterested(a);
    await expectSignalOut(a);
    const pending = must(await pair.a.api.getEncounter()).pendingSignal;
    expect(pending, "A has a pending signal").not.toBeNull();
    const windowMs = new Date(pending!.expiresAt).getTime() - new Date(pending!.receivedAt).getTime();
    expect(windowMs).toBeGreaterThanOrEqual(MATCH_WINDOW_SECONDS * 1000 - 500);

    // One real wait past the window. A's own page reports the fade; B's page learns nothing.
    await sleepPast(pending!.expiresAt, 1500);
    await expect(a.page.getByText(/That signal has faded/).last()).toBeVisible();
    await expect(matchMoment(b.page)).toHaveCount(0);

    await clickInterested(b);
    await expectSignalOut(b);
    await sleep(PROPAGATION_GRACE_MS);
    for (const who of [a, b]) {
      await expect(matchMoment(who.page)).toHaveCount(0);
      await who.page.goto("/matches");
      await expect(noMatchesYet(who.page)).toBeVisible();
    }
    await expectNoMatches(pair.a.api, pair.b.api);
  });

  test("after unmatching in the UI, the match URL no longer shows the other person in either browser", async ({
    world,
    browser,
  }) => {
    const pair = await world.pair({ venue: VENUE });
    const a = await openReadyEncounter(browser, pair.a);
    const b = await openReadyEncounter(browser, pair.b);
    // Set-up through the API: the matching UI is covered above.
    must(await signal(pair, pair.a));
    must(await signal(pair, pair.b));
    await momentsWithin([a, b], NOTIFY_BUDGET_MS);
    const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
    const matchUrl = `/matches/${forA.id}`;

    // Both open the match through "See ...'s card"; the profile is there.
    await a.page.getByRole("button", { name: new RegExp(`See ${pair.b.displayName}`) }).click();
    await b.page.getByRole("button", { name: new RegExp(`See ${pair.a.displayName}`) }).click();
    await expect(a.page).toHaveURL(new RegExp(`${matchUrl}$`));
    await expect(b.page).toHaveURL(new RegExp(`${matchUrl}$`));
    await expect(a.page.getByRole("heading", { level: 1, name: pair.b.displayName })).toBeVisible();
    await expect(b.page.getByRole("heading", { level: 1, name: pair.a.displayName })).toBeVisible();

    // A unmatches.
    await a.page.getByRole("button", { name: "Unmatch", exact: true }).click();
    await a.page.getByRole("dialog", { name: /Unmatch/ }).getByRole("button", { name: "Unmatch", exact: true }).click();
    await expect(a.page).toHaveURL(/\/matches$/);
    await expect(noMatchesYet(a.page)).toBeVisible();
    await expect(b.page.getByText("This match is no longer available")).toBeVisible();
    await expectNoMatches(pair.a.api, pair.b.api);

    // Reloading and opening the URL fresh in either browser shows nothing about the other person.
    for (const [me, other] of [
      [a, pair.b],
      [b, pair.a],
    ] as const) {
      await me.page.goto(matchUrl);
      await expect(me.page.getByText("This match is no longer available")).toBeVisible();
      await expect(me.page.getByRole("heading", { level: 1 })).toHaveCount(0);
      await expectPageHasNothingOf(me.page, other);
      await expect(me.page.getByText(other.profile.bio ?? "")).toHaveCount(0);
    }
    for (const who of [pair.a, pair.b]) expect((await who.api.getMatch(forA.id)).status).toBe(404);
  });
});

const A_BIO = "Weekend hiker who likes pour-over coffee and board games.";
const B_BIO = "Trail runner who loves latte art.";
const GOOD_OUTPUT: WingmanModelOutput = {
  shared_interests: [
    {
      label: "Hiking",
      summary: "You both enjoy hiking.",
      your_evidence: { field: "interests", quote: "Hiking" },
      their_evidence: { field: "interests", quote: "Hiking" },
    },
  ],
  suggested_question: "What's a trail you would happily walk again?",
  opener_basis: "shared_interest",
};

async function matchedPairViaApi(world: Parameters<Parameters<typeof test>[2]>[0]["world"]): Promise<{ pair: Pair; matchId: string }> {
  const pair = await world.pair({
    venue: VENUE,
    a: { bio: A_BIO, interests: ["Hiking", "Coffee", "Chess"] },
    b: { bio: B_BIO, interests: ["Hiking", "Latte art", "Jazz"] },
  });
  must(await signal(pair, pair.a));
  must(await signal(pair, pair.b));
  const { forA } = await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);
  return { pair, matchId: forA.id };
}

/** The common-ground card: the shared interest (with evidence from both profiles) and the opener. */
async function expectCardShowsHiking(page: Page): Promise<void> {
  const card = page.getByRole("region", { name: "Find common ground" });
  await expect(card.getByRole("listitem").getByText("Hiking", { exact: true })).toBeVisible();
  await expect(card.getByText(/From your profile/)).toBeVisible();
  await expect(card.getByText("\u201cHiking\u201d").first()).toBeVisible();
  await expect(card.getByText(GOOD_OUTPUT.suggested_question as string)).toBeVisible();
  await expect(card.getByText(/Suggested by Claude/)).toBeVisible();
}

test.describe("UI: Find common ground", () => {
  test("model error shows a retry state; recovering shows the card; the other person sees nothing", async ({
    world,
    browser,
    fake,
  }) => {
    // The fake model starts in `error` mode: the match is created while the model is failing.
    const { pair, matchId } = await matchedPairViaApi(world);
    expect(matchId).toBeTruthy();

    const a = await openEncounter(browser, pair.a);
    const b = await openEncounter(browser, pair.b);
    // The match moment lands in both browsers regardless of the model.
    await matchMoment(a.page).waitFor({ state: "visible" });
    await matchMoment(b.page).waitFor({ state: "visible" });
    await a.page.getByRole("button", { name: new RegExp(`See ${pair.b.displayName}`) }).click();
    await b.page.getByRole("button", { name: new RegExp(`See ${pair.a.displayName}`) }).click();
    await expect(a.page.getByRole("heading", { level: 1, name: pair.b.displayName })).toBeVisible();
    await expect(b.page.getByRole("heading", { level: 1, name: pair.a.displayName })).toBeVisible();

    // 1. Model failing: an error with "Try again"; the match itself is unaffected.
    await a.page.getByRole("button", { name: "Find common ground" }).click();
    await expect(a.page.getByText(/Your match is unaffected/)).toBeVisible();
    const retry = a.page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(a.page.getByRole("heading", { level: 1, name: pair.b.displayName })).toBeVisible();
    expect((await fake.requests()).length).toBeGreaterThanOrEqual(1);
    await expectExactlyOneSharedMatch(pair.a.api, pair.b.api);

    // 2. Model recovers: "Try again" now shows the card with the shared interest and the opener.
    await fake.respondWith(GOOD_OUTPUT);
    await retry.click();
    await expectCardShowsHiking(a.page);
    await expect(a.page.getByText(/Your match is unaffected/)).toHaveCount(0);
    await expect(a.page.getByRole("button", { name: "Try again" })).toHaveCount(0);

    // 3. The other person's browser shows nothing about the request, live or after a reload.
    await sleep(PROPAGATION_GRACE_MS);
    for (const reload of [false, true]) {
      if (reload) await b.page.reload();
      await expect(b.page.getByRole("button", { name: "Find common ground" })).toBeVisible();
      await expect(b.page.getByText(/From your profile/)).toHaveCount(0);
      await expect(b.page.getByText(GOOD_OUTPUT.suggested_question as string)).toHaveCount(0);
      await expect(b.page.getByText(/Suggested by Claude/)).toHaveCount(0);
      await expect(b.page.getByText(/suggestion service|took too long/)).toHaveCount(0);
      await expect(b.page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    }
  });

  test("model ok straight away: the card shows the shared interest and the opener", async ({ world, browser, fake }) => {
    const { pair } = await matchedPairViaApi(world);
    await fake.respondWith(GOOD_OUTPUT);
    const a = await openEncounter(browser, pair.a);
    await matchMoment(a.page).waitFor({ state: "visible" });
    await a.page.getByRole("button", { name: new RegExp(`See ${pair.b.displayName}`) }).click();
    await a.page.getByRole("button", { name: "Find common ground" }).click();
    await expectCardShowsHiking(a.page);
    await expect(a.page.getByText(`From ${pair.b.displayName}'s profile`)).toBeVisible();
  });
});
