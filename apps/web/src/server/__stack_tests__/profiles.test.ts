/**
 * Rich profiles and per-field sharing, against the running web server and the
 * real local stack: what a match sees through GET /api/matches is exactly what
 * the owner shares, sensitive fields default to hidden, the character is
 * derived by the server, and external social links are returned to nobody.
 */
import { randomUUID } from "node:crypto";
import {
  ApiError,
  computeArchetype,
  MatchCard,
  MatchList,
  OwnProfile,
  PERSONALITY_CARDS,
  ProfileInput,
  routes,
  SharingSettings,
  type SharedProfile,
} from "@cue/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  admin,
  api,
  cleanupUsers,
  cookieFor,
  must,
  newPair,
  reportSkips,
  signal,
  stackUp,
  webUp,
  type Reply,
} from "./helpers";

reportSkips("profiles.test.ts", true);
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function ok<S extends { parse(x: unknown): unknown }>(res: Reply, schema: S, status = 200) {
  expect(res.status, res.text).toBe(status);
  return schema.parse(res.json) as ReturnType<S["parse"]>;
}

function err(res: Reply, status: number, code?: string) {
  expect(res.status, res.text).toBe(status);
  const parsed = ApiError.parse(res.json);
  if (code) expect(parsed.error.code).toBe(code);
  return parsed;
}

type ProfileBody = z.input<typeof ProfileInput>;
type Toggle = keyof SharingSettings;

const ALL_ON: SharingSettings = {
  photo: true,
  bio: true,
  interests: true,
  age: true,
  gender: true,
  location: true,
  lookingFor: true,
  mbti: true,
  cards: true,
  workOrSchool: true,
  education: true,
  ethnicity: true,
  drinking: true,
  smoking: true,
  drugs: true,
  aiAssist: true,
};
const ALL_OFF = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as SharingSettings;

const CARDS = ["music.indie", "weekend.trails", "weekend.cafes", "energy.night-owl", "loves.dogs"];

/** Every field filled (synthetic values). */
const fullProfile = (sharing: Partial<SharingSettings>): ProfileBody => ({
  displayName: "Full Tester",
  photoUrl: "https://example.com/full.png",
  bio: "Synthetic bio",
  interests: ["kayaking", "chess"],
  age: 31,
  gender: "other",
  genderSelfDescribed: "Synthetic words",
  location: "Testville",
  lookingFor: "long_term",
  workOrSchool: "Example Labs",
  education: "masters",
  mbti: "ENTP",
  ethnicity: "Synthetic ethnicity",
  drinking: "sometimes",
  smoking: "never",
  drugs: "prefer_not_to_say",
  cards: CARDS,
  sharing,
});

/** SharedProfile key -> the sharing toggle that controls it (null = always shown). */
const CONTROLLED_BY: Record<keyof SharedProfile, Toggle | null> = {
  userId: null,
  displayName: null,
  photoUrl: "photo",
  bio: "bio",
  interests: "interests",
  age: "age",
  gender: "gender",
  genderSelfDescribed: "gender",
  location: "location",
  lookingFor: "lookingFor",
  workOrSchool: "workOrSchool",
  education: "education",
  mbti: "mbti",
  ethnicity: "ethnicity",
  drinking: "drinking",
  smoking: "smoking",
  drugs: "drugs",
  cards: "cards",
  archetype: "cards",
};

const SENSITIVE: Toggle[] = ["ethnicity", "drinking", "smoking", "drugs"];
const SOCIAL_MARKER = `https://social.example.com/${randomUUID()}`;

