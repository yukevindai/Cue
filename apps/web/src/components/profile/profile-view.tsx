"use client";

import type { OwnProfile } from "@cue/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
  buildShared,
  draftKey,
  emptyForm,
  formFromProfile,
  LIMITS,
  validateForm,
  type FieldErrors,
  type FormState,
} from "./form";
import { InterestsEditor } from "./interests-editor";
import { LinksEditor } from "./links-editor";
import { MatchPreview } from "./match-preview";
import { PhotoPicker } from "./photo-picker";

const STALL_MS = 8_000;

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
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
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
          This is what a mutual match will see. Nothing here is visible to anyone else.
        </PageHeader>
      ) : (
        <PageHeader title="Your profile" />
      )}

      <div className="space-y-6">
        <div className="flex gap-3 rounded-card border border-line bg-sunk px-5 py-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-moss">
            <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
            <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p className="font-display text-lg italic leading-snug">
            Only a mutual match ever sees your profile. There is no public profile, no map, and no browsing. If
            interest isn&rsquo;t mutual, nothing is shared.
          </p>
        </div>

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

        <Card aria-labelledby="interests-title" className="space-y-4">
          <div>
            <SectionTitle id="interests-title">Interests</SectionTitle>
            <p className="mt-1 text-ink-soft">
              The optional &ldquo;Find common ground&rdquo; card looks for overlap here once you&rsquo;ve matched.
            </p>
          </div>
          <InterestsEditor
            interests={form.interests}
            onChange={(interests) => patch({ interests })}
            error={errors.interests}
          />
        </Card>

        <Card aria-labelledby="links-title" className="space-y-4">
          <div>
            <SectionTitle id="links-title">Links</SectionTitle>
            <p className="mt-1 text-ink-soft">
              Optional. Up to {LIMITS.links} links to wherever you&rsquo;d like a match to find you. Empty rows are
              dropped when you save.
            </p>
          </div>
          <LinksEditor links={form.links} onChange={(links) => patch({ links })} errors={errors} />
        </Card>

        <Card aria-labelledby="sharing-title" className="space-y-6">
          <div>
            <SectionTitle id="sharing-title">What a match sees</SectionTitle>
            <p className="mt-1 text-ink-soft">
              You choose, field by field. The preview shows exactly what a match would get.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold">Display name</p>
                  <p className="text-sm text-ink-soft">A match always sees your name.</p>
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-sunk px-3 py-1 text-sm font-medium text-ink-soft">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="2.4" />
                    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                  Always shared
                </span>
              </div>
              <Row>
                <Switch
                  label="Photo"
                  checked={form.sharing.photo}
                  onChange={(v) => setSharing("photo", v)}
                  description={
                    form.sharing.photo
                      ? "A match sees your photo, if you've added one."
                      : "A match sees your initials instead of a photo."
                  }
                />
              </Row>
              <Row>
                <Switch
                  label="Bio"
                  checked={form.sharing.bio}
                  onChange={(v) => setSharing("bio", v)}
                  description={form.sharing.bio ? "A match can read your bio." : "Your bio stays private."}
                />
              </Row>
              <Row>
                <Switch
                  label="Interests"
                  checked={form.sharing.interests}
                  onChange={(v) => setSharing("interests", v)}
                  description={
                    form.sharing.interests ? "A match sees your interests." : "Your interests stay private."
                  }
                />
              </Row>
              <Row>
                <Switch
                  label="Links"
                  checked={form.sharing.socialLinks}
                  onChange={(v) => setSharing("socialLinks", v)}
                  description={
                    form.sharing.socialLinks
                      ? "A match can see your links."
                      : "Your links stay private. This is the default."
                  }
                />
              </Row>

              <div className="border-t border-line pt-5">
                <h3 className="font-display text-xl leading-tight">Common-ground suggestions</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  {form.sharing.aiAssist
                    ? "When you or your match taps “Find common ground” after you’ve matched, the fields you share above may be sent to Claude, an AI model by Anthropic. It suggests shared interests and one opening question. It never sends messages and never sees your conversations."
                    : "Your profile text is never sent to the AI. The “Find common ground” card won’t use anything from your profile."}
                </p>
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

            <div className="self-start sm:sticky sm:top-6">
              <p className="mb-2 text-sm font-medium uppercase tracking-[0.16em] text-ink-soft">Preview</p>
              <MatchPreview shared={shared} />
              <SeenSummary shared={shared} form={form} />
            </div>
          </div>
        </Card>

        <Card aria-labelledby="account-title" className="space-y-4">
          <SectionTitle id="account-title">Account</SectionTitle>
          <p className="text-ink-soft">
            Signed in as <span className="break-all font-semibold text-ink">{email ?? "your account"}</span>
          </p>
          <SignOutButton variant="secondary" />
        </Card>
      </div>

      <div
        className={cx(
          "z-10 mt-6 space-y-3 rounded-card border border-line-strong bg-surface/95 p-3 shadow-card backdrop-blur sm:p-4",
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
            {setup
              ? "You can change any of this later."
              : dirty
                ? "You have unsaved changes."
                : "Everything is saved."}
          </p>
          <Button
            type="submit"
            full
            busy={saving}
            disabled={!setup && !dirty}
            className="sm:order-2 sm:w-auto"
          >
            {setup ? "Save and continue" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="border-t border-line pt-5">{children}</div>;
}

function SeenSummary({ shared, form }: { shared: ReturnType<typeof buildShared>; form: FormState }) {
  const fields: { name: string; on: boolean; has: boolean }[] = [
    { name: "photo", on: form.sharing.photo, has: shared.photoUrl !== null },
    { name: "bio", on: form.sharing.bio, has: !!shared.bio },
    { name: "interests", on: form.sharing.interests, has: shared.interests.length > 0 },
    { name: "links", on: form.sharing.socialLinks, has: shared.socialLinks.length > 0 },
  ];
  const will = ["name", ...fields.filter((f) => f.on && f.has).map((f) => f.name)];
  const wont = fields.filter((f) => !(f.on && f.has)).map((f) => (f.on ? `${f.name} (none added)` : f.name));
  return (
    <div className="mt-4 space-y-2 text-sm">
      <p>
        <span className="font-semibold">They will see:</span> {will.join(", ")}.
      </p>
      <p>
        <span className="font-semibold">They won&rsquo;t see:</span> {wont.length ? `${wont.join(", ")}.` : "nothing is held back."}
      </p>
      <p className="text-ink-soft">Your email is never shown.</p>
    </div>
  );
}
