import type { z } from "zod";
import type { DemoSession, ProfileInput } from "@cue/contracts";
import { apiFor, interestEvent, must, type Api } from "./api";
import { signInActor, type Actor } from "./auth";
import { createTestUser, deleteTestUser } from "./users";

export type ProfileOverrides = Partial<z.input<typeof ProfileInput>>;

/** A signed-in synthetic person with a typed API client. */
export interface Person extends Actor {
  api: Api;
  /** Unique, greppable display name (contains the user's random marker). */
  displayName: string;
  profile: z.input<typeof ProfileInput>;
}

export interface Pair {
  a: Person;
  b: Person;
  session: DemoSession;
}

/** Synthetic profile text only. Overlaps with `OTHER_PROFILE` on hiking. */
export function syntheticProfile(marker: string, overrides: ProfileOverrides = {}): z.input<typeof ProfileInput> {
  return {
    displayName: `Test ${marker}`,
    photoUrl: null,
    bio: "Weekend hiker who likes pour-over coffee and board games.",
    interests: ["Hiking", "Coffee", "Board games"],
    socialLinks: [{ label: "Site", url: `https://example.com/${marker}` }],
    sharing: { photo: true, bio: true, interests: true, socialLinks: true, aiAssist: true },
    ...overrides,
  };
}

/**
 * Creates and tracks synthetic users; removes them (and leaves any demo
 * session) after the test. Cleanup is best effort and reports, but does not
 * fail, when the backend cannot delete a user.
 */
export class World {
  private people: Person[] = [];

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
   * Two users with profiles. A creates a demo session, B joins with the join
   * code, and (by default) both turn encounter mode on.
   */
  async pair(
    opts: { a?: ProfileOverrides; b?: ProfileOverrides; encounterMode?: boolean; venue?: string } = {},
  ): Promise<Pair> {
    const a = await this.person(opts.a);
    const b = await this.person(opts.b);
    const created = must(await a.api.createSession(opts.venue ?? "E2E Test Cafe"), "createSession");
    if (!created.session) throw new Error("createSession returned no session");
    const joined = must(await b.api.joinSession(created.session.joinCode), "joinSession");
    if (joined.session?.id !== created.session.id) throw new Error("B joined a different session");
    if (opts.encounterMode ?? true) {
      must(await a.api.setMode(true), "A encounter mode on");
      must(await b.api.setMode(true), "B encounter mode on");
    }
    return { a, b, session: created.session };
  }

  async cleanup(): Promise<void> {
    for (const p of this.people.splice(0).reverse()) {
      try {
        await p.api.reset(true);
      } catch {
        /* user may already be out of a session */
      }
      await p.dispose().catch(() => undefined);
      try {
        await deleteTestUser(p.user);
      } catch (err) {
        console.warn(`[e2e cleanup] ${(err as Error).message}`);
      }
    }
  }
}

/** Sends one web (`web_demo`/`web_confirm`) signal for `who` in the pair's session. */
export function signal(
  pair: Pick<Pair, "session">,
  who: Person,
  opts: { source?: "web_demo" | "mentra_touch"; eventId?: string } = {},
) {
  return who.api.interest(interestEvent(pair.session.id, opts));
}

/** A -> B match in the common order, returning the ack of the completing signal. */
export async function matchPair(pair: Pair) {
  const first = must(await signal(pair, pair.a), "A signal");
  const second = must(await signal(pair, pair.b), "B signal");
  return { first, second };
}
