import "server-only";

import {
  SharingSettings,
  SocialLink,
  type OwnProfile,
  type ProfileInput,
  type SharedProfile,
} from "@cue/contracts";
import { z } from "zod";
import { iso, unwrap } from "@/server/db";
import { HttpError } from "@/server/http";
import { getAdminSupabase } from "@/server/supabase-admin";

export interface ProfileRow {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  bio: string;
  interests: string[];
  social_links: unknown;
  sharing: unknown;
  version: number;
  updated_at: string;
}

const PROFILE_COLUMNS =
  "user_id, display_name, photo_url, bio, interests, social_links, sharing, version, updated_at";

/** If stored sharing is unreadable, share nothing optional rather than everything. */
const NOTHING_SHARED: SharingSettings = {
  photo: false,
  bio: false,
  interests: false,
  socialLinks: false,
  aiAssist: false,
};

export function sharingOf(row: ProfileRow): SharingSettings {
  const parsed = SharingSettings.safeParse(row.sharing);
  return parsed.success ? parsed.data : NOTHING_SHARED;
}

function socialLinksOf(row: ProfileRow): SocialLink[] {
  const parsed = z.array(SocialLink).safeParse(row.social_links);
  return parsed.success ? parsed.data : [];
}

export function toOwnProfile(row: ProfileRow): OwnProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    bio: row.bio,
    interests: row.interests,
    socialLinks: socialLinksOf(row),
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
  const sharing = sharingOf(row);
  return {
    userId: row.user_id,
    displayName: row.display_name,
    photoUrl: sharing.photo ? row.photo_url : null,
    bio: sharing.bio ? row.bio : null,
    interests: sharing.interests ? row.interests : [],
    socialLinks: sharing.socialLinks ? socialLinksOf(row) : [],
  };
}

export async function getProfileRows(userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (userIds.length === 0) return new Map();
  const rows = unwrap(
    await getAdminSupabase().from("profiles").select(PROFILE_COLUMNS).in("user_id", userIds),
  ) as ProfileRow[];
  return new Map(rows.map((r) => [r.user_id, r]));
}

export async function getOwnProfile(userId: string): Promise<OwnProfile> {
  const row = (await getProfileRows([userId])).get(userId);
  if (!row) throw new HttpError("not_found", "Profile not created yet");
  return toOwnProfile(row);
}

/** Create or replace the caller's profile. A DB trigger bumps `version` on any real change. */
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
          social_links: input.socialLinks,
          sharing: input.sharing,
        },
        { onConflict: "user_id" },
      )
      .select(PROFILE_COLUMNS)
      .single(),
  ) as ProfileRow;
  return toOwnProfile(row);
}
