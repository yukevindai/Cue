import type { z } from "zod";
import { GUEST_EMAIL_DOMAIN, type ProfileInput } from "@cue/contracts";
import type { APIRequestContext, Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { apiFor, interestEvent, must, type Api } from "./api";
import { addressedApi, freshAddress, signInActor, type Actor } from "./auth";
import { BASE_URL } from "./env";
import { freshSpot, locate, metresNorth, type Spot } from "./geo";
import { adminClient, createTestUser, deleteTestUser } from "./users";

export type ProfileOverrides = Partial<z.input<typeof ProfileInput>>;

/** A signed-in synthetic person with a typed API client. */
export interface Person extends Actor {
  api: Api;
  /** Unique, greppable display name (contains the user's random marker). */
  displayName: string;
  profile: z.input<typeof ProfileInput>;
}

/**
 * A guest account ("Hi, my name is Sam"): no password, no way to sign in again.
 * Its request context carries the session cookies the guest route set.
 */
export interface Guest {
  id: string;
  /** Read with the service role; a guest cannot see it and nobody else is ever sent it. */
  email: string;
  displayName: string;
  /** The client address (x-forwarded-for) this guest was created from. */
  address: string;
  ctx: APIRequestContext;
  api: Api;
  /** A new browser context signed in as this guest (copies the cookies). */
  browserContext(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext>;
}

/** A venue created through the API. */
export interface Venue {
  id: string;
  name: string;
  code: string;
}

/** Two people checked into one venue, encounter mode on (unless asked otherwise). */
export interface Pair {
  a: Person;
  b: Person;
  venue: Venue;
}

/** Two people with encounter mode on and phone locations a known distance apart. No venue. */
export interface NearbyPair {
  a: Person;
  b: Person;
  /** A's spot; B is `metres` north of it. */
  spot: Spot;
}

/** Synthetic profile text only. Overlaps with `OTHER_PROFILE` on hiking. */
export function syntheticProfile(marker: string, overrides: ProfileOverrides = {}): z.input<typeof ProfileInput> {
  return {
    displayName: `Test ${marker}`,
    photoUrl: null,
    bio: "Weekend hiker who likes pour-over coffee and board games.",
    interests: ["Hiking", "Coffee", "Board games"],
    sharing: { photo: true, bio: true, interests: true, aiAssist: true },
    ...overrides,
  };
}

/**
 * Creates and tracks synthetic users and venues; after the test it resets and
 * leaves for each person, removes the users and removes the venues it made.
 * Cleanup is best effort and reports, but does not fail, when the backend
 * cannot delete something.
 */
export class World {
  private people: Person[] = [];
  private guests: Guest[] = [];
  private venueIds: string[] = [];
  private disposables: Array<() => Promise<void>> = [];
  private sweepGuests = false;
  private guestIds = new Set<string>();
  private readonly startedAt = Date.now() - 10_000;

  /** A new user with a saved profile. */
  async person(overrides: ProfileOverrides = {}): Promise<Person> {
    const user = await createTestUser();
    const actor = await signInActor(user);
    const profile = syntheticProfile(user.marker, overrides);
    const person: Person = { ...actor, api: apiFor(actor.ctx), displayName: profile.displayName, profile };
    this.people.push(person);
    must(await person.api.putProfile(profile), "putProfile");
    return person;
  }

  /**
   * A new guest account made through POST /api/guest from its own client
   * address. Removed at cleanup, as is any other guest account created while
   * this World lives (also by a browser or a raw request, and also when the
   * test fails before it learns the id).
   */
  async guest(opts: { intro?: string; address?: string } = {}): Promise<Guest> {
    this.sweepGuests = true;
    const address = opts.address ?? freshAddress();
    const ctx = await addressedApi(address);
    this.disposables.push(() => ctx.dispose());
    const intro = opts.intro ?? `Hi, my name is Guest${Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, "x")}`;
    const created = await ctx.post("/api/guest", { data: { intro }, failOnStatusCode: false });
    if (created.status() !== 201) throw new Error(`createGuest failed: ${created.status()} ${await created.text()}`);
    return this.adoptGuest(ctx, address);
  }

  /** Turns a request context that already holds a guest's session cookies into a tracked `Guest`. */
  async adoptGuest(ctx: APIRequestContext, address: string): Promise<Guest> {
    this.sweepGuests = true;
    const api = apiFor(ctx);
    const profile = must(await api.getProfile(), "guest profile");
    const { data, error } = await adminClient().auth.admin.getUserById(profile.userId);
    if (error || !data.user?.email) throw new Error(`guest lookup failed: ${error?.message ?? "no email"}`);
    const guest: Guest = {
      id: profile.userId,
      email: data.user.email,
      displayName: profile.displayName,
      address,
      ctx,
      api,
      browserContext: async (browser, options) => {
        const bctx = await browser.newContext({ baseURL: BASE_URL, ...options, storageState: await ctx.storageState() });
        this.disposables.push(() => bctx.close());
        return bctx;
      },
    };
    this.guests.push(guest);
    this.guestIds.add(guest.id);
    return guest;
  }

  /**
   * Call in a test that makes guests some other way (the browser, a raw
   * request): every guest account created while this World lives is deleted
   * at cleanup.
   */
  watchGuests(): void {
    this.sweepGuests = true;
  }

  /** Registers something to close at cleanup (contexts a test opened itself). */
  onCleanup(fn: () => Promise<void>): void {
    this.disposables.push(fn);
  }

  /** `who` creates a venue (and is checked into it); it is removed at cleanup. */
  async venue(who: { api: Api }, name = `E2E Cafe ${Math.random().toString(36).slice(2, 7)}`): Promise<Venue> {
    const st = must(await who.api.createVenue(name), "createVenue");
    if (!st.checkIn) throw new Error("createVenue returned no check-in");
    this.venueIds.push(st.checkIn.venueId);
    return { id: st.checkIn.venueId, name: st.checkIn.name, code: st.checkIn.code };
  }

  /** Removes a venue created outside the helpers (for example through the UI) at cleanup. */
  trackVenue(venueId: string): void {
    this.venueIds.push(venueId);
  }

  /** Checks `who` into an existing venue. */
  async checkIn(who: { api: Api }, venue: Venue): Promise<void> {
    const st = must(await who.api.checkIn(venue.code), "checkIn");
    if (st.checkIn?.venueId !== venue.id) throw new Error("checked into a different venue");
  }

  /**
   * Two users with profiles. A creates a fresh venue, B checks in with its
   * code, and (by default) both turn encounter mode on. Neither has a phone
   * location.
   */
  async pair(
    opts: { a?: ProfileOverrides; b?: ProfileOverrides; encounterMode?: boolean; venue?: string } = {},
  ): Promise<Pair> {
    const a = await this.person(opts.a);
    const b = await this.person(opts.b);
    const venue = await this.venue(a, opts.venue);
    await this.checkIn(b, venue);
    if (opts.encounterMode ?? true) {
      must(await a.api.setMode(true), "A encounter mode on");
      must(await b.api.setMode(true), "B encounter mode on");
    }
    return { a, b, venue };
  }

  /**
   * Two users with profiles, encounter mode on, phone locations `metres`
   * apart (B north of A) at a fresh isolated spot, each with `accuracyM`.
   * No venue.
   */
  async nearbyPair(
    opts: { a?: ProfileOverrides; b?: ProfileOverrides; metres?: number; accuracyM?: number | [number, number]; spot?: Spot } = {},
  ): Promise<NearbyPair> {
    const a = await this.person(opts.a);
    const b = await this.person(opts.b);
    const spot = opts.spot ?? freshSpot();
    const [accA, accB] = Array.isArray(opts.accuracyM) ? opts.accuracyM : [opts.accuracyM ?? 5, opts.accuracyM ?? 5];
    must(await a.api.setMode(true), "A encounter mode on");
    must(await b.api.setMode(true), "B encounter mode on");
    await locate(a, spot, accA);
    await locate(b, metresNorth(spot, opts.metres ?? 10), accB);
    return { a, b, spot };
  }

  /**
   * Deletes the guests this World tracked plus every guest-domain account
   * created since it started (the suite is serial, so those are this test's).
   */
  private async deleteGuestAccounts(): Promise<void> {
    const ids = new Set(this.guestIds);
    try {
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await adminClient().auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(error.message);
        for (const u of data.users) {
          if (u.email?.endsWith(`@${GUEST_EMAIL_DOMAIN}`) && Date.parse(u.created_at) >= this.startedAt) ids.add(u.id);
        }
        if (data.users.length < 1000) break;
      }
    } catch (err) {
      console.warn(`[e2e cleanup] could not list guest accounts: ${(err as Error).message}`);
    }
    for (const id of ids) {
      const { error } = await adminClient().auth.admin.deleteUser(id);
      if (error && error.status !== 404) console.warn(`[e2e cleanup] could not delete guest ${id}: ${error.message}`);
    }
    this.guestIds.clear();
  }

  async cleanup(): Promise<void> {
    for (const g of this.guests.splice(0).reverse()) {
      try {
        await g.api.reset(true);
      } catch {
        /* best effort */
      }
    }
    for (const fn of this.disposables.splice(0).reverse()) await fn().catch(() => undefined);
    if (this.sweepGuests) await this.deleteGuestAccounts();
    for (const p of this.people.splice(0).reverse()) {
      try {
        await p.api.reset(true);
      } catch {
        /* best effort */
      }
      await p.dispose().catch(() => undefined);
      try {
        await deleteTestUser(p.user);
      } catch (err) {
        console.warn(`[e2e cleanup] ${(err as Error).message}`);
      }
    }
    const venues = this.venueIds.splice(0);
    if (venues.length) {
      const { error } = await adminClient().from("venues").delete().in("id", venues);
      if (error) console.warn(`[e2e cleanup] could not remove venues: ${error.message}`);
    }
  }
}

/**
 * Sends one signal for `who` (`web_demo` by default). The first argument is
 * ignored (kept so call sites read `signal(pair, who)`): a signal carries no
 * place, the server uses `who`'s own presence.
 */
export function signal(_pair: unknown, who: { api: Api }, opts: Parameters<typeof interestEvent>[0] = {}) {
  return who.api.interest(interestEvent(opts));
}

/** A -> B match in the common order, returning the ack of the completing signal. */
export async function matchPair(pair: Pick<Pair, "a" | "b">) {
  const first = must(await signal(pair, pair.a), "A signal");
  const second = must(await signal(pair, pair.b), "B signal");
  return { first, second };
}

/** A -> B -> match in the common order; returns the match id (as A sees it). */
export async function matchedPair(
  world: World,
  opts: Parameters<World["pair"]>[0] = {},
): Promise<{ pair: Pair; matchId: string }> {
  const pair = await world.pair(opts);
  must(await signal(pair, pair.a), "A signal");
  must(await signal(pair, pair.b), "B signal");
  const list = must(await pair.a.api.listMatches(), "A listMatches").matches;
  if (list.length !== 1) throw new Error(`expected exactly one match, got ${list.length}`);
  return { pair, matchId: list[0].id };
}
