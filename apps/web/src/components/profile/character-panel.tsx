import { ARCHETYPES, type ArchetypeId } from "@cue/contracts";
import { cx } from "@/lib/cx";

/**
 * The character the person's picks give, updated live as they pick. Dusk, like
 * the match moment: the character is what a match meets first.
 */
export function CharacterPanel({ archetype, className }: { archetype: ArchetypeId | null; className?: string }) {
  const a = archetype ? ARCHETYPES[archetype] : null;
  return (
    <div
      className={cx("flex items-center gap-4 rounded-2xl bg-dusk px-4 py-3.5 text-cream sm:px-5 sm:py-4", className)}
    >
      <span aria-hidden className="relative h-9 w-14 shrink-0">
        <span className="absolute left-0 top-0 h-9 w-9 rounded-full border-2 border-cream/80" />
        <span
          className={cx(
            "absolute right-0 top-0 h-9 w-9 rounded-full border-2 transition-colors",
            a ? "border-ember bg-ember/30" : "border-cream/30",
          )}
        />
      </span>
      <div aria-live="polite" className="min-w-0">
        {a ? (
          <div key={a.id} className="animate-fade">
            <p className="text-sm text-cream/70">Your character</p>
            <p className="font-display text-2xl italic leading-tight">{a.name}</p>
            <p className="text-[0.95rem] leading-snug text-cream/85">{a.tagline}</p>
          </div>
        ) : (
          <p className="font-display text-lg italic leading-snug text-cream/85">
            Pick a few cards and your character appears.
          </p>
        )}
      </div>
    </div>
  );
}
