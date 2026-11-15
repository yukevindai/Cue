import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import type { WingmanModelOutput } from "@cue/contracts";
import { must } from "./helpers/api";
import { expect, test } from "./helpers/fixtures";
import { adminClient } from "./helpers/users";
import { matchedPair, signal, type Person } from "./helpers/scenario";

/** A phone-sized window, like the people using Cue. */
const PHONE = { viewport: { width: 390, height: 844 } } as const;
const VENUE = "E2E Test Cafe";
/** A message typed on one phone must show on the other within this long, with no reload. */
const LIVE_BUDGET_MS = 3000;

async function openAs(browser: Browser, person: Person, path: string): Promise<Page> {
  const context = await person.browserContext(browser, PHONE);
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

const chatPath = (matchId: string) => `/matches/${matchId}/chat`;
const messageLog = (page: Page) => page.getByRole("log", { name: "Messages" });
const composer = (page: Page, name: string) => page.getByLabel(`Message ${name}`);
const sendButton = (page: Page) => page.getByRole("button", { name: "Send message" });
const willSee = (page: Page) => page.locator("p", { hasText: "They will see:" });
const wontSee = (page: Page) => page.locator("p", { hasText: "They won’t see:" });
const switchFor = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

async function pick(page: Page, label: string): Promise<void> {
  // The checkbox is visually hidden inside its chip; clicking it checks it.
  await page.getByRole("checkbox", { name: label, exact: true }).check({ force: true });
}

async function typeAndSend(page: Page, name: string, text: string): Promise<void> {
  await composer(page, name).fill(text);
  await sendButton(page).click();
}

test.describe("UI: profile editor", () => {
  test("picking cards makes the character appear; counts follow the picks", async ({ world, browser }) => {
    const p = await world.person();
    const page = await openAs(browser, p, "/profile");
    await expect(page.getByRole("heading", { name: "Basics" })).toBeVisible();
    for (const title of ["About you", "Personality cards", "Interests", "Private details", "What a match sees"]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }

    await expect(page.getByText("Pick a few cards and your character appears.")).toBeVisible();
    await expect(page.getByText("Your character", { exact: true })).toHaveCount(0);

    await pick(page, "Electronic");
    await pick(page, "Jazz");
    await expect(page.getByText("2 of 3")).toBeVisible();
    await pick(page, "Night owl");
    await expect(page.getByText("Pick a few cards and your character appears.")).toHaveCount(0);
    await expect(page.getByText("Your character", { exact: true })).toBeVisible();
    await expect(page.getByText("The Night Owl", { exact: true }).first()).toBeVisible();

    // Three from one deck is the limit: the rest of that deck is disabled.
    await pick(page, "Pop");
    await expect(page.getByText("3 of 3")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Rock", exact: true })).toBeDisabled();

    // Taking the picks away takes the character away.
    for (const label of ["Electronic", "Jazz", "Pop", "Night owl"]) {
      await page.getByRole("checkbox", { name: label, exact: true }).uncheck({ force: true });
    }
    await expect(page.getByText("Pick a few cards and your character appears.")).toBeVisible();
  });

  test("age 16 shows the under-18 message and is not stored", async ({ world, browser }) => {
    const p = await world.person();
    const page = await openAs(browser, p, "/profile");
    await page.getByLabel("Age", { exact: true }).fill("16");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("Cue is only for adults, 18 and over. Leave this empty if you'd rather not say."),
    ).toBeVisible();
    await expect(page.getByText(/Saved\./)).toHaveCount(0);
    expect(must(await p.api.getProfile()).age, "nothing was stored").toBeNull();

    // Empty is fine, and so is an adult age.
    await page.getByLabel("Age", { exact: true }).fill("18");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();
    expect(must(await p.api.getProfile()).age).toBe(18);
  });

  test('turning off "Show city" moves the city from "They will see:" to "They won’t see:"; save and reload keep everything', async ({
    world,
    browser,
  }) => {
    const p = await world.person();
    const page = await openAs(browser, p, "/profile");

    await page.getByLabel("Age", { exact: true }).fill("28");
    await page.getByLabel("City", { exact: true }).fill("Oakland");
    await pick(page, "Electronic");
    await pick(page, "Night owl");
    await page.getByRole("radio", { name: "INFP", exact: true }).check({ force: true });
    await page.getByLabel("Work or school", { exact: true }).fill("Nurse at a children's hospital");

    const preview = page.getByRole("article", { name: "Preview of what a match sees" });
    await expect(preview).toContainText("Oakland");
    await expect(willSee(page)).toContainText(/\bcity\b/);
    await expect(wontSee(page)).not.toContainText(/\bcity\b/);

    await switchFor(page, "Show city").click();
    await expect(switchFor(page, "Show city")).toHaveAttribute("aria-checked", "false");
    await expect(willSee(page)).not.toContainText(/\bcity\b/);
    await expect(wontSee(page)).toContainText(/\bcity\b/);
    await expect(preview).not.toContainText("Oakland");

    // Work stays hidden by default; share it.
    await expect(preview).not.toContainText("Nurse at a children's hospital");
    await switchFor(page, "Show work or school").click();
    await expect(preview).toContainText("Nurse at a children's hospital");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();

    const stored = must(await p.api.getProfile());
    expect(stored).toMatchObject({ age: 28, location: "Oakland", mbti: "INFP", workOrSchool: "Nurse at a children's hospital" });
    expect(stored.sharing).toMatchObject({ location: false, workOrSchool: true });
    expect(stored.cards).toEqual(expect.arrayContaining(["music.electronic", "energy.night-owl"]));

    await page.reload();
    await expect(page.getByLabel("Age", { exact: true })).toHaveValue("28");
    await expect(page.getByLabel("City", { exact: true })).toHaveValue("Oakland");
    await expect(page.getByLabel("Work or school", { exact: true })).toHaveValue("Nurse at a children's hospital");
    await expect(page.getByRole("radio", { name: "INFP", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Electronic", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Night owl", exact: true })).toBeChecked();
    await expect(page.getByText("Your character", { exact: true })).toBeVisible();
    await expect(switchFor(page, "Show city")).toHaveAttribute("aria-checked", "false");
    await expect(switchFor(page, "Show work or school")).toHaveAttribute("aria-checked", "true");
    await expect(wontSee(page)).toContainText(/\bcity\b/);
    await expect(page.getByRole("article", { name: "Preview of what a match sees" })).not.toContainText("Oakland");
  });

  test("sensitive details are hidden by default and have their own switches", async ({ world, browser }) => {
    const p = await world.person();
    const page = await openAs(browser, p, "/profile");
    for (const name of [
      "Show my ethnicity to a match",
      "Show drinking to a match",
      "Show smoking to a match",
      "Show drug use to a match",
    ]) {
      await expect(switchFor(page, name)).toHaveAttribute("aria-checked", "false");
    }
    await page.getByLabel("Ethnicity", { exact: true }).fill("ETHNICITY-UI-MARKER");
    await expect(page.getByRole("article", { name: "Preview of what a match sees" })).not.toContainText("ETHNICITY-UI-MARKER");
    await expect(wontSee(page)).toContainText("ethnicity");
    await switchFor(page, "Show my ethnicity to a match").click();
    await expect(page.getByRole("article", { name: "Preview of what a match sees" })).toContainText("ETHNICITY-UI-MARKER");
  });
});

test.describe("UI: privacy through the UI", () => {
  test("A hides a field and shares another; after matching B sees only the shared one", async ({ world, browser }) => {
    const pair = await world.pair({
      venue: VENUE,
      a: {
        location: "Hiddenville",
        workOrSchool: "Sharedwork Inc",
        education: "masters",
        ethnicity: "ETHNICITY-HIDDEN",
        sharing: {},
      },
    });

    // A, in the browser: hide the city (on by default), share work (off by default).
    const aPage = await openAs(browser, pair.a, "/profile");
    await expect(switchFor(aPage, "Show city")).toHaveAttribute("aria-checked", "true");
    await expect(switchFor(aPage, "Show work or school")).toHaveAttribute("aria-checked", "false");
    await switchFor(aPage, "Show city").click();
    await switchFor(aPage, "Show work or school").click();
    await aPage.getByRole("button", { name: "Save changes" }).click();
    await expect(aPage.getByText(/Saved\./)).toBeVisible();

    // They match.
    must(await signal(pair, pair.a));
    expect(must(await signal(pair, pair.b)).matched).toBe(true);
    const id = must(await pair.b.api.listMatches()).matches[0].id;

    const bPage = await openAs(browser, pair.b, `/matches/${id}`);
    await expect(bPage.getByRole("heading", { level: 1, name: pair.a.displayName })).toBeVisible();
    await expect(bPage.getByText("Sharedwork Inc")).toBeVisible();
    for (const hidden of ["Hiddenville", "ETHNICITY-HIDDEN", "Master's degree"]) {
      await expect(bPage.getByText(hidden)).toHaveCount(0);
      expect(await bPage.content(), `page html must not contain ${hidden}`).not.toContain(hidden);
    }
    // The list card hides it too.
    await bPage.goto("/matches");
    const card = bPage.getByRole("link", { name: new RegExp(pair.a.displayName) });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText("Hiddenville");

    // A turns the city back on; B sees it on the next load.
    await switchFor(aPage, "Show city").click();
    await aPage.getByRole("button", { name: "Save changes" }).click();
    await expect(aPage.getByText(/Saved\./)).toBeVisible();
    await bPage.goto(`/matches/${id}`);
    await expect(bPage.getByText("Hiddenville")).toBeVisible();
    await expect(bPage.getByText("ETHNICITY-HIDDEN")).toHaveCount(0);
  });
});

test.describe("UI: the match moment", () => {
  test("shows It's mutual and the Chinese line on both phones", async ({ world, browser }) => {
    const pair = await world.pair({ venue: VENUE });
    const a = await openAs(browser, pair.a, "/encounter");
    const b = await openAs(browser, pair.b, "/encounter");
    const interested = (page: Page) => page.getByRole("button", { name: "Interested", exact: true });
    await expect(interested(a)).toBeEnabled();
    await expect(interested(b)).toBeEnabled();
    await interested(a).click();
    await interested(b).click();

    for (const page of [a, b]) {
      const moment = page.getByRole("dialog", { name: /mutual/i });
      await expect(moment).toBeVisible();
      // The apostrophe in the product copy is typographic (U+2019).
      await expect(moment.getByRole("heading", { name: /It.s mutual\./ })).toBeVisible();
      await expect(moment.getByText("在茫茫人海中，你我一见钟情")).toBeVisible();
      await expect(moment.getByText("In a sea of people, you noticed each other.")).toBeVisible();
    }
  });
});

test.describe("UI: chat", () => {
  test("message from the match page; arrives live on the other phone; the reply comes back; markup stays literal", async ({
    world,
    browser,
  }) => {
    const { pair, matchId } = await matchedPair(world, { venue: VENUE });
    const aName = pair.a.displayName;
    const bName = pair.b.displayName;
    const a = await openAs(browser, pair.a, `/matches/${matchId}`);
    const b = await openAs(browser, pair.b, chatPath(matchId));

    // A: match page -> "Message {name}" -> chat.
    await a.getByRole("link", { name: new RegExp(`^Message ${bName}`) }).click();
    await expect(a).toHaveURL(new RegExp(`/matches/${matchId}/chat$`));
    await expect(
      a.getByText("You're talking inside Cue. Your phone number and socials stay private unless you choose to share them."),
    ).toBeVisible();
    await expect(composer(a, bName)).toHaveAttribute("placeholder", `Write to ${bName}`);
    await expect(composer(b, aName)).toBeVisible();
    await expect(sendButton(a)).toBeDisabled();

    // A -> B, live.
    await typeAndSend(a, bName, "Hi, I think we both noticed each other");
    await expect(messageLog(a)).toContainText("Hi, I think we both noticed each other");
    await expect(messageLog(b)).toContainText("Hi, I think we both noticed each other", { timeout: LIVE_BUDGET_MS });
    await expect(composer(a, bName)).toHaveValue("");

    // B -> A, live.
    await typeAndSend(b, aName, "Yes! The queue was long.");
    await expect(messageLog(a)).toContainText("Yes! The queue was long.", { timeout: LIVE_BUDGET_MS });

    // Order on both phones, and nothing stored twice.
    for (const page of [a, b]) {
      await expect(messageLog(page).getByRole("listitem").filter({ hasText: /Hi, I think|The queue was long/ })).toHaveCount(2);
    }
    expect((await pair.a.api.listMessages(matchId)).data?.messages.map((m) => m.body)).toEqual([
      "Hi, I think we both noticed each other",
      "Yes! The queue was long.",
    ]);

    // Markup and links are literal text.
    const markup = "<b>bold</b> https://example.com";
    await typeAndSend(a, bName, markup);
    for (const page of [a, b]) {
      const log = messageLog(page);
      await expect(log).toContainText(markup, { timeout: LIVE_BUDGET_MS });
      await expect(log.locator("a")).toHaveCount(0);
      await expect(log.locator("b")).toHaveCount(0);
      await expect(log.locator("strong")).toHaveCount(0);
    }
    // And it survives a reload as text, too.
    await b.reload();
    await expect(messageLog(b)).toContainText(markup);
    await expect(messageLog(b).locator("a, b")).toHaveCount(0);
  });

  test('"1 new message" shows on the other person\'s match card and clears once they open the chat', async ({ world, browser }) => {
    const { pair, matchId } = await matchedPair(world, { venue: VENUE });
    const aName = pair.a.displayName;
    const bName = pair.b.displayName;
    const a = await openAs(browser, pair.a, chatPath(matchId));
    const b = await openAs(browser, pair.b, "/matches");
    const card = b.getByRole("link", { name: new RegExp(aName) });
    await expect(card).toBeVisible();
    await expect(b.getByText(/\bnew message\b/)).toHaveCount(0);

    await typeAndSend(a, bName, "Are you still at the cafe?");
    // No reload: realtime updates the list.
    await expect(b.getByText("1 new message")).toBeVisible({ timeout: 8000 });
    await expect(card).toHaveAccessibleName(/1 unread message/);
    // The tab keeps its name.
    await expect(b.getByRole("link", { name: "Matches", exact: true }).first()).toBeVisible();

    // Open the chat from the card: card -> match page -> Message.
    await card.click();
    await b.getByRole("link", { name: new RegExp(`^Message ${aName}`) }).click();
    await expect(messageLog(b)).toContainText("Are you still at the cafe?");

    await b.goto("/matches");
    await expect(b.getByRole("link", { name: new RegExp(aName) })).toBeVisible();
    await expect(b.getByText(/\bnew message\b/)).toHaveCount(0);
    // The sender never sees their own message as unread.
    await a.goto("/matches");
    await expect(a.getByRole("link", { name: new RegExp(bName) })).toBeVisible();
    await expect(a.getByText(/\bnew message\b/)).toHaveCount(0);
  });

  test("unmatching while the other person has the chat open switches their page to 'no longer available'", async ({ world, browser }) => {
    const { pair, matchId } = await matchedPair(world, { venue: VENUE });
    const bName = pair.b.displayName;
    const a = await openAs(browser, pair.a, chatPath(matchId));
    const b = await openAs(browser, pair.b, chatPath(matchId));
    await typeAndSend(a, bName, "before unmatching");
    await expect(messageLog(b)).toContainText("before unmatching", { timeout: LIVE_BUDGET_MS });

    expect((await pair.a.api.unmatch(matchId)).status).toBe(204);
    await expect(b.getByText("This match is no longer available")).toBeVisible();
    await expect(composer(b, pair.a.displayName)).toHaveCount(0);
    await expect(b.getByText("before unmatching")).toHaveCount(0);
    // A's own page too.
    await a.reload();
    await expect(a.getByText("This match is no longer available")).toBeVisible();
  });

  test("a message that fails to send says so and can be retried", async ({ world, browser }) => {
    const { pair, matchId } = await matchedPair(world, { venue: VENUE });
    const bName = pair.b.displayName;
    const a = await openAs(browser, pair.a, chatPath(matchId));
    await expect(composer(a, bName)).toBeEnabled();

    await a.route(`**/api/matches/${matchId}/messages`, (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.continue(),
    );
    await typeAndSend(a, bName, "will fail once");
    await expect(a.getByText(/Not sent\./)).toBeVisible();
    expect(must(await pair.b.api.listMessages(matchId)).messages).toEqual([]);

    await a.unroute(`**/api/matches/${matchId}/messages`);
    await a.getByRole("button", { name: "Try again" }).click();
    await expect(a.getByText(/Not sent\./)).toHaveCount(0);
    await expect(messageLog(a)).toContainText("will fail once");
    expect(must(await pair.b.api.listMessages(matchId)).messages.map((m) => m.body)).toEqual(["will fail once"]);
  });

  test("older messages load on demand ('Load earlier')", async ({ world, browser }) => {
    const { pair, matchId } = await matchedPair(world, { venue: VENUE });
    const base = Date.now() - 3_600_000;
    const rows = Array.from({ length: 55 }, (_, i) => ({
      match_id: matchId,
      sender_id: i % 2 ? pair.a.user.id : pair.b.user.id,
      client_id: randomUUID(),
      body: `old-${String(i).padStart(2, "0")}`,
      created_at: new Date(base + i * 1000).toISOString(),
    }));
    const { error } = await adminClient().from("chat_messages").insert(rows);
    expect(error).toBeNull();

    const page = await openAs(browser, pair.a, chatPath(matchId));
    await expect(messageLog(page)).toContainText("old-54");
    await expect(messageLog(page)).not.toContainText("old-00");
    await page.getByRole("button", { name: "Load earlier" }).click();
    await expect(messageLog(page)).toContainText("old-00");
    await expect(page.getByRole("button", { name: "Load earlier" })).toHaveCount(0);
  });
});

test.describe("UI: opener from common ground", () => {
  const OPENER = "What's a trail you would happily walk again?";
  const OUTPUT: WingmanModelOutput = {
    shared_interests: [
      {
        label: "Hiking",
        summary: "You both enjoy hiking.",
        your_evidence: { field: "interests", quote: "Hiking" },
        their_evidence: { field: "interests", quote: "Hiking" },
      },
    ],
    suggested_question: OPENER,
    opener_basis: "shared_interest",
  };

  test('"Use this opener" lands on the chat with the question in the composer and sends nothing', async ({ world, browser, fake }) => {
    const { pair, matchId } = await matchedPair(world, {
      venue: VENUE,
      a: { interests: ["Hiking", "Coffee"] },
      b: { interests: ["Hiking", "Jazz"] },
    });
    await fake.respondWith(OUTPUT);
    const bName = pair.b.displayName;
    const page = await openAs(browser, pair.a, `/matches/${matchId}`);

    await page.getByRole("button", { name: "Find common ground" }).click();
    await expect(page.getByText(OPENER).first()).toBeVisible();
    await page.getByRole("button", { name: "Use this opener" }).click();

    await expect(page).toHaveURL(new RegExp(`/matches/${matchId}/chat$`));
    await expect(composer(page, bName)).toHaveValue(new RegExp(OPENER.replace(/[?']/g, ".")));
    await expect(
      page.getByText("Suggested opener added. Edit it as you like; it is only sent when you press Send."),
    ).toBeVisible();
    // Give any (wrong) automatic send time to happen, then check nothing was sent.
    await page.waitForTimeout(1500);
    expect(must(await pair.a.api.listMessages(matchId)).messages, "nothing sent").toEqual([]);
    expect(must(await pair.b.api.listMessages(matchId)).messages).toEqual([]);
    await expect(messageLog(page).getByRole("listitem")).toHaveCount(0);

    // Pressing Send is what sends it.
    await sendButton(page).click();
    await expect(messageLog(page)).toContainText("trail you would happily walk again");
    expect(must(await pair.b.api.listMessages(matchId)).messages).toHaveLength(1);
  });
});