describe.skipIf(!stackUp || !webUp)("profiles and sharing (real web server + real stack)", () => {
  afterAll(cleanupUsers);

  let ca: string;
  let cb: string;
  let aId: string;
  let matchId: string;

  /** A saves `body`; returns A's own profile and what B sees of A through GET /api/matches and GET /api/matches/[id]. */
  async function saveAndView(body: ProfileBody): Promise<{ own: OwnProfile; seen: SharedProfile }> {
    const own = ok(await api("PUT", routes.profile, { cookie: ca }, body), OwnProfile);
    const list = ok(await api("GET", routes.matches, { cookie: cb }), MatchList).matches;
    const fromList = list.find((c) => c.id === matchId);
    expect(fromList).toBeDefined();
    const single = ok(await api("GET", routes.match(matchId), { cookie: cb }), MatchCard);
    expect(single.other).toEqual(fromList!.other);
    return { own, seen: fromList!.other };
  }

  beforeAll(async () => {
    const p = await newPair();
    await signal(p.a);
    const ack = await signal(p.b);
    expect(ack.matched).toBe(true);
    matchId = ack.match_id!;
    aId = p.a.id;
    [ca, cb] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
  });

  it("with every toggle on, B sees exactly A's own values; with every toggle off, only the name", async () => {
    const on = await saveAndView(fullProfile(ALL_ON));
    expect(on.own.archetype).not.toBeNull();
    for (const key of Object.keys(CONTROLLED_BY) as (keyof SharedProfile)[]) {
      expect(on.seen[key], key).toEqual(on.own[key]);
    }

    const off = await saveAndView(fullProfile(ALL_OFF));
    expect(off.seen).toEqual({
      userId: aId,
      displayName: "Full Tester",
      photoUrl: null,
      bio: null,
      interests: [],
      age: null,
      gender: null,
      genderSelfDescribed: null,
      location: null,
      lookingFor: null,
      workOrSchool: null,
      education: null,
      mbti: null,
      ethnicity: null,
      drinking: null,
      smoking: null,
      drugs: null,
      cards: [],
      archetype: null,
    });
    const text = JSON.stringify(off.seen);
    for (const secret of ["Synthetic bio", "Testville", "Example Labs", "Synthetic ethnicity", "Synthetic words", "ENTP", "music.indie"]) {
      expect(text).not.toContain(secret);
    }
  });

  const toggles = (Object.keys(ALL_ON) as Toggle[]).filter((t) => t !== "aiAssist");
  it.each(toggles)("toggle %s alone reveals only the fields it controls", async (toggle) => {
    const { own, seen } = await saveAndView(fullProfile({ ...ALL_OFF, [toggle]: true }));
    for (const [key, by] of Object.entries(CONTROLLED_BY) as [keyof SharedProfile, Toggle | null][]) {
      if (by === null || by === toggle) {
        expect(seen[key], `${key} should be shared`).toEqual(own[key]);
        expect(seen[key], `${key} should be filled`).not.toEqual(Array.isArray(own[key]) ? [] : null);
      } else {
        expect(seen[key], `${key} should be hidden`).toEqual(Array.isArray(own[key]) ? [] : null);
      }
    }
  });

  it("a brand-new profile hides sensitive fields, work/school and education by default", async () => {
    const p = await newPair();
    await admin.from("profiles").delete().eq("user_id", p.a.id);
    await signal(p.a);
    const ack = await signal(p.b);
    const [cookieA, cookieB] = await Promise.all([cookieFor(p.a), cookieFor(p.b)]);
    // Sharing object given empty: every key takes its contract default.
    const own = ok(await api("PUT", routes.profile, { cookie: cookieA }, fullProfile({})), OwnProfile);
    for (const t of [...SENSITIVE, "workOrSchool", "education"] as Toggle[]) expect(own.sharing[t], t).toBe(false);
    for (const t of ["photo", "bio", "interests", "age", "gender", "location", "lookingFor", "mbti", "cards", "aiAssist"] as Toggle[]) {
      expect(own.sharing[t], t).toBe(true);
    }
    expect(own.ethnicity).toBe("Synthetic ethnicity"); // stored for the owner...
    const seen = ok(await api("GET", routes.match(ack.match_id!), { cookie: cookieB }), MatchCard).other;
    expect(seen).toMatchObject({ ethnicity: null, drinking: null, smoking: null, drugs: null, workOrSchool: null, education: null });
    expect(seen.location).toBe("Testville"); // ...while defaults-on fields are shared

    // A row created without any sharing JSON (DB default) behaves the same.
    const row = must(await admin.from("profiles").select("sharing").eq("user_id", p.b.id).single()) as { sharing: unknown };
    const dbDefault = SharingSettings.parse(row.sharing);
    for (const t of [...SENSITIVE, "workOrSchool", "education"] as Toggle[]) expect(dbDefault[t], t).toBe(false);
  });

  it("an old sharing row (socialLinks key, no new keys) parses with safe defaults", async () => {
    ok(await api("PUT", routes.profile, { cookie: ca }, fullProfile(ALL_ON)), OwnProfile);
    must(
      await admin
        .from("profiles")
        .update({ sharing: { photo: true, bio: true, interests: true, socialLinks: true, aiAssist: true } })
        .eq("user_id", aId),
    );
    const own = ok(await api("GET", routes.profile, { cookie: ca }), OwnProfile);
    expect(own.sharing).toEqual(SharingSettings.parse({}));
    expect(own.sharing).not.toHaveProperty("socialLinks");
    const seen = ok(await api("GET", routes.match(matchId), { cookie: cb }), MatchCard).other;
    expect(seen).toMatchObject({ ethnicity: null, drinking: null, workOrSchool: null, location: "Testville" });
  });

  it("the character is computed by the server; one sent by the client is ignored", async () => {
    const body = { ...fullProfile(ALL_ON), archetype: "guardian" };
    const own = ok(await api("PUT", routes.profile, { cookie: ca }, body), OwnProfile);
    const expected = computeArchetype(CARDS, "ENTP");
    expect(expected).not.toBe("guardian");
    expect(own.archetype).toBe(expected);
    const stored = must(await admin.from("profiles").select("archetype").eq("user_id", aId).single()) as { archetype: string };
    expect(stored.archetype).toBe(expected);

    // MBTI only nudges; no cards means no character.
    const none = ok(await api("PUT", routes.profile, { cookie: ca }, { ...fullProfile(ALL_ON), cards: [], archetype: "sage" }), OwnProfile);
    expect(none.archetype).toBeNull();
    expect(ok(await api("GET", routes.match(matchId), { cookie: cb }), MatchCard).other.archetype).toBeNull();
  });

  it("rejects under-18 ages, unknown cards, duplicates, and more than 3 cards from one deck", async () => {
    const before = ok(await api("GET", routes.profile, { cookie: ca }), OwnProfile);
    const musicCards = PERSONALITY_CARDS.filter((c) => c.deck === "music").slice(0, 4).map((c) => c.id);
    const bad: ProfileBody[] = [
      { ...fullProfile(ALL_ON), age: 17 },
      { ...fullProfile(ALL_ON), age: 100 },
      { ...fullProfile(ALL_ON), cards: ["music.not-a-card"] },
      { ...fullProfile(ALL_ON), cards: ["music.indie", "music.indie"] },
      { ...fullProfile(ALL_ON), cards: musicCards },
      { ...fullProfile(ALL_ON), mbti: "XXXX" as never },
      { ...fullProfile(ALL_ON), drinking: "daily" as never },
    ];
    for (const body of bad) err(await api("PUT", routes.profile, { cookie: ca }, body), 400, "invalid_request");
    expect(ok(await api("GET", routes.profile, { cookie: ca }), OwnProfile)).toEqual(before);
    // Three from one deck is fine.
    ok(await api("PUT", routes.profile, { cookie: ca }, { ...fullProfile(ALL_ON), cards: musicCards.slice(0, 3) }), OwnProfile);
  });

  it("social links are returned to nobody, even if the legacy column holds some", async () => {
    ok(await api("PUT", routes.profile, { cookie: ca }, { ...fullProfile(ALL_ON), socialLinks: [{ label: "x", url: SOCIAL_MARKER }] }), OwnProfile);
    must(await admin.from("profiles").update({ social_links: [{ label: "legacy", url: SOCIAL_MARKER }] }).eq("user_id", aId));
    const responses = [
      await api("GET", routes.profile, { cookie: ca }),
      await api("PUT", routes.profile, { cookie: ca }, fullProfile(ALL_ON)),
      await api("GET", routes.matches, { cookie: cb }),
      await api("GET", routes.match(matchId), { cookie: cb }),
      await api("GET", routes.matches, { cookie: ca }),
    ];
    for (const res of responses) {
      expect(res.status, res.text).toBe(200);
      expect(res.text).not.toContain(SOCIAL_MARKER);
      expect(res.text).not.toMatch(/social/i);
    }
  });
});

