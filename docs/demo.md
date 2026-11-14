# Cue demo runbook

Target length: 90 seconds, plus questions. Source of truth for behavior:
`docs/spec.md` section 7. This runbook must not promise more than the build does.

**Hardware caveat.** The glasses swipe is not verified in this repository. Check
`docs/hardware-check.md` before the demo. If it does not record a verified
backward swipe reaching the server under the correct account, say so openly and
use the fallback in this file. A button, a test event, or a web input is not the
glasses path and must not be presented as one.

## Before the demo

Setup checklist:

- [ ] Docker is running and `pnpm install` has completed.
- [ ] `pnpm stack:start` has completed, and `apps/web/.env.local` contains the
      three Supabase values.
- [ ] `ANTHROPIC_API_KEY` is set in `apps/web/.env.local` (server only). Without
      it the Claude card shows a retry or error state. Matching still works.
- [ ] `pnpm dev` is running; the app loads at http://localhost:3000.
- [ ] `pnpm stack:reset` has been run, so the seed data is fresh.
- [ ] Two browsers or devices are signed in: one as `alex@cue.demo` and one as
      `sam@cue.demo` (password `cue-demo-123`).
- [ ] The glasses are paired to Alex. Generate a pairing code in the web app as
      Alex and complete the pairing on the glasses side with that code.
- [ ] Alex creates a demo session in the web app. Sam joins with the join code
      shown for that session.
- [ ] Encounter mode is on for both Alex and Sam.
- [ ] Riley (`riley@cue.demo`) is available on a third browser for the rejection
      question, but is not part of the demo.
- [ ] `docs/hardware-check.md` has been read, and the glasses status is known.

## The 90-second script

| Time | Action | What to say |
|---|---|---|
| 0:00 - 0:10 | Show Alex's and Sam's profiles and the active demo session in the web app. | "These are two synthetic demo accounts in one isolated two-person session. Cue only matches people inside that session." |
| 0:10 - 0:25 | Point at encounter mode on both accounts. | "Both people have turned encounter mode on. Each signal can only target the other person in this session." |
| 0:25 - 0:40 | Alex makes a backward swipe along the glasses' temple strip, as if brushing back a stray hair. Show that no match appears. | "Alex signals interest. Sam gets no notification about it, and no match appears yet." If the glasses path is not verified, say so here instead of implying it works. |
| 0:40 - 0:55 | Sam taps "Interested" in the web app. | "Sam is the second person. The web app is the second input because there is only one pair of glasses." |
| 0:55 - 1:10 | Show the match on both screens: approved profile details, encounter time, and venue label. | "Both signals arrived within 15 seconds, so the server created one match. Each person sees only the fields they approved for sharing." |
| 1:10 - 1:25 | Tap "Find common ground" on one screen. Show the shared interests and the optional opening question. | "Claude only sees the profile fields each person approved for sharing and for AI assistance, plus the venue label. It suggests a starting point and does not join the conversation." |
| 1:25 - 1:30 | Stop the demo. Let the participants talk. | "From here the conversation is theirs. Cue does not listen or reply." |

## What to say about the pre-scoped pair and the one-glasses limitation

Read aloud, in plain words:

"Only one pair of glasses is available, so one person uses the glasses and the
other uses the web app. The organizer placed exactly these two accounts in an
isolated session, and each signal can only target the other person. This is a
controlled demo. It is not a way to pick one person out of a crowd, and where
two people are standing does not prove who either of them meant."

## Reset between runs

Use either option:

- Demo reset in the web app, if it is available for the signed-in account.
  Then start the flow again from the session step.
- `pnpm stack:reset` from the repository root. This re-applies migrations and
  seed data and clears demo state for all accounts. Restart `pnpm dev` if it
  was stopped.

After a reset, sign in again and create or join a new session. Re-check that
encounter mode is on for both accounts.

Keep an expiry example ready for questions:

1. Alex signals (backward swipe, or the test path if the glasses are not
   verified; say which one is used).
2. Wait 15 seconds without any response from Sam.
3. Sam taps "Interested".
4. Result: no match. Alex's earlier signal has expired and is not replayed.

## Fallbacks

| Failure | What to do |
|---|---|
| Venue Wi-Fi is down | Use a phone hotspot for the laptop that runs the web app. If the glasses bridge needs the network, put it on the same hotspot. Or run everything on one laptop with the local stack (`pnpm stack:start` and `pnpm dev` on localhost). Confirm before the demo which parts need the network. |
| Glasses are unlinked, or the swipe does not arrive | Generate a new pairing code in the web app and pair the glasses again. If the hardware path cannot be recovered in the time available, say so openly. Then show the web input for both sides, and state clearly that this is not the glasses path and does not test the swipe. |
| Claude times out or returns an error | The card shows a retry state. Tap retry once. If it fails again, move on. Matching is not affected. |
| Realtime notification is late | Refresh the matches page. The match is stored and appears after a refresh. |
| A third person asks about joining | Sign in as Riley (`riley@cue.demo`) on a separate browser. The join is rejected because the session is full (`session_full`). Riley sees no session, profile, or match data from Alex and Sam. |

## Likely questions

**Does Sam know when Alex signals?**
No. A one-sided signal is not shown to the other person. There is no
notification, count, or timing signal for Sam. Sam only sees a match when both
signals have arrived within 15 seconds.

**What does Claude see?**
Only the profile fields that each person approved for sharing and for AI
assistance, plus the coarse venue label. It does not hear the conversation,
does not send messages, and does not reply to either person. Profile text is
treated as data, not instructions. The card is shown only to the person who
asked for it.

**Why 15 seconds?**
It is the proposed matching window in `docs/spec.md` (section 3). It keeps the
two signals close together in time, so a match means both people signaled
around the same moment. It is a proposed default, not a measured value.
