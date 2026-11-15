"use client";

import { useId, type ReactNode } from "react";
import { cx } from "@/lib/cx";

/**
 * Chip-shaped choices built on native radio and checkbox inputs, so arrow
 * keys, Space, form semantics and screen readers all work as usual. The input
 * is visually hidden; its focus ring is drawn on the chip.
 */

const chipBase =
  "inline-flex min-h-11 cursor-pointer select-none items-center gap-1.5 rounded-full border px-3.5 py-2 text-[0.95rem] font-medium leading-tight transition-colors " +
  "peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ember peer-focus-visible:outline";
const chipOff = "border-line-strong bg-surface text-ink hover:border-ink-soft hover:bg-white";
const chipOn = "border-ink bg-ink text-paper";
const chipDisabled = "peer-disabled:cursor-not-allowed peer-disabled:opacity-45 peer-disabled:hover:bg-surface";

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className="-ml-0.5 shrink-0">
      <path d="M3 7.5l2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** One optional choice from a short list, with a way to clear it. */
export function ChoiceChips<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
  columns,
  clearLabel = "Clear",
}: {
  legend: string;
  hint?: ReactNode;
  options: readonly Option<T>[];
  value: T | null;
  onChange: (next: T | null) => void;
  /** Lay the chips out in an even grid instead of wrapping (e.g. 4 for MBTI). */
  columns?: number;
  clearLabel?: string;
}) {
  const name = useId();
  return (
    <fieldset>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <legend className="float-left font-semibold">{legend}</legend>
        {value !== null ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`${clearLabel}: ${legend}`}
            className="shrink-0 rounded-full px-2 text-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
      {hint ? <p className="clear-both mb-2 text-sm text-ink-soft">{hint}</p> : null}
      <div
        className={cx("clear-both", columns ? "grid gap-1.5" : "flex flex-wrap gap-2")}
        style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {options.map((o) => {
          const on = value === o.value;
          return (
            <label key={o.value} className={cx("relative", columns && "flex")}>
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                onChange={() => onChange(o.value)}
                className="peer sr-only"
              />
              <span className={cx(chipBase, on ? chipOn : chipOff, columns && "w-full justify-center px-2 tabular-nums")}>
                {on && !columns ? <Check /> : null}
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Several choices from a deck, at most `max`, with a clear "2 of 3" count. */
export function PickChips({
  legend,
  options,
  selected,
  max,
  onToggle,
}: {
  legend: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  max: number;
  onToggle: (value: string) => void;
}) {
  const countId = useId();
  const count = options.filter((o) => selected.includes(o.value)).length;
  const full = count >= max;
  return (
    <fieldset aria-describedby={countId}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <legend className="float-left font-display text-xl leading-tight">{legend}</legend>
        <span
          id={countId}
          className={cx("shrink-0 text-sm tabular-nums", full ? "font-semibold text-ink" : "text-ink-soft")}
        >
          {count} of {max}
          <span className="sr-only">{full ? " picked. Remove one to pick another." : " picked"}</span>
        </span>
      </div>
      <div className="clear-both flex flex-wrap gap-2">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <label key={o.value} className="relative">
              <input
                type="checkbox"
                value={o.value}
                checked={on}
                disabled={full && !on}
                onChange={() => onToggle(o.value)}
                className="peer sr-only"
              />
              <span className={cx(chipBase, on ? chipOn : chipOff, chipDisabled)}>
                {on ? <Check /> : null}
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
