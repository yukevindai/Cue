"use client";

import { useId, useRef, useState } from "react";
import { Button, Chip } from "@/components/ui";
import { LIMITS } from "./form";

export function InterestsEditor({
  interests,
  onChange,
  error,
}: {
  interests: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const full = interests.length >= LIMITS.interests;

  function add(raw: string) {
    const parts = raw
      .split(",")
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (parts.length === 0) {
      inputRef.current?.focus();
      return;
    }
    const next = [...interests];
    const added: string[] = [];
    let note: string | null = null;
    for (const p of parts) {
      if (next.length >= LIMITS.interests) {
        note = `That's ${LIMITS.interests}, the most a profile holds. Remove one to add another.`;
        break;
      }
      if (p.length > LIMITS.interest) {
        note = `"${p.slice(0, 20)}…" is too long. Interests are up to ${LIMITS.interest} characters.`;
        continue;
      }
      if (next.some((x) => x.toLowerCase() === p.toLowerCase())) {
        note = `"${p}" is already on your list.`;
        continue;
      }
      next.push(p);
      added.push(p);
    }
    if (added.length) {
      onChange(next);
      setAnnounce(`Added ${added.join(", ")}. ${next.length} of ${LIMITS.interests} interests.`);
    }
    setMessage(note);
    setDraft("");
    inputRef.current?.focus();
  }

  function remove(i: number) {
    const gone = interests[i];
    onChange(interests.filter((_, idx) => idx !== i));
    setMessage(null);
    setAnnounce(`Removed ${gone}. ${interests.length - 1} of ${LIMITS.interests} interests.`);
    inputRef.current?.focus();
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-semibold">
        Add an interest
      </label>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          id={id}
          value={draft}
          maxLength={200}
          disabled={full}
          placeholder={full ? "Interests are full" : "Climbing, jazz, ceramics"}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          className="block min-w-0 flex-1 rounded-xl border border-line-strong bg-white px-4 py-3 text-base text-ink placeholder:text-ink-soft/70 focus:border-ember focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember disabled:bg-sunk"
        />
        <Button variant="secondary" onClick={() => add(draft)} disabled={full}>
          Add
        </Button>
      </div>
      <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-soft">
        Press Enter or type a comma to add. Up to {LIMITS.interests}, {LIMITS.interest} characters each.
      </p>
      <div role="status" className="min-h-0">
        {message ? <p className="mt-1.5 text-sm font-medium text-ember-deep">{message}</p> : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-sm font-medium text-ember-deep">
          {error}
        </p>
      ) : null}

      {interests.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Your interests">
          {interests.map((it, i) => (
            <li key={it.toLowerCase()}>
              <Chip onRemove={() => remove(i)}>{it}</Chip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-ink-soft">No interests yet. Two or three give a match something to open with.</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
