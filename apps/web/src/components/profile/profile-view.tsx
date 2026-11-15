"use client";

import {
  CARD_DECK_IDS,
  CARD_DECK_TITLES,
  EDUCATION_LABELS,
  EDUCATION_LEVELS,
  GENDER_LABELS,
  GENDERS,
  HABIT_FREQUENCIES,
  HABIT_FREQUENCY_LABELS,
  isGuestEmail,
  LOOKING_FOR,
  LOOKING_FOR_LABELS,
  MAX_CARDS_PER_DECK,
  MBTI_TYPES,
  PERSONALITY_CARDS,
  type Education,
  type HabitFrequency,
  type OwnProfile,
} from "@cue/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import {
  Button,
  Card,
  Loading,
  Notice,
  PageHeader,
  SectionTitle,
  Switch,
  TextArea,
  TextField,
} from "@/components/ui";
import { useLive } from "@/components/live-provider";
import { api, describeError, isApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import {
  aiNeverSent,
  aiSendable,
  buildShared,
  draftKey,
  emptyForm,
  formFromProfile,
  joinAnd,
  liveArchetype,
  LIMITS,
  SENSITIVE_KEYS,
  SHARE_FIELD_NAMES,
  shareSummary,
  toggleCard,
  validateForm,
  type FieldErrors,
  type FormState,
  type ShareKey,
} from "@/lib/profile-form";
import { CharacterPanel } from "./character-panel";
import { ChoiceChips, PickChips } from "./choice";
import { InterestsEditor } from "./interests-editor";
import { MatchPreview } from "./match-preview";
import { PhotoPicker } from "./photo-picker";

const STALL_MS = 8_000;

const GENDER_OPTIONS = GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }));
const LOOKING_OPTIONS = LOOKING_FOR.map((v) => ({ value: v, label: LOOKING_FOR_LABELS[v] }));
const MBTI_OPTIONS = MBTI_TYPES.map((v) => ({ value: v, label: v }));
const HABIT_OPTIONS = HABIT_FREQUENCIES.map((v) => ({ value: v, label: HABIT_FREQUENCY_LABELS[v] }));
const DECKS = CARD_DECK_IDS.map((deck) => ({
  deck,
  title: CARD_DECK_TITLES[deck],
  options: PERSONALITY_CARDS.filter((c) => c.deck === deck).map((c) => ({ value: c.id, label: c.label })),
}));

/** Share switches shown under "What a match sees". Sensitive ones live next to their fields. */
const SHARE_SWITCHES: { key: ShareKey; label: string; on?: string; off?: string }[] = [
  { key: "photo", label: "Show photo", on: "A match sees your photo, if you've added one.", off: "A match sees your initials instead." },
  { key: "bio", label: "Show bio" },
  { key: "age", label: "Show age" },
  { key: "gender", label: "Show gender", on: "Includes your own words, if you add them." },
  { key: "location", label: "Show city" },
  { key: "lookingFor", label: "Show what you're looking for" },
  { key: "cards", label: "Show cards and character", on: "Your cards and the character they give." },
  { key: "interests", label: "Show interests" },
  { key: "mbti", label: "Show MBTI" },
  { key: "workOrSchool", label: "Show work or school", off: "Off unless you turn it on." },
  { key: "education", label: "Show education", off: "Off unless you turn it on." },
];

export function ProfileView() {
  const { profile } = useLive();
  const [fetched, setFetched] = useState<{ profile: OwnProfile | null } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const resolved: OwnProfile | null | undefined = profile !== undefined ? profile : fetched?.profile;

  useEffect(() => {
    if (resolved !== undefined) return;
    const t = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(t);
  }, [resolved]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      setFetched({ profile: await api.getProfile() });
    } catch (err) {
      setRetryError(describeError(err));
    } finally {
      setRetrying(false);
    }
  }

  if (resolved === undefined) {
    return (
      <>
        <PageHeader title="Your profile" />
        {stalled || retryError ? (
          <Notice
            tone="warn"
            title="Your profile hasn't loaded"
            action={
              <Button variant="secondary" onClick={retry} busy={retrying}>
                Try again
              </Button>
            }
          >
            {retryError ?? "It's taking longer than usual. Check your connection and try again."}
          </Notice>
        ) : (
          <Loading label="Loading your profile" />
        )}
      </>
    );
  }

  return <ProfileForm initial={resolved} />;
}

