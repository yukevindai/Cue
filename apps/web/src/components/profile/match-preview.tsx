import type { SharedProfile } from "@cue/contracts";
import { Avatar } from "@/components/ui";
import { ProfileDetails } from "@/components/matches/profile-details";

/** A small, faithful rendering of what a mutual match receives. Hidden fields are absent, not greyed out. */
export function MatchPreview({ shared }: { shared: SharedProfile }) {
  const name = shared.displayName || "Your name";
  return (
    <article aria-label="Preview of what a match sees" className="rounded-card border border-line-strong bg-paper p-5">
      <div className="flex items-center gap-4">
        <Avatar name={name} src={shared.photoUrl} size={64} />
        <p className="min-w-0 break-words font-display text-2xl leading-tight">{name}</p>
      </div>
      {shared.bio ? <p className="mt-4 whitespace-pre-line break-words">{shared.bio}</p> : null}
      <div className="mt-4">
        <ProfileDetails profile={shared} size="sm" />
      </div>
      {shared.interests.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink-soft">Interests</h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {shared.interests.map((i) => (
              <li key={i} className="rounded-full border border-line bg-sunk px-3 py-1 text-sm font-medium">
                {i}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
