import { parseIntroName } from "@cue/contracts";
import { isApiError } from "./api";
import type { ListenOutcome, RecognitionProblem } from "./speech";

/**
 * The "Say hi" guest entry, as plain data: what to do with a transcript or a
 * typed line, what each problem means, and what the status region says.
 */

export const GUEST_PROMPT = "Hi, my name is …";

/** What to do with what someone said or typed. */
export type IntroDecision =
  | { action: "create"; intro: string; name: string }
  | { action: "no_name"; heard: string }
  | { action: "empty" };

export function decideIntro(text: string): IntroDecision {
  const intro = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!intro) return { action: "empty" };
  const name = parseIntroName(intro);
  return name ? { action: "create", intro, name } : { action: "no_name", heard: intro };
}

/** Problems from the server when creating the guest account. */
export type GuestRequestProblem = "no_name" | "rate_limited" | "off" | "network" | "failed";

export function guestRequestProblem(err: unknown): GuestRequestProblem {
  if (isApiError(err, "invalid_request") || (isApiError(err) && err.status === 400)) return "no_name";
  if (isApiError(err, "rate_limited") || (isApiError(err) && err.status === 429)) return "rate_limited";
  if (isApiError(err, "not_found") || (isApiError(err) && err.status === 404)) return "off";
  if (isApiError(err, "network") || isApiError(err, "timeout")) return "network";
  return "failed";
}

export type GuestPhase =
  | { kind: "idle" }
  | { kind: "listening"; heard: string }
  | { kind: "creating"; heard: string | null; name: string }
  | { kind: "in"; name: string }
  | { kind: "no_name"; heard: string }
  | { kind: "listen_problem"; problem: RecognitionProblem; heard: string }
  | { kind: "request_problem"; problem: Exclude<GuestRequestProblem, "off">; heard: string | null };

/** Where a finished listen leads. */
export function phaseAfterListen(outcome: ListenOutcome): GuestPhase {
  if (outcome.kind === "problem") {
    if (outcome.problem === "aborted") return { kind: "idle" };
    return { kind: "listen_problem", problem: outcome.problem, heard: outcome.heard };
  }
  const d = decideIntro(outcome.transcript);
  if (d.action === "create") return { kind: "creating", heard: d.intro, name: d.name };
  if (d.action === "no_name") return { kind: "no_name", heard: d.heard };
  return { kind: "listen_problem", problem: "no_speech", heard: "" };
}

export function listenProblemText(problem: RecognitionProblem): string {
  switch (problem) {
    case "unsupported":
      return "Voice entry isn't available in this browser. Type your name below instead.";
    case "denied":
      return "Cue can't use the microphone. Allow it for this site in your browser settings and try again, or type your name below.";
    case "no_microphone":
      return "No microphone was found. Connect one and try again, or type your name below.";
    case "no_speech":
      return "Didn't hear anything. Tap Say hi and speak right away, or type your name below.";
    case "network":
      return "Speech recognition needs a connection and couldn't reach its service. Check your connection and try again, or type your name below.";
    case "aborted":
      return "Stopped listening.";
    default:
      return "Listening didn't work this time. Try again, or type your name below.";
  }
}

export function requestProblemText(problem: GuestRequestProblem): string {
  switch (problem) {
    case "no_name":
      return "Cue couldn't pick a name out of that. Try 'Hi, my name is Sam', or just your first name.";
    case "rate_limited":
      return "Too many guest accounts from here just now. Wait a minute and try again, or create an account with an email.";
    case "off":
      return "Guest entry is switched off right now. Sign in or create an account with an email below.";
    case "network":
      return "Can't reach Cue right now. Check your connection and try again.";
    default:
      return "Couldn't create your guest account. Try again in a moment.";
  }
}

export const welcomeLine = (name: string) => `Yo ${name}, you're in.`;

/** The lines the live status region shows for a phase. Empty for idle. */
export function statusLines(phase: GuestPhase): string[] {
  const heardLine = (h: string | null) => (h ? `Heard: “${h}”` : null);
  const lines: (string | null)[] = (() => {
    switch (phase.kind) {
      case "idle":
        return [];
      case "listening":
        return [
          `Listening… Say '${GUEST_PROMPT}'`,
          phase.heard ? heardLine(phase.heard) : null,
        ];
      case "creating":
        return [heardLine(phase.heard), `Name: ${phase.name}`, "Getting you in…"];
      case "in":
        return [welcomeLine(phase.name)];
      case "no_name":
        return [
          heardLine(phase.heard),
          "Couldn't pick out a name in that. Try again and say 'Hi, my name is …', or type it below.",
        ];
      case "listen_problem":
        return [heardLine(phase.heard || null), listenProblemText(phase.problem)];
      case "request_problem":
        return [heardLine(phase.heard), requestProblemText(phase.problem)];
    }
  })();
  return lines.filter((l): l is string => typeof l === "string" && l.length > 0);
}
