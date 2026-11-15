// Guest entry ("Say hi") and the spoken wingman line, in the browser at phone size.
//
// Speech is FAKED here (tests/e2e/helpers/speech.ts): a scripted recogniser replaces both
// SpeechRecognition constructors and a recorder replaces speechSynthesis. These tests prove what
// the pages do with words they are handed and what they ask to be spoken. They do not prove real
// speech recognition, real audio, a real microphone permission prompt, or real glasses.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { BASE_URL } from "./helpers/env";
import { must } from "./helpers/api";
import { linkDevice } from "./helpers/device";
import { expect, test } from "./helpers/fixtures";
import { freshSpot, metresNorth, type Spot } from "./helpers/geo";
import { signal, syntheticProfile, type Guest, type World } from "./helpers/scenario";
import { failListening, hearFinal, hearInterim, installSpeechFakes, spoken, spokenAloud, type RecognitionKind } from "./helpers/speech";
import { countGuestUsers } from "./helpers/users";

const PHONE = { width: 390, height: 844 };

/** A letters-only name with a random tail, so the account made for it can be told from every other. */
function uniqueName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let tail = "";
  for (let i = 0; i < 8; i++) tail += letters[Math.floor(Math.random() * letters.length)];
  return `Tess ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** A signed-out phone-sized page, optionally with the speech fakes installed. */
async function signedOutPage(world: World, browser: Browser, opts: { speech?: RecognitionKind | false; path?: string } = {}): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE });
  world.onCleanup(() => context.close());
  if (opts.speech !== false) await installSpeechFakes(context, { recognition: opts.speech ?? "fake" });
  const page = await context.newPage();
  await page.goto(opts.path ?? "/sign-in");
  return page;
}

const entry = (page: Page) => page.getByTestId("guest-entry");
const status = (page: Page) => page.getByTestId("guest-status");
const sayHi = (page: Page) => entry(page).getByRole("button", { name: "Say hi" });
const typedField = (page: Page) => entry(page).getByLabel("Or type it");
const continueAsGuest = (page: Page) => entry(page).getByRole("button", { name: "Continue as guest" });

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
}

test.describe("UI: guest entry", () => {
  test("typed route end to end, no fakes: a guest is made, lands on Encounter, the profile shows the name and says it is a guest", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser, { speech: false });
    await expect(entry(page).getByRole("heading", { name: "New here? Just say hi" })).toBeVisible();
    await expect(typedField(page)).toHaveAttribute("placeholder", "Hi, my name is …");
    await expectNoHorizontalScroll(page);
    const name = uniqueName();
    const before = await countGuestUsers();

    await typedField(page).fill(`Hi, my name is ${name}`);
    await continueAsGuest(page).click();
    await expect(page).toHaveURL(/\/encounter$/);
    expect(await countGuestUsers()).toBe(before + 1);

    await page.goto("/profile");
    await expect(page.getByLabel("Display name")).toHaveValue(name);
    await expect(page.getByText("Signed in as a guest")).toBeVisible();
    await expect(page.getByText("Guest accounts have no email or password")).toBeVisible();
    const me = (await (await page.request.get("/api/profile")).json()) as { displayName: string; isGuest: boolean };
    expect(me).toMatchObject({ displayName: name, isGuest: true });
  });

  test("typed: nothing, and an unreadable line, are told what to do and make no account; the sign-up page has the card too", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser, { speech: false });
    const before = await countGuestUsers();

    await continueAsGuest(page).click();
    await expect(entry(page).getByText("Type your name, or 'Hi, my name is …'.")).toBeVisible();
    await typedField(page).fill("hello there");
    await continueAsGuest(page).click();
    await expect(entry(page).getByText("SocialEyes couldn't pick a name out of that. Try 'Hi, my name is Sam', or just your first name.")).toBeVisible();
    await typedField(page).fill("my name is");
    await continueAsGuest(page).click();
    await expect(entry(page).getByText("SocialEyes couldn't pick a name out of that.")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(await countGuestUsers()).toBe(before);

    await page.goto("/sign-up");
    await expect(entry(page).getByRole("heading", { name: "New here? Just say hi" })).toBeVisible();
    await expect(entry(page).getByLabel("Or type it")).toBeVisible();
  });

  test("Say hi: interim words, final words, the name, the account, then the prime and the welcome are what the page spoke", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser);
    const name = uniqueName();
    const before = await countGuestUsers();

    // Hold the account request so the in-between states can be read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/guest", async (route) => {
      await gate;
      await route.continue();
    });

    await sayHi(page).click();
    await expect(entry(page).getByRole("button", { name: "Stop listening" })).toBeVisible();
    await expect(status(page)).toContainText("Listening");
    await hearInterim(page, "hi my name");
    await expect(status(page)).toContainText("Heard: “hi my name”");
    await hearFinal(page, `hi my name is ${name}`);
    await expect(status(page)).toContainText(`Heard: “hi my name is ${name}”`);
    await expect(status(page)).toContainText(`Name: ${name}`);
    await expect(status(page)).toContainText("Getting you in…");
    expect(await countGuestUsers(), "nothing is created until the request is released").toBe(before);

    release();
    await expect(page).toHaveURL(/\/encounter$/);
    expect(await countGuestUsers()).toBe(before + 1);
    const me = (await (await page.request.get("/api/profile")).json()) as { displayName: string; isGuest: boolean };
    expect(me).toMatchObject({ displayName: name, isGuest: true });

    // The tap primed speech with a silent empty utterance; the welcome came after the account existed.
    expect(await spoken(page)).toEqual([
      { text: "", volume: 0 },
      { text: `Yo ${name}, you're in.`, volume: 1 },
    ]);
  });

  test("Say hi with words that hold no name keeps what was heard, says what to do and creates nothing; saying a name afterwards works", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser);
    const before = await countGuestUsers();

    await sayHi(page).click();
    await hearFinal(page, "um hello there");
    await expect(status(page)).toContainText("Heard: “um hello there”");
    await expect(status(page)).toContainText("Couldn't pick out a name in that. Try again and say 'Hi, my name is …', or type it below.");
    await expect(sayHi(page)).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(await countGuestUsers()).toBe(before);
    // Only the prime was spoken; there was no welcome.
    expect(await spoken(page)).toEqual([{ text: "", volume: 0 }]);

    // Try again.
    const name = uniqueName();
    await sayHi(page).click();
    await hearFinal(page, `hey, I'm ${name}`);
    await expect(page).toHaveURL(/\/encounter$/);
    expect(await countGuestUsers()).toBe(before + 1);
  });

  test("silence and a denied microphone are explained, and the typed route is still there", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser);
    await sayHi(page).click();
    await failListening(page, "not-allowed");
    await expect(status(page)).toContainText(
      "SocialEyes can't use the microphone. Allow it for this site in your browser settings and try again, or type your name below.",
    );
    await expect(typedField(page)).toBeVisible();

    await sayHi(page).click();
    await failListening(page, "no-speech");
    await expect(status(page)).toContainText("Didn't hear anything.");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("recognition unsupported: no Say hi button, a note, and the typed route works", async ({ world, browser }) => {
    world.watchGuests();
    const page = await signedOutPage(world, browser, { speech: "unsupported" });
    await expect(entry(page).getByText("Voice entry isn’t available in this browser, so type your name below.")).toBeVisible();
    await expect(sayHi(page)).toHaveCount(0);
    await expect(entry(page).getByRole("button", { name: "Stop listening" })).toHaveCount(0);
    const name = uniqueName();
    await typedField(page).fill(name);
    await continueAsGuest(page).click();
    await expect(page).toHaveURL(/\/encounter$/);
    const me = (await (await page.request.get("/api/profile")).json()) as { displayName: string };
    expect(me.displayName).toBe(name);
  });

  test("the server saying 429 or 404 is shown plainly (route interception stands in for the server)", async ({ world, browser }) => {
    const page = await signedOutPage(world, browser, { speech: false });
    await page.route("**/api/guest", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }) }),
    );
    await typedField(page).fill("Hi, my name is Sam");
    await continueAsGuest(page).click();
    await expect(entry(page).getByText("Too many guest accounts from here just now. Wait a minute and try again, or create an account with an email.")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(typedField(page)).toHaveValue("Hi, my name is Sam");

    await page.unroute("**/api/guest");
    await page.route("**/api/guest", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "Not found" } }) }),
    );
    await continueAsGuest(page).click();
    await expect(page.getByText("Guest entry is switched off right now. Sign in or create an account with an email below.")).toBeVisible();
    await expect(entry(page)).toHaveCount(0);
    // The ordinary form is still there.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("?next=/v/<code> is honoured: the new guest ends up checked in at that venue", async ({ world, browser }) => {
    world.watchGuests();
    const host = await world.person();
    const venue = await world.venue(host, "E2E Guest Door");
    const page = await signedOutPage(world, browser, { speech: false, path: `/sign-in?next=${encodeURIComponent(`/v/${venue.code}`)}` });
    const name = uniqueName();
    await typedField(page).fill(`I'm ${name}`);
    await continueAsGuest(page).click();
    await expect(page.getByText("Checked in at E2E Guest Door", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/encounter$/);
    const state = (await (await page.request.get("/api/encounter")).json()) as { checkIn: { venueId: string } | null };
    expect(state.checkIn?.venueId).toBe(venue.id);
  });
});

