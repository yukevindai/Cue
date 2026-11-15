import type { SharedProfile } from "@cue/contracts";
import { Chip } from "@/components/ui";
import { cx } from "@/lib/cx";
import { sharedFacts, type Fact } from "@/lib/profile-facts";

/**
 * Everything a person chose to share beyond name, photo and bio, rendered
 * from a SharedProfile. A field that was not shared produces nothing at all:
 * no label, no placeholder.
 */
export function ProfileDetails({
  profile,
  size = "md",
  showCharacter = true,
}: {
  profile: SharedProfile;
  size?: "sm" | "md";
  showCharacter?: boolean;
}) {
  const f = sharedFacts(profile);
  const sm = size === "sm";
  const heading = sm ? "text-sm font-semibold text-ink-soft" : "font-display text-xl leading-tight";

  return (
    <div className={cx(sm ? "space-y-4" : "space-y-6")}>
      {showCharacter && f.character ? (
        <div className={cx("border-l-[3px] border-ember", sm ? "pl-3" : "pl-4")}>
          <p className={cx("font-display italic leading-tight", sm ? "text-xl" : "text-3xl")}>{f.character.name}</p>
          <p className={cx("text-ink-soft", sm ? "text-sm" : "mt-0.5")}>{f.character.tagline}</p>
        </div>
      ) : null}

      {f.basics.length > 0 ? <Facts facts={f.basics} sm={sm} label="Basics" /> : null}

      {f.cards.length > 0 ? (
        <div className={cx(sm ? "space-y-3" : "space-y-4")}>
          {f.cards.map((g) => (
            <div key={g.deck}>
              <h3 className={heading}>{g.title}</h3>
              <ul className={cx("flex flex-wrap", sm ? "mt-1.5 gap-1.5" : "mt-2 gap-2")}>
                {g.labels.map((l) => (
                  <li key={l}>
                    {sm ? (
                      <span className="inline-block rounded-full border border-line bg-sunk px-3 py-1 text-sm font-medium">
                        {l}
                      </span>
                    ) : (
                      <Chip>{l}</Chip>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {f.about.length > 0 ? <Facts facts={f.about} sm={sm} label="About" /> : null}

      {f.personal.length > 0 ? (
        <div>
          <h3 className={heading}>Personal details they chose to share</h3>
          <div className={sm ? "mt-1.5" : "mt-2"}>
            <Facts facts={f.personal} sm={sm} label="Personal details" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Facts({ facts, sm, label }: { facts: Fact[]; sm: boolean; label: string }) {
  return (
    <dl
      aria-label={label}
      className={cx("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4", sm ? "gap-y-1 text-sm" : "gap-y-1.5")}
    >
      {facts.map((x) => (
        <div key={x.key} className="contents">
          <dt className="text-ink-soft">{x.label}</dt>
          <dd className="break-words font-medium">{x.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** True when the profile shares anything ProfileDetails would render. */
export function hasDetails(profile: SharedProfile): boolean {
  const f = sharedFacts(profile);
  return !!f.character || f.basics.length + f.about.length + f.cards.length + f.personal.length > 0;
}
