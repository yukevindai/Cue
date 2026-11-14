import type { SharedProfile } from "@cue/contracts";
import { Avatar } from "@/components/ui";

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A small, faithful rendering of what a mutual match receives. Hidden fields are absent, not greyed out. */
export function MatchPreview({ shared }: { shared: SharedProfile }) {
  const name = shared.displayName || "Your name";
  return (
    <article
      aria-label="Preview of what a match sees"
      className="rounded-card border border-line-strong bg-paper p-5"
    >
      <div className="flex items-center gap-4">
        <Avatar name={name} src={shared.photoUrl} size={64} />
        <p className="min-w-0 break-words font-display text-2xl leading-tight">{name}</p>
      </div>
      {shared.bio ? <p className="mt-4 whitespace-pre-line break-words">{shared.bio}</p> : null}
      {shared.interests.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {shared.interests.map((i) => (
            <li key={i} className="rounded-full border border-line bg-sunk px-3 py-1 text-sm font-medium">
              {i}
            </li>
          ))}
        </ul>
      ) : null}
      {shared.socialLinks.length > 0 ? (
        <ul className="mt-4 space-y-1 text-sm">
          {shared.socialLinks.map((l) => (
            <li key={l.url} className="break-words">
              <span className="font-semibold">{l.label}</span>{" "}
              <span className="text-ink-soft">{host(l.url)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
