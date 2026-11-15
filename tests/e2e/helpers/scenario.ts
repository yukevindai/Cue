import type { z } from "zod";
import type { ProfileInput } from "@cue/contracts";
import { apiFor, interestEvent, must, type Api } from "./api";
import { signInActor, type Actor } from "./auth";
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
  private venueIds: string[] = [];

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

  /** `who` creates a venue (and is checked into it); it is removed at cleanup. */
  async venue(who: Person, name = `E2E Cafe ${Math.random().toString(36).slice(2, 7)}`): Promise<Venue> {
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
  async checkIn(who: Person, venue: Venue): Promise<void> {
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

  async cleanup(): Promise<void> {
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
export function signal(_pair: unknown, who: Person, opts: Parameters<typeof interestEvent>[0] = {}) {
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
