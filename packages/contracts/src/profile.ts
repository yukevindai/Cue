import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const SocialLink = z.object({
  label: z.string().trim().min(1).max(30),
  url: z.url({ protocol: /^https?$/ }).max(300),
});
export type SocialLink = z.infer<typeof SocialLink>;

/** Which optional fields a mutual match may see. Display name is always shared. */
export const SharingSettings = z.object({
  photo: z.boolean(),
  bio: z.boolean(),
  interests: z.boolean(),
  socialLinks: z.boolean(),
  /** Allow the shared fields to be sent to Claude for the wingman card. */
  aiAssist: z.boolean(),
});
export type SharingSettings = z.infer<typeof SharingSettings>;

export const DEFAULT_SHARING: SharingSettings = {
  photo: true,
  bio: true,
  interests: true,
  socialLinks: false,
  aiAssist: true,
};

/** Body of PUT /api/profile. */
export const ProfileInput = z.object({
  displayName: z.string().trim().min(1).max(40),
  /** Public URL (Supabase Storage `avatars` bucket) or null. */
  photoUrl: z.url().max(500).nullable(),
  bio: z.string().trim().max(280),
  interests: z.array(z.string().trim().min(1).max(40)).max(12),
  socialLinks: z.array(SocialLink).max(5),
  sharing: SharingSettings,
});
export type ProfileInput = z.infer<typeof ProfileInput>;

/** The signed-in user's own profile (GET/PUT /api/profile). */
export const OwnProfile = ProfileInput.extend({
  userId: Uuid,
  /** Increments on every content or sharing change; used for wingman cache keys. */
  version: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
});
export type OwnProfile = z.infer<typeof OwnProfile>;

/**
 * What a matched account may see. Fields the owner did not approve are null /
 * empty and are never sent to the client.
 */
export const SharedProfile = z.object({
  userId: Uuid,
  displayName: z.string(),
  photoUrl: z.string().nullable(),
  bio: z.string().nullable(),
  interests: z.array(z.string()),
  socialLinks: z.array(SocialLink),
});
export type SharedProfile = z.infer<typeof SharedProfile>;
