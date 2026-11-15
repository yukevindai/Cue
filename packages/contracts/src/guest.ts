import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

/**
 * Guest accounts: a demo-only way in with nothing but a name. A guest is an
 * ordinary account whose email is `guest-<uuid>@GUEST_EMAIL_DOMAIN` and whose
 * password nobody knows. That address is the only thing that marks a guest,
 * and is how they are found and deleted after the demos
 * (see docs/guest-accounts.md). To be removed with the feature.
 */
export const GUEST_EMAIL_DOMAIN = "guest.cue.invalid";
export const isGuestEmail = (email: string | null | undefined): boolean =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);

export const GUEST_NAME_MAX_LENGTH = 40;

/** What someone said or typed to introduce themselves, or just their name. */
export const GuestInput = z.object({ intro: z.string().trim().min(1).max(200) }).strict();
export type GuestInput = z.infer<typeof GuestInput>;

/** POST /api/guest -> the new account is signed in (cookies) and this is returned. */
export const GuestResult = z.object({ displayName: z.string() });
export type GuestResult = z.infer<typeof GuestResult>;

/** POST /api/guest/device: create a guest and link the calling glasses in one step. */
export const GuestDeviceInput = z
  .object({
    intro: z.string().trim().min(1).max(200),
    deviceLabel: z.string().trim().min(1).max(60).optional(),
    mentraUserId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type GuestDeviceInput = z.infer<typeof GuestDeviceInput>;

export const GuestDeviceResult = z.object({
  displayName: z.string(),
  deviceId: Uuid,
  deviceToken: z.string().min(32),
});
export type GuestDeviceResult = z.infer<typeof GuestDeviceResult>;

/**
 * POST /api/guest/handoff (device token): a one-time link that signs a phone
 * browser into the guest account the glasses belong to. Guests only.
 */
export const GuestHandoff = z.object({
  /** Site-relative path to open, e.g. `/g/<token>`. Single use. */
  path: z.string(),
  expiresAt: IsoDateTime,
});
export type GuestHandoff = z.infer<typeof GuestHandoff>;

export const guestHandoffPath = (token: string) => `/g/${encodeURIComponent(token)}`;

const FILLER = "(?:so|um+|uh+|er+|well|and|oh|ok|okay|alright)";
const GREETING_WORD = "(?:hi|hey|hello|yo|sup|hiya|heya|howdy|greetings|good (?:morning|afternoon|evening))(?: there| everyone| guys| all)?";
/** Leading fillers and greetings, in any order: "um hi", "hey so". */
const OPENING = new RegExp(`^(?:(?:${FILLER}|${GREETING_WORD})(?:[\\s,.!]+|$))+`, "i");
const LEAD_IN =
  /^(?:my name is|my name's|the name is|the name's|name is|name's|i am|i'm|im|it is|it's|its|this is|you can call me|they call me|people call me|just call me|call me)(?:\s+|$)/i;
const NOT_A_NAME = new Set([
  "hi", "hey", "hello", "yo", "sup", "hiya", "heya", "howdy", "there", "me", "i", "im", "am", "is", "the", "a",
  "name", "my", "it", "its", "this", "here", "new", "ready", "good", "fine", "ok", "okay", "yes", "no", "cue",
]);

/**
 * Picks a display name out of an introduction: "Hi, my name is Sam", "I'm
 * Sam", "call me Sam", or just "Sam". Returns null when no name can be read
 * with confidence (too long, no letters, only a greeting). Never guesses.
 * With `requireLeadIn`, a bare name is not enough: the words must include an
 * introduction such as "my name is" or "I'm".
 */
export function parseIntroName(input: string, options: { requireLeadIn?: boolean } = {}): string | null {
  if (typeof input !== "string") return null;
  // Control characters out, whitespace collapsed.
  let text = input.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > 200) return null;

  text = text.replace(OPENING, "").trim();
  const hadLeadIn = LEAD_IN.test(text);
  text = text.replace(LEAD_IN, "").trim();
  // Always-on listening (the glasses) must not take any short phrase for a
  // name: there it has to be an actual introduction.
  if (options.requireLeadIn && !hadLeadIn) return null;
  // "my name is" with nothing after it is not a name.
  if (hadLeadIn && text.length === 0) return null;

  // The name ends at the first sentence break ("I'm Sam, nice to meet you").
  text = text.split(/[,.!?;:]|\s+(?:and|but|nice|pleased|good)\s+/i)[0]!.trim();
  // Keep letters (any script), apostrophes, hyphens and spaces.
  text = text.replace(/[^\p{L}\p{M}'’\- ]+/gu, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^['’\-]+|['’\-]+$/g, "");
  if (text.length === 0) return null;

  const words = text.split(" ");
  // A bare phrase is only a name if it is short; after "my name is" allow a full name.
  if (words.length > (hadLeadIn ? 4 : 3)) return null;
  if (words.length === 1 && NOT_A_NAME.has(words[0]!.toLowerCase())) return null;
  if (!/\p{L}/u.test(text)) return null;

  const name = words
    .map((w) => (w === w.toLowerCase() || w === w.toUpperCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
  return name.length <= GUEST_NAME_MAX_LENGTH ? name : null;
}