// ---------------------------------------------------------------------------------------------

const GOOD_WINGMAN = {
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
const WINGMAN_LINE = "Yo, Nova and Remy both like hiking, so go ask which trail you would happily walk again.";

const modeSwitch = (page: Page) => page.getByRole("switch", { name: "Encounter mode" });
const voiceSwitch = (page: Page) => page.getByRole("switch", { name: "Wingman voice" });
const placeStatus = (page: Page) => page.getByRole("status", { name: "Place status" });
const interested = (page: Page) => page.getByRole("button", { name: "Interested", exact: true });
const moment = (page: Page) => page.getByRole("dialog", { name: /mutual/i });
const wingmanLine = (page: Page) => page.locator('figure[data-testid="wingman-line"]');

interface Phone {
  guest: Guest;
  context: BrowserContext;
  page: Page;
}

/** A guest with a small profile (a shared interest), on a phone-sized page at `at` with the speech fakes. */
async function guestPhone(world: World, browser: Browser, name: string, at: Spot): Promise<Phone> {
  const guest = await world.guest({ intro: `Hi, my name is ${name}` });
  must(await guest.api.putProfile(syntheticProfile(`g${Math.random().toString(36).slice(2, 6)}`, { displayName: name })));
  const context = await guest.browserContext(browser, {
    viewport: PHONE,
    permissions: ["geolocation"],
    geolocation: { latitude: at.lat, longitude: at.lng, accuracy: 5 },
  });
  await installSpeechFakes(context);
  const page = await context.newPage();
  await page.goto("/encounter");
  return { guest, context, page };
}

async function turnOn(page: Page): Promise<void> {
  await modeSwitch(page).click();
  await expect(modeSwitch(page)).toHaveAttribute("aria-checked", "true");
  await expect(placeStatus(page)).toContainText("Ready to signal");
}

/** Two guests 20 m apart, Encounter mode on and ready. */
async function readyGuests(world: World, browser: Browser) {
  const spot = freshSpot();
  const a = await guestPhone(world, browser, "Nova", spot);
  const b = await guestPhone(world, browser, "Remy", metresNorth(spot, 20));
  await turnOn(a.page);
  await turnOn(b.page);
  return { a, b };
}

/** A taps Interested, then B; both moments open. Returns the match id. */
async function matchThem(a: Phone, b: Phone): Promise<string> {
  await expect(interested(a.page)).toBeEnabled();
  await interested(a.page).click();
  await expect(a.page.getByText("Your signal is out", { exact: true })).toBeVisible();
  await interested(b.page).click();
  await expect(moment(a.page)).toBeVisible({ timeout: 10_000 });
  await expect(moment(b.page)).toBeVisible({ timeout: 10_000 });
  return must(await a.guest.api.listMatches()).matches[0].id;
}

test.describe("UI: the wingman's spoken line on a match", () => {
  test("two guests match by location: both phones show 'Your wingman' with the API's line, spoken exactly once; a reload does not speak it again", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const { a, b } = await readyGuests(world, browser);
    const matchId = await matchThem(a, b);

    for (const phone of [a, b]) {
      const block = wingmanLine(phone.page);
      await expect(block).toBeVisible();
      await expect(block.locator("figcaption")).toHaveText("Your wingman");
      await expect(block.locator("blockquote")).toHaveText(`“${WINGMAN_LINE}”`);
      const fromApi = must(await phone.guest.api.hype(matchId));
      expect(fromApi).toMatchObject({ matchId, text: WINGMAN_LINE, source: "model" });
      await expect.poll(() => spokenAloud(phone.page)).toEqual([{ text: WINGMAN_LINE, volume: 1 }]);
    }

    // Asked once per person: one request each reached the model, the rest came from the cache.
    expect((await fake.requests("hype")).length).toBe(2);
    await expectNoHorizontalScroll(a.page);

    // Reload: the tab has announced this match, so it asks for nothing and says nothing.
    let asked = 0;
    a.page.on("request", (req) => {
      if (/\/api\/matches\/[^/]+\/hype$/.test(req.url())) asked += 1;
    });
    await a.page.reload();
    await expect(modeSwitch(a.page)).toBeVisible();
    await a.page.waitForLoadState("networkidle");
    expect(asked, "no new wingman request after a reload").toBe(0);
    expect(await spokenAloud(a.page)).toEqual([{ text: WINGMAN_LINE, volume: 1 }]);
  });

  test("Wingman voice off: the block is still shown, nothing is spoken on that phone, and the setting survives a reload", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const { a, b } = await readyGuests(world, browser);

    await expect(voiceSwitch(a.page)).toHaveAttribute("aria-checked", "true"); // on by default
    await voiceSwitch(a.page).click();
    await expect(voiceSwitch(a.page)).toHaveAttribute("aria-checked", "false");
    expect(await a.page.evaluate(() => localStorage.getItem("socialeyes.wingman-voice"))).toBe("off");
    await a.page.reload();
    await expect(voiceSwitch(a.page)).toHaveAttribute("aria-checked", "false");
    // Encounter mode is stored on the server, so it is still on after the reload.
    await expect(placeStatus(a.page)).toContainText("Ready to signal");

    await matchThem(a, b);
    await expect(wingmanLine(a.page)).toBeVisible();
    await expect(wingmanLine(a.page).locator("blockquote")).toHaveText(`“${WINGMAN_LINE}”`);
    // B, with the voice on, speaks it; A does not. Wait for B so "nothing yet" is not just "too early".
    await expect.poll(() => spokenAloud(b.page)).toEqual([{ text: WINGMAN_LINE, volume: 1 }]);
    expect(await spokenAloud(a.page)).toEqual([]);

    // Back on: persisted the other way too.
    await a.page.getByRole("button", { name: "Not now" }).click();
    await voiceSwitch(a.page).click();
    await a.page.reload();
    await expect(voiceSwitch(a.page)).toHaveAttribute("aria-checked", "true");
    expect(await a.page.evaluate(() => localStorage.getItem("socialeyes.wingman-voice"))).toBe("on");
  });

  test("the wingman request failing (500): the match moment is fully usable, no block, nothing spoken", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const { a, b } = await readyGuests(world, browser);
    let failed = 0;
    await a.page.route("**/api/matches/*/hype", (route) => {
      failed += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "boom" } }) });
    });
    await matchThem(a, b);

    // B is unaffected, which also shows the match is real.
    await expect(wingmanLine(b.page)).toBeVisible();
    await expect.poll(() => failed, { message: "A's page did ask" }).toBeGreaterThan(0);
    await expect(wingmanLine(a.page)).toHaveCount(0);
    expect(await spokenAloud(a.page)).toEqual([]);
    await expect(moment(a.page)).toContainText("Remy");
    await expect(moment(a.page)).toContainText("It’s mutual.");
    await expectNoHorizontalScroll(a.page);

    // Still usable: open the card, and the match is there.
    await a.page.getByRole("button", { name: /See Remy/ }).click();
    await expect(a.page.getByRole("heading", { level: 1, name: "Remy" })).toBeVisible();
    expect(await spokenAloud(a.page)).toEqual([]);
  });

  test("a person whose Mentra glasses were just seen: the block is shown, the page does not speak it (the glasses do)", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const spot = freshSpot();
    const a = await guestPhone(world, browser, "Nova", spot);
    const b = await guestPhone(world, browser, "Remy", metresNorth(spot, 20));
    const glasses = await linkDevice(a.guest);
    world.onCleanup(() => glasses.ctx.dispose());
    // The glasses check in; the page then loads this status.
    must(await glasses.api.deviceMe());
    await a.page.reload();
    await turnOn(a.page);
    await turnOn(b.page);
    must(await glasses.api.deviceMe());

    await matchThem(a, b);
    await expect(wingmanLine(a.page)).toBeVisible();
    await expect(wingmanLine(a.page).locator("blockquote")).toHaveText(`“${WINGMAN_LINE}”`);
    await expect.poll(() => spokenAloud(b.page)).toEqual([{ text: WINGMAN_LINE, volume: 1 }]);
    expect(await spokenAloud(a.page), "the glasses' own app speaks it, not this page").toEqual([]);
  });

  test("'Hear it again' on the match screen says the shown line on each tap, also with Wingman voice off", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const { a, b } = await readyGuests(world, browser);
    await voiceSwitch(b.page).click(); // B: unprompted speech off
    await expect(voiceSwitch(b.page)).toHaveAttribute("aria-checked", "false");
    await matchThem(a, b);
    const line = { text: WINGMAN_LINE, volume: 1 };

    // A heard it once automatically; each tap says it again.
    await expect.poll(() => spokenAloud(a.page)).toEqual([line]);
    const again = wingmanLine(a.page).getByRole("button", { name: "Hear it again" });
    await again.click();
    await expect.poll(() => spokenAloud(a.page)).toEqual([line, line]);
    await again.click();
    await expect.poll(() => spokenAloud(a.page)).toEqual([line, line, line]);

    // B was silent, but a tap is a request and is spoken.
    await expect(wingmanLine(b.page)).toBeVisible();
    expect(await spokenAloud(b.page)).toEqual([]);
    await wingmanLine(b.page).getByRole("button", { name: "Hear it again" }).click();
    await expect.poll(() => spokenAloud(b.page)).toEqual([line]);

    // Tapping does not ask the server or the model for anything new.
    expect((await fake.requests("hype")).length).toBe(2);
    await expectNoHorizontalScroll(a.page);
  });

  test("the match page asks for the tip only on a tap, then shows and says it; a failure says so", async ({ world, browser, fake }) => {
    await fake.respondWith(GOOD_WINGMAN);
    await fake.hypeSays(WINGMAN_LINE);
    const { a, b } = await readyGuests(world, browser);
    await matchThem(a, b);
    const line = { text: WINGMAN_LINE, volume: 1 };
    await expect.poll(() => spokenAloud(a.page)).toEqual([line]);
    await expect(wingmanLine(b.page)).toBeVisible();
    const modelCalls = (await fake.requests("hype")).length;

    let asked = 0;
    a.page.on("request", (req) => {
      if (/\/api\/matches\/[^/]+\/hype$/.test(req.url())) asked += 1;
    });
    await a.page.getByRole("button", { name: /See Remy/ }).click();
    await expect(a.page.getByRole("heading", { level: 1, name: "Remy" })).toBeVisible();
    const tip = a.page.getByTestId("wingman-tip");
    await expect(tip).toContainText("Your wingman");
    await a.page.waitForLoadState("networkidle");
    expect(asked, "nothing is fetched until the person asks").toBe(0);
    await expect(wingmanLine(a.page)).toHaveCount(0);

    await tip.getByRole("button", { name: "Hear your wingman" }).click();
    await expect(wingmanLine(a.page).locator("blockquote")).toHaveText(`“${WINGMAN_LINE}”`);
    await expect.poll(() => spokenAloud(a.page)).toEqual([line, line]);
    expect(asked).toBe(1);
    await wingmanLine(a.page).getByRole("button", { name: "Hear it again" }).click();
    await expect.poll(() => spokenAloud(a.page)).toEqual([line, line, line]);
    expect(asked, "replaying does not ask again").toBe(1);
    expect((await fake.requests("hype")).length, "served from the cache, no new model call").toBe(modelCalls);
    await expectNoHorizontalScroll(a.page);

    // A reload goes back to asking only on a tap; a failing request is explained and says nothing.
    await a.page.route("**/api/matches/*/hype", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "boom" } }) }),
    );
    await a.page.reload();
    await expect(a.page.getByTestId("wingman-tip")).toBeVisible();
    await expect(wingmanLine(a.page)).toHaveCount(0);
    const before = (await spokenAloud(a.page)).length;
    await a.page.getByTestId("wingman-tip").getByRole("button", { name: "Hear your wingman" }).click();
    await expect(a.page.getByText("Couldn't get a tip right now. Try again in a moment.")).toBeVisible();
    expect((await spokenAloud(a.page)).length).toBe(before);
    await a.page.unroute("**/api/matches/*/hype");
    await a.page.getByTestId("wingman-tip").getByRole("button", { name: "Hear your wingman" }).click();
    await expect(wingmanLine(a.page).locator("blockquote")).toHaveText(`“${WINGMAN_LINE}”`);
  });
});

test.describe("UI: signing out", () => {
  test("a guest is asked first: Stay keeps them signed in, Sign out anyway ends the session and goes to sign-in", async ({ world, browser }) => {
    const guest = await world.guest({ intro: "Hi, my name is Sunny" });
    const context = await guest.browserContext(browser, { viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/profile");
    await expect(page.getByText("Signed in as a guest")).toBeVisible();

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out of this guest account?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("This is a guest account with no password. If you sign out you won't be able to get back into it.");
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/profile$/);
    expect((await page.request.get("/api/profile")).status()).toBe(200);

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("dialog", { name: "Sign out of this guest account?" }).getByRole("button", { name: "Sign out anyway" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get("/api/profile", { maxRedirects: 0 })).status(), "the session is gone").toBe(401);
    await page.goto("/encounter");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("a normal account signs out with no dialog", async ({ world, browser }) => {
    const person = await world.person();
    const context = await person.browserContext(browser, { viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/profile");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get("/api/profile", { maxRedirects: 0 })).status()).toBe(401);
  });
});