function ProfileForm({ initial }: { initial: OwnProfile | null }) {
  const router = useRouter();
  const { userId, email, setProfile } = useLive();

  // Initialised once from the loaded profile; later profile changes never clobber edits.
  const [setup] = useState(initial === null);
  const [form, setForm] = useState<FormState>(() => (initial ? formFromProfile(initial) : emptyForm()));
  const [baseline, setBaseline] = useState(() => draftKey(initial ? formFromProfile(initial) : emptyForm()));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = draftKey(form) !== baseline;
  const shared = buildShared(form, userId);
  const archetype = liveArchetype(form);

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
    setSaved(false);
  }
  function setSharing(key: keyof FormState["sharing"], value: boolean) {
    setForm((f) => ({ ...f, sharing: { ...f.sharing, [key]: value } }));
    setSaved(false);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setServerError(null);
    setSaved(false);
    const { input, errors: found } = validateForm(form);
    setErrors(found);
    if (!input) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSaving(true);
    try {
      const result = await api.saveProfile(input);
      setProfile(result);
      if (setup) {
        router.push("/encounter");
        return; // stay busy while navigating
      }
      const next = formFromProfile(result);
      setForm(next);
      setBaseline(draftKey(next));
      setSaved(true);
    } catch (err) {
      setServerError(isApiError(err, "invalid_request") ? err.message || describeError(err) : describeError(err));
    }
    setSaving(false);
  }

  const errorCount = Object.keys(errors).filter((k) => k !== "form").length;
  const bioLeft = LIMITS.bio - form.bio.length;

  return (
    <form noValidate onSubmit={onSubmit} className="pb-4">
      {setup ? (
        <PageHeader kicker="Welcome" title="Set up your profile">
          This is what a mutual match will see. Nothing here is visible to anyone else. Only your name is needed;
          everything else is up to you.
        </PageHeader>
      ) : (
        <PageHeader title="Your profile" />
      )}

      <div className="space-y-6">
        <div className="flex gap-3 rounded-card border border-line bg-sunk px-5 py-4">
          <LockIcon className="mt-0.5 shrink-0 text-moss" size={22} />
          <p className="font-display text-lg italic leading-snug">
            Only a mutual match ever sees your profile. There is no public profile, no map, and no browsing. If
            interest isn&rsquo;t mutual, nothing is shared.
          </p>
        </div>

        {/* ---------- Basics ---------- */}
        <Card aria-labelledby="basics-title" className="space-y-6">
          <SectionTitle id="basics-title">Basics</SectionTitle>
          <PhotoPicker
            userId={userId}
            name={form.displayName}
            photoUrl={form.photoUrl}
            onChange={(url) => patch({ photoUrl: url })}
          />
          {errors.photoUrl ? (
            <p role="alert" className="text-sm font-medium text-ember-deep">
              {errors.photoUrl}
            </p>
          ) : null}
          <TextField
            label="Display name"
            hint="Always shown to a match."
            value={form.displayName}
            maxLength={LIMITS.name}
            autoComplete="nickname"
            error={errors.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
          <div className="grid gap-6 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <TextField
              label="Age"
              hint="Optional. 18 or over."
              inputMode="numeric"
              autoComplete="off"
              maxLength={3}
              value={form.age}
              error={errors.age}
              onChange={(e) => patch({ age: e.target.value.replace(/[^\d]/g, "") })}
            />
            <TextField
              label="City"
              hint="Typed by you. Never GPS."
              placeholder="Oakland"
              autoComplete="off"
              maxLength={LIMITS.location}
              value={form.location}
              error={errors.location}
              onChange={(e) => patch({ location: e.target.value })}
            />
          </div>
          <div className="space-y-3">
            <ChoiceChips
              legend="Gender"
              options={GENDER_OPTIONS}
              value={form.gender}
              onChange={(gender) => patch({ gender })}
            />
            <TextField
              label="In your own words"
              hint="Optional. Shown instead of the option above when you add it."
              maxLength={LIMITS.genderWords}
              value={form.genderSelfDescribed}
              error={errors.genderSelfDescribed}
              onChange={(e) => patch({ genderSelfDescribed: e.target.value })}
            />
          </div>
          <ChoiceChips
            legend="What you're looking for"
            options={LOOKING_OPTIONS}
            value={form.lookingFor}
            onChange={(lookingFor) => patch({ lookingFor })}
          />
          <div>
            <TextArea
              label="Bio"
              value={form.bio}
              maxLength={LIMITS.bio}
              rows={4}
              placeholder="A line or two about you."
              error={errors.bio}
              onChange={(e) => patch({ bio: e.target.value })}
            />
            <p
              aria-live="polite"
              className={cx(
                "mt-1 text-right text-sm tabular-nums",
                bioLeft <= 0 ? "font-semibold text-ember-deep" : "text-ink-soft",
              )}
            >
              {form.bio.length} / {LIMITS.bio}
              {bioLeft <= 0 ? " (limit reached)" : ""}
            </p>
          </div>
        </Card>

        {/* ---------- About you ---------- */}
        <Card aria-labelledby="about-title" className="space-y-6">
          <div>
            <SectionTitle id="about-title">About you</SectionTitle>
            <p className="mt-1 text-ink-soft">All optional. Work and education stay private unless you share them.</p>
          </div>
          <TextField
            label="Work or school"
            placeholder="Nurse at a children's hospital"
            maxLength={LIMITS.workOrSchool}
            value={form.workOrSchool}
            error={errors.workOrSchool}
            onChange={(e) => patch({ workOrSchool: e.target.value })}
          />
          <Select
            label="Education"
            value={form.education ?? ""}
            onChange={(v) => patch({ education: (v || null) as Education | null })}
            options={EDUCATION_LEVELS.map((v) => ({ value: v, label: EDUCATION_LABELS[v] }))}
          />
          <ChoiceChips
            legend="MBTI"
            hint="If you know it."
            options={MBTI_OPTIONS}
            value={form.mbti}
            onChange={(mbti) => patch({ mbti })}
            columns={4}
          />
        </Card>

        {/* ---------- Personality cards ---------- */}
        <Card aria-labelledby="cards-title" className="space-y-6">
          <div>
            <SectionTitle id="cards-title">Personality cards</SectionTitle>
            <p className="mt-1 text-ink-soft">
              Up to {MAX_CARDS_PER_DECK} from each deck. Your character comes from what you pick, by fixed rules.
            </p>
          </div>
          <CharacterPanel archetype={archetype} className="sticky top-16 z-10 shadow-card" />
          {errors.cards ? (
            <p role="alert" className="text-sm font-medium text-ember-deep">
              {errors.cards}
            </p>
          ) : null}
          {DECKS.map((d) => (
            <PickChips
              key={d.deck}
              legend={d.title}
              options={d.options}
              selected={form.cards}
              max={MAX_CARDS_PER_DECK}
              onToggle={(id) => patch({ cards: toggleCard(form.cards, id) })}
            />
          ))}
        </Card>

        {/* ---------- Interests ---------- */}
        <Card aria-labelledby="interests-title" className="space-y-4">
          <div>
            <SectionTitle id="interests-title">Interests</SectionTitle>
            <p className="mt-1 text-ink-soft">
              In your own words. The optional &ldquo;Find common ground&rdquo; card looks for overlap here once
              you&rsquo;ve matched.
            </p>
          </div>
          <InterestsEditor interests={form.interests} onChange={(interests) => patch({ interests })} error={errors.interests} />
        </Card>

        {/* ---------- Private details ---------- */}
        <Card aria-labelledby="private-title" className="space-y-6">
          <div>
            <SectionTitle id="private-title">Private details</SectionTitle>
            <p className="mt-1 text-ink-soft">
              Optional. These are hidden unless you turn sharing on for each one, and they are never used for AI
              suggestions.
            </p>
          </div>
          <div className="space-y-3">
            <TextField
              label="Ethnicity"
              maxLength={LIMITS.ethnicity}
              autoComplete="off"
              value={form.ethnicity}
              error={errors.ethnicity}
              onChange={(e) => patch({ ethnicity: e.target.value })}
            />
            <PrivateSwitch form={form} field="ethnicity" onChange={setSharing} />
          </div>
          {(["drinking", "smoking", "drugs"] as const).map((key) => (
            <div key={key} className="space-y-3 border-t border-line pt-5">
              <ChoiceChips
                legend={key === "drinking" ? "Drinking" : key === "smoking" ? "Smoking" : "Drugs"}
                options={HABIT_OPTIONS}
                value={form[key]}
                onChange={(v: HabitFrequency | null) => patch({ [key]: v })}
              />
              <PrivateSwitch form={form} field={key} onChange={setSharing} />
            </div>
          ))}
        </Card>

        {/* ---------- What a match sees ---------- */}
        <Card aria-labelledby="sharing-title" className="space-y-6">
          <div>
            <SectionTitle id="sharing-title">What a match sees</SectionTitle>
            <p className="mt-1 text-ink-soft">You choose, field by field. The preview shows exactly what a match would get.</p>
          </div>
          <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold">Display name</p>
                  <p className="text-sm text-ink-soft">A match always sees your name.</p>
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunk px-3 py-1 text-sm font-medium text-ink-soft">
                  <LockIcon size={12} strokeWidth={2.4} />
                  Always shared
                </span>
              </div>
              {SHARE_SWITCHES.map((s) => (
                <Row key={s.key}>
                  <Switch
                    label={s.label}
                    checked={form.sharing[s.key]}
                    onChange={(v) => setSharing(s.key, v)}
                    description={form.sharing[s.key] ? s.on : s.off}
                  />
                </Row>
              ))}
              <Row>
                <p className="font-semibold">Private details</p>
                <p className="text-sm text-ink-soft">
                  {privateLine(form)}{" "}
                  <a href="#private-title" className="font-medium text-ink underline underline-offset-4">
                    Change in Private details
                  </a>
                </p>
              </Row>

              <div className="border-t border-line pt-5">
                <h3 className="font-display text-xl leading-tight">Common-ground suggestions</h3>
                <div className="mt-1 space-y-2 text-sm text-ink-soft">
                  <AiExplainer form={form} />
                </div>
                <div className="mt-4">
                  <Switch
                    label="Allow Claude to suggest common ground"
                    checked={form.sharing.aiAssist}
                    onChange={(v) => setSharing("aiAssist", v)}
                    description={form.sharing.aiAssist ? "On. Only when someone taps the button." : "Off."}
                  />
                </div>
              </div>
            </div>

            <div className="self-start sm:sticky sm:top-20">
              <p className="mb-2 text-sm font-semibold text-ink-soft">Preview</p>
              <MatchPreview shared={shared} />
              <SeenSummary form={form} />
            </div>
          </div>
        </Card>

        <Card aria-labelledby="account-title" className="space-y-4">
          <SectionTitle id="account-title">Account</SectionTitle>
          <p className="text-ink-soft">
            {isGuestEmail(email) ? (
              <>
                Signed in as <span className="font-semibold text-ink">a guest</span>. Guest accounts
                have no email or password and are for the demo; they may be removed afterwards.
              </>
            ) : (
              <>
                Signed in as{" "}
                <span className="break-all font-semibold text-ink">{email ?? "your account"}</span>
              </>
            )}
          </p>
          <SignOutButton variant="secondary" />
        </Card>
      </div>

      <div
        className={cx(
          "z-20 mt-6 space-y-3 rounded-card border border-line-strong bg-surface/95 p-3 shadow-card backdrop-blur sm:p-4",
          // Float over the form only while there is something to save.
          (setup || dirty || saving) && "sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] sm:bottom-4",
        )}
      >
        {serverError ? <Notice tone="error">{serverError}</Notice> : null}
        {errorCount > 0 && !serverError ? (
          <Notice tone="error">
            {errorCount === 1 ? "One field needs a change." : `${errorCount} fields need a change.`} They&rsquo;re marked
            above.
          </Notice>
        ) : null}
        {saved && !dirty ? (
          <Notice tone="good">Saved. A match sees the updated version.</Notice>
        ) : (
          <div role="status" className="sr-only" />
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-soft sm:order-1">
            {setup ? "You can change any of this later." : dirty ? "You have unsaved changes." : "Everything is saved."}
          </p>
          <Button type="submit" full busy={saving} disabled={!setup && !dirty} className="sm:order-2 sm:w-auto">
            {setup ? "Save and continue" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="border-t border-line pt-4">{children}</div>;
}

const PRIVATE_SWITCH_LABELS: Record<(typeof SENSITIVE_KEYS)[number], string> = {
  ethnicity: "Show my ethnicity to a match",
  drinking: "Show drinking to a match",
  smoking: "Show smoking to a match",
  drugs: "Show drug use to a match",
};

function PrivateSwitch({
  form,
  field,
  onChange,
}: {
  form: FormState;
  field: (typeof SENSITIVE_KEYS)[number];
  onChange: (key: ShareKey, value: boolean) => void;
}) {
  const on = form.sharing[field];
  return (
    <div className="rounded-xl bg-sunk px-4 py-3">
      <Switch
        label={PRIVATE_SWITCH_LABELS[field]}
        checked={on}
        onChange={(v) => onChange(field, v)}
        description={on ? "A match will see this." : "Hidden. This is the default."}
      />
    </div>
  );
}

function privateLine(form: FormState): string {
  const on = SENSITIVE_KEYS.filter((k) => form.sharing[k]).map((k) => SHARE_FIELD_NAMES[k]);
  return on.length === 0
    ? "Ethnicity, drinking, smoking and drug use are hidden."
    : `Shared: ${joinAnd(on)}. The rest are hidden.`;
}

function AiExplainer({ form }: { form: FormState }) {
  if (!form.sharing.aiAssist) {
    return (
      <p>
        Off. Nothing from your profile is sent to the AI, and the &ldquo;Find common ground&rdquo; card won&rsquo;t
        use anything from your profile.
      </p>
    );
  }
  const sent = aiSendable(form);
  return (
    <>
      <p>
        When you or your match taps &ldquo;Find common ground&rdquo; after you&rsquo;ve matched, the fields you share
        may be sent to Claude, an AI model by Anthropic. It suggests common ground and one opening question. It never
        sends messages and never reads your conversation.
      </p>
      <p>
        <span className="font-semibold text-ink">Can be sent now:</span>{" "}
        {sent.length ? `${joinAnd(sent)}.` : "nothing yet. Fill in and share a field first."}
      </p>
      <p>
        <span className="font-semibold text-ink">Never sent, whatever you share:</span>{" "}
        {joinAnd([...aiNeverSent(), "your photo", "your messages"])}.
      </p>
    </>
  );
}

function SeenSummary({ form }: { form: FormState }) {
  const { will, wont } = shareSummary(form);
  return (
    <div className="mt-4 space-y-2 text-sm">
      <p>
        <span className="font-semibold">They will see:</span> {will.join(", ")}.
      </p>
      <p>
        <span className="font-semibold">They won&rsquo;t see:</span>{" "}
        {wont.length ? `${wont.join(", ")}.` : "nothing is held back."}
      </p>
      <p className="text-ink-soft">Your email is never shown.</p>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-semibold">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full appearance-none rounded-xl border border-line-strong bg-white py-3 pl-4 pr-10 text-base text-ink focus:border-ember focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember"
        >
          <option value="">Not set</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-soft"
        >
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

function LockIcon({ size, className, strokeWidth = 2 }: { size: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth={strokeWidth} />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}