describe.skipIf(!stackUp)("seeded demo accounts (real stack)", () => {
  const SEED = {
    alex: "00000000-0000-4000-8000-00000000a1e0",
    sam: "00000000-0000-4000-8000-0000000005a0",
    riley: "00000000-0000-4000-8000-000000000b1e",
  };

  interface SeedRow {
    user_id: string;
    cards: string[];
    mbti: string | null;
    archetype: string | null;
    location: string | null;
    ethnicity: string | null;
    drinking: string | null;
    smoking: string | null;
    drugs: string | null;
    social_links: unknown;
    sharing: Record<string, unknown>;
  }

  async function seedRows(): Promise<Map<string, SeedRow>> {
    const rows = must(
      await admin
        .from("profiles")
        .select("user_id, cards, mbti, archetype, location, ethnicity, drinking, smoking, drugs, social_links, sharing")
        .in("user_id", Object.values(SEED)),
    ) as SeedRow[];
    return new Map(rows.map((r) => [r.user_id, r]));
  }

  it("stored archetypes equal computeArchetype(cards, mbti), cards are valid, sharing lists every key", async () => {
    const rows = await seedRows();
    expect(rows.size, "run supabase/seed.sql").toBe(3);
    for (const [name, id] of Object.entries(SEED)) {
      const r = rows.get(id)!;
      expect(r.cards.length, name).toBeGreaterThan(0);
      expect(ProfileInput.shape.cards.safeParse(r.cards).success, name).toBe(true);
      expect(r.archetype, name).toBe(computeArchetype(r.cards, r.mbti));
      expect(Object.keys(r.sharing).sort(), name).toEqual(Object.keys(SharingSettings.parse({})).sort());
      for (const t of SENSITIVE) expect(r.sharing[t], `${name}.${t}`).toBe(false);
      expect(r.social_links, name).toEqual([]);
    }
  });

  it("Alex and Sam overlap for real and Riley little; only Alex fills sensitive fields", async () => {
    const rows = await seedRows();
    const [alex, sam, riley] = [rows.get(SEED.alex)!, rows.get(SEED.sam)!, rows.get(SEED.riley)!];
    expect(alex.location).toBe(sam.location);
    const shared = (x: SeedRow, y: SeedRow) => x.cards.filter((c) => y.cards.includes(c)).length;
    expect(shared(alex, sam)).toBeGreaterThanOrEqual(3);
    expect(shared(alex, riley)).toBeLessThanOrEqual(1);
    expect(shared(sam, riley)).toBeLessThanOrEqual(1);
    expect([alex.ethnicity, alex.drinking, alex.smoking, alex.drugs].every((v) => v !== null)).toBe(true);
    for (const r of [sam, riley]) expect([r.ethnicity, r.drinking, r.smoking, r.drugs]).toEqual([null, null, null, null]);
  });
});
