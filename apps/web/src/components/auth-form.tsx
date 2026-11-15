"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { safeReturnPath } from "@/lib/encounter";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { Button, Notice, TextField } from "@/components/ui";

type Mode = "sign-in" | "sign-up";

const MIN_PASSWORD = 6;
const DEMO_PASSWORD = "cue-demo-123";
const DEMO_EMAILS = ["alex@cue.demo", "sam@cue.demo", "riley@cue.demo"];

interface Problem {
  tone: "error" | "good";
  text: string;
  showSignInLink?: boolean;
}

export function AuthForm({ mode }: { mode: Mode }) {
  const isSignIn = mode === "sign-in";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [message, setMessage] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const trimmed = email.trim();

    let eErr: string | null = null;
    let pErr: string | null = null;
    if (!trimmed) eErr = "Enter your email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      eErr = "That doesn't look like an email address. Check for typos.";
    if (!password) pErr = "Enter your password.";
    else if (!isSignIn && password.length < MIN_PASSWORD)
      pErr = `Use at least ${MIN_PASSWORD} characters for your password.`;
    setEmailError(eErr);
    setPasswordError(pErr);
    setMessage(null);
    if (eErr || pErr) return;

    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      if (isSignIn) {
        const { error } = await supabase.auth.signInWithPassword({ email: trimmed, password });
        if (error) {
          setMessage({
            tone: "error",
            text: /invalid login credentials/i.test(error.message)
              ? "That email and password don't match. Check them and try again."
              : plainSentence(error.message),
          });
          setBusy(false);
          return;
        }
        // Back to where they were going (a venue's QR link, say), same-origin only.
        const next = safeReturnPath(new URLSearchParams(window.location.search).get("next"));
        // Full navigation on purpose: server-rendered state must reset.
        window.location.assign(next);
        return;
      }

      const { data, error } = await supabase.auth.signUp({ email: trimmed, password });
      if (error) {
        const registered =
          /already registered/i.test(error.message) || error.code === "user_already_exists";
        setMessage(
          registered
            ? { tone: "error", text: "That email is already registered.", showSignInLink: true }
            : { tone: "error", text: plainSentence(error.message) },
        );
        setBusy(false);
        return;
      }
      if (data.session) {
        // Full navigation on purpose: server-rendered state must reset.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/profile");
        return;
      }
      setMessage({ tone: "good", text: "Check your email to confirm your account, then sign in." });
      setBusy(false);
    } catch {
      setMessage({
        tone: "error",
        text: "Couldn't reach the server. Check your connection and try again.",
      });
      setBusy(false);
    }
  }

  function fillDemo(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setEmailError(null);
    setPasswordError(null);
    setMessage(null);
  }

  return (
    <div className="animate-rise">
      <h1 className="font-display text-3xl leading-tight tracking-tight">
        {isSignIn ? "Sign in" : "Create your account"}
      </h1>
      <p className="mt-1 text-ink-soft">
        {isSignIn ? "Welcome back." : "An email and a password is all it takes."}
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
        />
        <div>
          <TextField
            label="Password"
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete={isSignIn ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={isSignIn ? undefined : `At least ${MIN_PASSWORD} characters.`}
            error={passwordError}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-pressed={showPassword}
            className="mt-2 min-h-9 rounded-full text-sm font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
          >
            {showPassword ? "Hide password" : "Show password"}
          </button>
        </div>

        {message ? (
          <Notice
            tone={message.tone}
            action={
              message.showSignInLink ? (
                <Link href="/sign-in" className="font-semibold underline underline-offset-4">
                  Sign in instead
                </Link>
              ) : undefined
            }
          >
            {message.text}
          </Notice>
        ) : null}

        <Button type="submit" size="lg" full busy={busy}>
          {busy ? (isSignIn ? "Signing in" : "Creating account") : isSignIn ? "Sign in" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-ink-soft">
        {isSignIn ? "New to SocialEyes? " : "Already have an account? "}
        <Link
          href={isSignIn ? "/sign-up" : "/sign-in"}
          className="font-semibold text-ink underline underline-offset-4"
        >
          {isSignIn ? "Create an account" : "Sign in"}
        </Link>
      </p>

      {isSignIn ? (
        <details className="mt-6 rounded-2xl border border-line bg-surface px-4 py-3">
          <summary className="cursor-pointer py-1 font-medium">Demo accounts</summary>
          <p className="mt-2 text-sm text-ink-soft">
            Synthetic accounts for the live demo, not real people. Choose one to fill in the form,
            then sign in.
          </p>
          <ul className="mt-3 space-y-2">
            {DEMO_EMAILS.map((demoEmail) => (
              <li key={demoEmail}>
                <Button
                  variant="secondary"
                  full
                  onClick={() => fillDemo(demoEmail)}
                  aria-label={`Fill in demo account ${demoEmail}`}
                >
                  {demoEmail}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Turn a Supabase message into a plain sentence. */
function plainSentence(message: string): string {
  const text = message.trim();
  if (!text) return "Couldn't complete that. Try again in a moment.";
  const cased = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}
