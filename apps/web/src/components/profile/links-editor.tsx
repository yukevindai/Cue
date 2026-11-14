"use client";

import { Button, TextField } from "@/components/ui";
import { LIMITS, newRowId, normalizeUrl, type FieldErrors, type LinkRow } from "./form";

export function LinksEditor({
  links,
  onChange,
  errors,
}: {
  links: LinkRow[];
  onChange: (next: LinkRow[]) => void;
  errors: FieldErrors;
}) {
  const full = links.length >= LIMITS.links;

  function update(id: string, patch: Partial<LinkRow>) {
    onChange(links.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function add() {
    const id = newRowId();
    onChange([...links, { id, label: "", url: "" }]);
    requestAnimationFrame(() => document.getElementById(`link-label-${id}`)?.focus());
  }

  return (
    <div>
      {links.length === 0 ? (
        <p className="text-ink-soft">No links yet. Add one if you&rsquo;d like a match to find you elsewhere.</p>
      ) : (
        <ul className="space-y-5">
          {links.map((l, i) => (
            <li key={l.id} role="group" aria-label={`Link ${i + 1}`}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <TextField
                  id={`link-label-${l.id}`}
                  label="Label"
                  value={l.label}
                  maxLength={LIMITS.label}
                  placeholder="Instagram"
                  error={errors[`link.${i}.label`]}
                  onChange={(e) => update(l.id, { label: e.target.value })}
                />
                <TextField
                  label="Web address"
                  value={l.url}
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={300}
                  placeholder="instagram.com/yourname"
                  error={errors[`link.${i}.url`]}
                  onChange={(e) => update(l.id, { url: e.target.value })}
                  onBlur={() => {
                    const n = normalizeUrl(l.url);
                    if (n !== l.url) update(l.id, { url: n });
                  }}
                />
              </div>
              <Button
                variant="quiet"
                className="mt-1 min-h-10 px-0"
                aria-label={`Remove link ${i + 1}${l.label.trim() ? `, ${l.label.trim()}` : ""}`}
                onClick={() => onChange(links.filter((x) => x.id !== l.id))}
              >
                Remove link
              </Button>
            </li>
          ))}
        </ul>
      )}
      {errors.links ? (
        <p role="alert" className="mt-2 text-sm font-medium text-ember-deep">
          {errors.links}
        </p>
      ) : null}
      <div className="mt-4">
        <Button variant="secondary" onClick={add} disabled={full}>
          Add a link
        </Button>
        {full ? (
          <p className="mt-2 text-sm text-ink-soft">
            That&rsquo;s {LIMITS.links}, the most a profile holds. Remove one to add another.
          </p>
        ) : null}
      </div>
    </div>
  );
}
