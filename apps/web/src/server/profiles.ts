import "server-only";

import {
  ArchetypeId,
  computeArchetype,
  SharingSettings,
  type Education,
  type Gender,
  type HabitFrequency,
  type LookingFor,
  type Mbti,
  type OwnProfile,
  type ProfileInput,
  type SharedProfile,
} from "@cue/contracts";
import { iso, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { getAdminSupabase } from "@/server/supabase-admin";

/**
 * A `profiles` row as read by the server. The legacy `social_links` column is
 * deliberately not selected: external links are no longer collected or shown.
 */
export interface ProfileRow {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  bio: string;
  interests: string[];
  age: number | null;
  gender: Gender | null;
  gender_self_described: string | null;
  location: string | null;
  looking_for: LookingFor | null;
  work_or_school: string | null;
  education: Education | null;
  mbti: Mbti | null;
  ethnicity: string | null;
  drinking: HabitFrequency | null;
  smoking: HabitFrequency | null;
  drugs: HabitFrequency | null;
  cards: string[] | null;
  archetype: string | null;
  sharing: unknown;
  version: number;
  updated_at: string;
}

const PROFILE_COLUMNS = [
  "user_id",
  "display_name",
  "photo_url",
  "bio",
  "interests",
  "age",
  "gender",
  "gender_self_described",
  "location",
  "looking_for",
  "work_or_school",
  "education",
  "mbti",
  "ethnicity",
  "drinking",
  "smoking",
  "drugs",
  "cards",
  "archetype",
  "sharing",
  "version",
  "updated_at",
].join(", ");

/** If stored sharing is unreadable, share nothing optional rather than everything. */
const NOTHING_SHARED: SharingSettings = {
  photo: false,
  bio: false,
  interests: false,
  age: false,
  gender: false,
  location: false,
  lookingFor: false,
  mbti: false,
  cards: false,
  workOrSchool: false,
  education: false,
  ethnicity: false,
  drinking: false,
  smoking: false,
  drugs: false,
  aiAssist: false,
};

/**
 * Stored sharing settings. Keys missing from rows saved before they existed
 * take the contract defaults (sensitive ones off); unknown keys (e.g. the old
 * `socialLinks`) are dropped.
 */
export function sharingOf(row: ProfileRow): SharingSettings {
  const parsed = SharingSettings.safeParse(row.sharing);
  return parsed.success ? parsed.data : NOTHING_SHARED;
}

function archetypeOf(row: ProfileRow): ArchetypeId | null {
  const parsed = ArchetypeId.safeParse(row.archetype);
  return parsed.success ? parsed.data : null;
}

const cardsOf = (row: ProfileRow): string[] => row.cards ?? [];

export function toOwnProfile(row: ProfileRow): OwnProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    bio: row.bio,
    interests: row.interests,
    age: row.age,
    gender: row.gender,
    genderSelfDescribed: row.gender_self_described,
    location: row.location,
    lookingFor: row.looking_for,
    workOrSchool: row.work_or_school,
    education: row.education,
    mbti: row.mbti,
    ethnicity: row.ethnicity,
    drinking: row.drinking,
    smoking: row.smoking,
    drugs: row.drugs,
    cards: cardsOf(row),
    archetype: archetypeOf(row),
    sharing: sharingOf(row),
    version: row.version,
    updatedAt: iso(row.updated_at),
  };
}

/**
 * What a matched account may see: only fields the owner approved. Unapproved
 * fields are dropped here, on the server, and never leave it.
 */
export function toSharedProfile(row: ProfileRow): SharedProfile {
  const s = sharingOf(row);
  const show = <T>(on: boolean, value: T | null | undefined): T | null => (on ? (value ?? null) : null);
  return {
    userId: row.user_id,
    displayName: row.display_name,
    photoUrl: show(s.photo, row.photo_url),
    bio: show(s.bio, row.bio),
    interests: s.interests ? row.interests : [],
    age: show(s.age, row.age),
    gender: show(s.gender, row.gender),
    genderSelfDescribed: show(s.gender, row.gender_self_described),
    location: show(s.location, row.location),
    lookingFor: show(s.lookingFor, row.looking_for),
    workOrSchool: show(s.workOrSchool, row.work_or_school),
    education: show(s.education, row.education),
    mbti: show(s.mbti, row.mbti),
    ethnicity: show(s.ethnicity, row.ethnicity),
    drinking: show(s.drinking, row.drinking),
    smoking: show(s.smoking, row.smoking),
    drugs: show(s.drugs, row.drugs),
    cards: s.cards ? cardsOf(row) : [],
    archetype: show(s.cards, archetypeOf(row)),
  };
}

export async function getProfileRows(userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (userIds.length === 0) return new Map();
  const rows = unwrap(
    await getAdminSupabase().from("profiles").select(PROFILE_COLUMNS).in("user_id", userIds),
  ) as unknown as ProfileRow[];
  return new Map(rows.map((r) => [r.user_id, r]));
}

export async function getOwnProfile(userId: string): Promise<OwnProfile> {
  const row = (await getProfileRows([userId])).get(userId);
  if (!row) throw new HttpError("not_found", "Profile not created yet");
  return toOwnProfile(row);
}

/**
 * Create or replace the caller's profile. The character (`archetype`) is
 * derived here from the cards and MBTI; it is never taken from the client
 * (`ProfileInput` has no such key, and zod strips unknown keys). A DB trigger
 * bumps `version` on any real change.
 */
export async function saveOwnProfile(userId: string, input: ProfileInput): Promise<OwnProfile> {
  const row = unwrap(
    await getAdminSupabase()
      .from("profiles")
      .upsert(
        {
          user_id: userId,
          display_name: input.displayName,
          photo_url: input.photoUrl,
          bio: input.bio,
          interests: input.interests,
          age: input.age,
          gender: input.gender,
          gender_self_described: input.genderSelfDescribed,
          location: input.location,
          looking_for: input.lookingFor,
          work_or_school: input.workOrSchool,
          education: input.education,
          mbti: input.mbti,
          ethnicity: input.ethnicity,
          drinking: input.drinking,
          smoking: input.smoking,
          drugs: input.drugs,
          cards: input.cards,
          archetype: computeArchetype(input.cards, input.mbti),
          sharing: input.sharing,
        },
        { onConflict: "user_id" },
      )
      .select(PROFILE_COLUMNS)
      .single(),
  ) as unknown as ProfileRow;
  return toOwnProfile(row);
}
