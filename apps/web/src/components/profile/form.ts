import {
  DEFAULT_SHARING,
  ProfileInput,
  SocialLink,
  type OwnProfile,
  type SharedProfile,
  type SharingSettings,
} from "@cue/contracts";

export interface LinkRow {
  /** Local row key only; never sent anywhere. */
  id: string;
  label: string;
  url: string;
}

export interface FormState {
  displayName: string;
  photoUrl: string | null;
  bio: string;
  interests: string[];
  links: LinkRow[];
  sharing: SharingSettings;
}

export const LIMITS = { name: 40, bio: 280, interests: 12, interest: 40, links: 5, label: 30 } as const;

export function newRowId(): string {
  return crypto.randomUUID();
}

export function emptyForm(): FormState {
  return {
    displayName: "",
    photoUrl: null,
    bio: "",
    interests: [],
    links: [],
    sharing: { ...DEFAULT_SHARING },
  };
}

export function formFromProfile(p: OwnProfile): FormState {
  return {
    displayName: p.displayName,
    photoUrl: p.photoUrl,
    bio: p.bio,
    interests: [...p.interests],
    links: p.socialLinks.map((l) => ({ id: newRowId(), label: l.label, url: l.url })),
    sharing: { ...p.sharing },
  };
}

/** Add `https://` to a bare domain. Anything with a scheme is left for the schema to judge. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

function isBlankRow(r: LinkRow): boolean {
  return r.label.trim() === "" && r.url.trim() === "";
}

/** Rows with at least one field filled, normalised. Empty rows are dropped. */
function keptRows(links: LinkRow[]): { row: LinkRow; index: number }[] {
  return links
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isBlankRow(row))
    .map(({ row, index }) => ({
      index,
      row: { ...row, label: row.label.trim(), url: normalizeUrl(row.url) },
    }));
}

/** Stable string of what would be saved; used for the dirty check. */
export function draftKey(f: FormState): string {
  return JSON.stringify({
    n: f.displayName.trim(),
    p: f.photoUrl,
    b: f.bio.trim(),
    i: f.interests,
    l: keptRows(f.links).map(({ row }) => [row.label, row.url]),
    s: f.sharing,
  });
}

export type FieldErrors = Record<string, string>;

export function toInputDraft(f: FormState): { draft: unknown; rowIndexes: number[] } {
  const kept = keptRows(f.links);
  return {
    rowIndexes: kept.map((k) => k.index),
    draft: {
      displayName: f.displayName,
      photoUrl: f.photoUrl,
      bio: f.bio,
      interests: f.interests,
      socialLinks: kept.map(({ row }) => ({ label: row.label, url: row.url })),
      sharing: f.sharing,
    },
  };
}

/** Validate the whole form with the contract schema and phrase issues for people. */
export function validateForm(f: FormState): { input: ProfileInput | null; errors: FieldErrors } {
  const { draft, rowIndexes } = toInputDraft(f);
  const parsed = ProfileInput.safeParse(draft);
  if (parsed.success) return { input: parsed.data, errors: {} };

  const errors: FieldErrors = {};
  const put = (key: string, msg: string) => {
    errors[key] ??= msg;
  };
  for (const issue of parsed.error.issues) {
    const [head, second, third] = issue.path;
    const tooBig = issue.code === "too_big";
    if (head === "displayName") {
      put("displayName", tooBig ? `Keep your name to ${LIMITS.name} characters or fewer.` : "Add a name for a match to see.");
    } else if (head === "bio") {
      put("bio", `Keep your bio to ${LIMITS.bio} characters or fewer.`);
    } else if (head === "photoUrl") {
      put("photoUrl", "That photo can't be used. Remove it and add it again.");
    } else if (head === "interests") {
      put(
        "interests",
        typeof second === "number"
          ? `Interests are 1 to ${LIMITS.interest} characters each.`
          : `A profile holds up to ${LIMITS.interests} interests.`,
      );
    } else if (head === "socialLinks") {
      if (typeof second !== "number") {
        put("links", `A profile holds up to ${LIMITS.links} links.`);
      } else {
        const row = rowIndexes[second] ?? second;
        if (third === "label") {
          put(
            `link.${row}.label`,
            tooBig ? `Keep labels to ${LIMITS.label} characters or fewer.` : "Give this link a label, such as Instagram.",
          );
        } else {
          const empty = (f.links[row]?.url ?? "").trim() === "";
          put(
            `link.${row}.url`,
            empty
              ? "Add the web address for this link."
              : tooBig
                ? "That address is too long. Use one under 300 characters."
                : "That doesn't look like a web address. It should start with http:// or https://.",
          );
        }
      }
    }
  }
  if (Object.keys(errors).length === 0) errors.form = "Some of that didn't look right. Check the fields and try again.";
  return { input: null, errors };
}

/**
 * Mirror of what the server builds for a matched account: display name always,
 * everything else only when its switch is on.
 */
export function buildShared(f: FormState, userId: string): SharedProfile {
  const links = keptRows(f.links)
    .map(({ row }) => SocialLink.safeParse({ label: row.label, url: row.url }))
    .flatMap((r) => (r.success ? [r.data] : []));
  const bio = f.bio.trim();
  return {
    userId,
    displayName: f.displayName.trim(),
    photoUrl: f.sharing.photo ? f.photoUrl : null,
    bio: f.sharing.bio ? bio : null,
    interests: f.sharing.interests ? f.interests : [],
    socialLinks: f.sharing.socialLinks ? links : [],
  };
}
