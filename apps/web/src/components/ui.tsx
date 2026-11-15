"use client";

/* eslint-disable @next/next/no-img-element -- avatars come from Supabase Storage
   at a runtime-configured origin; next/image would need that host allow-listed. */

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "@/lib/cx";
import { initials } from "@/lib/format";

/* ---------- Brand ---------- */

/** Two overlapping rings: one signal each, mutual where they meet. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size * 1.5}
      height={size}
      viewBox="0 0 36 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="24" cy="12" r="10" className="fill-ember/20 stroke-ember" strokeWidth="2.2" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <Mark size={22} />
      <span className="font-display text-2xl italic leading-none tracking-tight">SocialEyes</span>
    </span>
  );
}

/* ---------- Buttons ---------- */

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
type ButtonSize = "md" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-55";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-ember text-white hover:bg-ember-deep active:bg-ember-deep",
  secondary:
    "border border-line-strong bg-surface text-ink hover:border-ink-soft hover:bg-white",
  quiet: "text-ink-soft underline-offset-4 hover:text-ink hover:underline",
  danger: "border border-ember/50 bg-surface text-ember-deep hover:bg-ember-soft",
};
const buttonSizes: Record<ButtonSize, string> = {
  md: "min-h-12 px-5 text-base",
  lg: "min-h-14 px-7 text-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  busy?: boolean;
  full?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  full = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(buttonBase, buttonVariants[variant], buttonSizes[size], full && "w-full", className)}
      {...rest}
    >
      {busy ? <Spinner size={18} /> : null}
      {children}
    </button>
  );
}

/** Class string for links that should look like a Button. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", full = false) {
  return cx(buttonBase, buttonVariants[variant], buttonSizes[size], full && "w-full");
}

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cx("animate-spin-slow", className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Layout ---------- */

export function Card({
  children,
  className,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "li";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cx("rounded-card border border-line bg-surface p-5 shadow-card sm:p-6", className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Page title block. `kicker` is the small label above the serif title. */
export function PageHeader({
  kicker,
  title,
  children,
}: {
  kicker?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {kicker ? (
        <p className="mb-1 text-sm font-medium uppercase tracking-[0.16em] text-ink-soft">{kicker}</p>
      ) : null}
      <h1 className="font-display text-4xl leading-[1.1] tracking-tight sm:text-5xl">{title}</h1>
      {children ? <div className="mt-3 max-w-prose text-lg text-ink-soft">{children}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="font-display text-2xl leading-tight tracking-tight">
      {children}
    </h2>
  );
}

/* ---------- Status ---------- */

type Tone = "neutral" | "good" | "warn" | "error";
const toneClass: Record<Tone, string> = {
  neutral: "border-line bg-sunk text-ink",
  good: "border-moss/30 bg-moss-soft text-ink",
  warn: "border-ember/30 bg-ember-soft text-ink",
  error: "border-ember/50 bg-ember-soft text-ink",
};

/** Inline message. `error` tone is announced assertively; others politely. */
export function Notice({
  tone = "neutral",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-2xl border px-4 py-3", toneClass[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cx("text-[0.95rem]", title && "mt-0.5")}>{children}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Small dot + label, e.g. "Available", "Paused", "Glasses linked". */
export function StatusPill({
  tone,
  children,
  pulse = false,
}: {
  tone: "on" | "off" | "wait";
  children: ReactNode;
  pulse?: boolean;
}) {
  const dot = tone === "on" ? "bg-moss" : tone === "wait" ? "bg-ember" : "bg-line-strong";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm font-medium">
      <span className="relative flex h-2.5 w-2.5">
        {pulse ? (
          <span className={cx("absolute inset-0 animate-breathe rounded-full", dot)} aria-hidden />
        ) : null}
        <span className={cx("relative h-2.5 w-2.5 rounded-full", dot)} aria-hidden />
      </span>
      {children}
    </span>
  );
}

/** Centered loading block for a view's first load. */
export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-ink-soft">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Empty state: serif line, one sentence, optional action. */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center">
      <Mark size={30} className="mx-auto mb-4 text-line-strong" />
      <p className="font-display text-2xl leading-tight">{title}</p>
      {children ? <p className="mx-auto mt-2 max-w-sm text-ink-soft">{children}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ---------- Forms ---------- */

const inputClass =
  "block w-full rounded-xl border border-line-strong bg-white px-4 py-3 text-base text-ink placeholder:text-ink-soft/70 focus:border-ember focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember aria-[invalid=true]:border-ember";

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

function FieldShell({
  label,
  hint,
  error,
  id,
  children,
}: FieldShellProps & { id: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-semibold">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm font-medium text-ember-deep">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...rest
}: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(inputClass, className)}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...rest
}: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(inputClass, "min-h-28 resize-y", className)}
        {...rest}
      />
    </FieldShell>
  );
}

/** Accessible on/off switch (role="switch"). The whole row is the hit target. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block font-semibold">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="text-sm text-ink-soft">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 h-8 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-55",
          checked ? "border-moss bg-moss" : "border-line-strong bg-sunk",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-white shadow transition-[left]",
            checked ? "left-[1.7rem]" : "left-1",
          )}
        />
      </button>
    </div>
  );
}

/** Interest chip. With `onRemove` it gets a labelled remove button. */
export function Chip({
  children,
  onRemove,
  tone = "neutral",
}: {
  children: string;
  onRemove?: () => void;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border py-1.5 text-[0.95rem] font-medium",
        onRemove ? "pl-3.5 pr-1.5" : "px-3.5",
        tone === "accent" ? "border-ember/30 bg-ember-soft" : "border-line bg-sunk",
      )}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${children}`}
          className="grid h-7 w-7 place-items-center rounded-full text-ink-soft hover:bg-line hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/* ---------- People ---------- */

export function Avatar({
  name,
  src,
  size = 48,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (src) {
    return (
      <img
        src={src}
        alt=""
        style={style}
        className={cx("shrink-0 rounded-full border border-line object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      className={cx(
        "grid shrink-0 place-items-center rounded-full bg-ember-soft font-display font-medium text-ember-deep",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/* ---------- Dialog ---------- */

/**
 * Confirmation dialog built on <dialog>: modal, focus-trapped, Escape cancels.
 * Render it conditionally (`{open && <ConfirmDialog …/>}`).
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClose={onCancel}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      className="m-auto w-[min(92vw,26rem)] animate-rise rounded-card border border-line bg-surface p-6 text-ink shadow-card"
    >
      <h2 id={titleId} className="font-display text-2xl leading-tight">
        {title}
      </h2>
      <div id={bodyId} className="mt-2 space-y-2 text-ink-soft">
        {children}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-medium text-ember-deep">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} busy={busy}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
