/** "Today, 3:42 PM" / "Yesterday, 9:05 AM" / "Nov 12, 6:30 PM". */
export function formatEncounterTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayMs = 24 * 60 * 60 * 1000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / dayMs);
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${date}, ${time}`;
}

/** "just now", "2 min ago", "3 h ago", then a date. For device last-seen. */
export function formatAgo(iso: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whole seconds remaining until `iso`, never negative. */
export function secondsUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / 1000));
}

/** Initials for the avatar fallback. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * Where a match happened, in words. A phone-location match names no place
 * (its label is only "Nearby"); a check-in match names the venue; an older,
 * hand-entered label keeps its note.
 */
export function matchPlace(match: { venueLabel: string; venueLabelSource: "manual" | "venue_checkin" | "phone_location" }): {
  /** "Met at Main hall" / "You were near each other". */
  line: string;
  /** For "You met <time> <phrase>": "at Main hall" / "near each other". */
  phrase: string;
  /** A short plain note on where the label came from, or null. */
  note: string | null;
} {
  switch (match.venueLabelSource) {
    case "phone_location":
      return {
        line: "You were near each other",
        phrase: "near each other",
        note: "Your phones were close together. SocialEyes doesn't keep where.",
      };
    case "venue_checkin":
      return {
        line: `Met at ${match.venueLabel}`,
        phrase: `at ${match.venueLabel}`,
        note: "You were both checked in here.",
      };
    case "manual":
      return {
        line: `Met at ${match.venueLabel}`,
        phrase: `at ${match.venueLabel}`,
        note: "Venue entered by hand, not GPS.",
      };
  }
}
