# Glasses Dating — Hackathon Spec

Draft v0.4 · Immerse the Bay · November 14, 2026 · Team of four

**Pitch:** Meet someone in real life. Make a small gesture. If the interest is mutual, reconnect later with their profile and a reminder of where you met.

## 1. Product and problem

A dating-first social network that starts with real-world attraction. People signal interest through their smart glasses; mutual interest unlocks a connection in the web app, including chosen profile details and the encounter’s time and place.

The product hypothesis: people want a lower-pressure way to act on an in-person spark without immediately asking for contact information. Endless feeds, uncertain reciprocity, and awkward introductions are the frustrations this experience aims to address. The prototype does not establish that users are identity-verified or bot-free.

**Confirmed scope:** dating and attraction; one Mentra Live; a controlled two-person demo. Product name is undecided. The parameters below are proposed defaults.

## 2. Core experience

1. **Set up:** Each participant creates a profile with a display name, photo, short bio, interests, and optional social links. They choose which fields a mutual match can see.
2. **Become available:** Both explicitly enable encounter mode. Availability is easy to pause; there is no public map of nearby people.
3. **Signal interest:** Person A sees Person B and slides a finger backward along the glasses’ side touch strip, toward the ear, like brushing back a stray hair. A receives a brief acknowledgement; B receives no unsolicited interest notification.
4. **Reciprocate:** B independently signals within the matching window. In this demo, B uses an explicit “Interested” button in the web app because only one pair of glasses is available.
5. **Match:** Both receive an in-app ping and a match card. A short glasses audio cue is desirable if supported by the tested integration.
6. **Reconnect:** The card shows the other person’s approved profile, encounter time, and venue label. An optional “Find common ground” action highlights intersecting interests and offers a short conversation starter. Users can open shared social links, unmatch, or block.

If interest is not mutual, no profile is exchanged and the pending signal quietly expires. The first signal does not ask the other person to respond.

## 3. Matching contract and limitation

**Location establishes possible proximity, not the identity of the person someone intended to choose.** Two nearby gestures cannot prove mutual attraction in a crowd.

For the hackathon, the organizer places exactly two consenting accounts in an isolated demo session. Each signal targets the sole other participant. This deliberately constrains the candidate set; it is not automatic crowd identification.

| Rule | Proposed behavior |
|---|---|
| Eligibility | Both accounts are active in the same two-person demo session; neither has blocked the other. |
| Reciprocity | Two distinct users signal within 15 seconds, measured by server receipt time. Either can go first. |
| One gesture | One pending signal; repeated device events do not create additional interest or matches. |
| Completion | Create one shared match atomically, consume both signals, and notify both accounts. |
| Expiry or disconnect | Expire pending interest; require a fresh gesture after reconnecting. Do not replay offline interest. |
| Third participant | Reject entry to the active two-person session. Never choose a random or nearest account. |
| Encounter record | Store the first signal’s time and the session venue label; label manually supplied location honestly. |

Capture phone-provided location, accuracy, and freshness only with permission if feasible. Treat it as optional encounter context in this demo. Do not use an arbitrary GPS radius as proof of person-to-person targeting. If unavailable, retain the explicit venue label; no fabricated coordinates.

## 4. MVP and boundaries

**Required:** profile setup and sharing controls; account-to-device association; encounter-mode toggle; working backward touch-strip swipe; second-user web input; reciprocal matching; live in-app notifications; persistent match cards; on-demand Claude wingman card; unmatch/block; clean demo reset. Complete swipe-to-match before adding the wingman.

**Three web views:** profile/setup, encounter status, and matches with profile detail. The encounter view shows connection status and the user’s own pending signal, without exposing incoming one-sided interest.

**Deferred:** camera gesture recognition, snapping, visual verification, crowded-room targeting, a second glasses ecosystem, compatibility ranking, chat, feeds, and background mobile push notifications. Future camera verification must be separately designed and evaluated; it is not a solved identification feature.

Profiles are visible only to matched accounts, even when their fields are described as “public.” Pending signals and precise location are temporary; retain only the matched encounter’s time and coarse venue. Unmatching removes in-app access, though already viewed information cannot be recalled. Use consenting adult demo participants.

## 5. Technical approach and first checkpoint

**Proposed stack:** Next.js with TypeScript for the web UI and server API routes; Supabase for authentication, persistent records, and realtime updates; Anthropic’s Claude Messages API for the wingman. A separate Mentra integration associates the glasses session with the signed-in user and forwards normalized interest events. Both glasses and web inputs use the same matching service. Keep the API inside the web app for the MVP.

Minimum records: profiles, device associations, demo-session memberships, expiring interest events, matches, and blocks. Authenticate each event source; enforce profile access and matching rules on the server.

**Input requirement:** one deliberate backward finger swipe on the temple touch strip means “interested.” This is touch sensing, like a laptop touchpad; no head movement, IMU inference, camera, or hand tracking is required. Forward swipes, taps, and other gestures do not submit interest. The hair-fixing motion is the intended interaction style, not a separate gesture classifier.

Mentra documents a touch swipe bar and Bluetooth SDK `touch_event` events carrying `gestureName`. Map the verified backward-swipe event to one interest event; confirm the physical direction on the loaner. Enable this mapping only in encounter mode, apply a proposed one-second debounce, and acknowledge accepted input. Test ordinary hair adjustments for accidental activation. Check for conflicts with stock media controls and claim/restore the gesture where the installed firmware supports it.

**First checkpoint after build approval:** demonstrate an actual backward swipe reaching the server under the correct account. Confirm SDK access on the loaner before choosing the Mentra runtime. Prefer the onsite-supported miniapp route if it exposes this event; otherwise use a minimal native/React Native Bluetooth bridge. A browser alone is not the assumed glasses bridge. A button or simulated event does not satisfy the swipe requirement; if access is blocked, flag that dependency explicitly.

Mentra Live has no display. Put visual profiles and match cards in the web app; use audio for glasses feedback if validated. Do not promise an AR overlay.

**Claude wingman — common ground and introductions:** a Ditto-inspired introduction assistant for people who have already expressed mutual interest in person. After a confirmed match, “Find common ground” highlights intersecting interests from both approved profiles and offers one optional opening question. Example: both profiles mention hiking; show “You both enjoy hiking” and “What’s a trail you’d happily do again?” Recognize related interests without overstating them: café exploration and latte art support a shared interest in coffee, not an invented shared hobby. If no overlap is supported, say so and optionally offer a neutral opener based on the encounter context. Use only profile text approved for sharing and AI assistance, plus coarse venue context.

**Product boundary:** Claude helps users begin, then leaves the conversation to them. It does not listen to ongoing conversations, generate continuing replies, send messages, impersonate users, or steer the exchange. No conversational agent or live coaching loop is included. Users decide whether to use, adapt, or ignore the opener.

The authenticated `POST /api/matches/[id]/suggestions` route verifies active match membership and sharing settings, then calls Anthropic’s `POST /v1/messages` from the server. Use the TypeScript SDK, server-only `ANTHROPIC_API_KEY`, and configurable `ANTHROPIC_MODEL`; select and pin an available model during implementation. Request structured output: `shared_interests` (each with evidence from both profiles), `suggested_question`, and `opener_basis` (`shared_interest` or `encounter_context`). Validate grounding as well as format; treat profile text as data, never as instructions. Do not invent interests, compatibility scores, attraction, or venue facts.

Cache results per match, requesting user, and profile version. Recheck access before serving cached results; invalidate on unmatch/block or sharing changes. Rate-limit requests and show a retry state on timeout or failure. Matching never waits for Claude. Suggestions are displayed only to the requesting user and never sent automatically. Date planning is outside this scope. Optional spoken delivery of the same one-time opener remains a stretch feature; ongoing coaching is excluded.

## 6. Proposed GitHub repository

Use one TypeScript monorepo with pnpm workspaces. Repository name is provisional: `glasses-dating`. These are proposed paths only; no repository or application files have been created.

| Path | Contents / responsibility |
|---|---|
| `apps/web/src/app/` | Profile, encounter, and matches pages; API routes under `api/`. |
| `apps/web/src/app/api/interest/route.ts` | Shared authenticated interest endpoint for glasses and web inputs. |
| `apps/web/src/components/` | Profile editor, connection status, match cards, notification UI. |
| `apps/web/src/server/` | Account linking, matching orchestration, database access, authorization; server-only. |
| `apps/web/src/server/ai/wingman.ts` | Claude client, prompt, output validation, and suggestion caching. |
| `apps/web/src/app/api/matches/[id]/suggestions/route.ts` | Authenticated, rate-limited wingman endpoint. |
| `apps/mentra/src/` | Glasses runtime entry point, `touch-events.ts`, `account-link.ts`, `feedback.ts`, and `api-client.ts`; native host folders only if the Bluetooth route is chosen. |
| `packages/contracts/src/` | Shared event types and validation schemas; no credentials or database access. |
| `packages/contracts/src/wingman.ts` | Wingman response schema, including supporting profile-field references. |
| `packages/matching/src/` | Server-only eligibility, expiry, and duplicate-handling rules with focused tests. |
| `supabase/migrations/` | Tables, access policies, and transaction/function for atomic match creation. |
| `supabase/seed.sql` | Synthetic demo data only. |
| `tests/e2e/` | Two-account match, expiry, duplicate input, blocked account, and access checks. |
| `docs/` | `spec.md`, `hardware-check.md` for tested SDK/firmware and gesture mapping, and `demo.md`. |
| `.github/workflows/ci.yml` | Typecheck, lint, focused tests, and web build on pull requests. |
| Root files | `README.md`, `package.json`, `pnpm-workspace.yaml`, lockfile, `.gitignore`, and `.env.example` with placeholder values. |

**Shared contract:** `InterestEvent` contains `eventId`, `encounterSessionId`, `source` (`mentra_touch` or `web_demo`), `gesture` (`backward_swipe` or `web_confirm`), and `occurredAt`. These are application-owned labels. The API derives the user from authentication, validates session membership, and adds `receivedAt` for the matching window; it never trusts a client-supplied user ID. Acknowledgement states are accepted, duplicate, or rejected; full match details arrive through authorized realtime updates. Never expose service credentials to web or glasses clients.

**Ownership:** hardware owns `apps/mentra`; backend owns `server`, `packages/matching`, and `supabase`; frontend owns web pages/components; integration owns end-to-end tests, CI, and demo docs. Agree on `packages/contracts` together before parallel implementation. Use short feature branches and PRs into `main`; keep `main` demo-ready.

## 7. Four-person ownership and demo

| Owner | Responsibility | First deliverable |
|---|---|---|
| 1 — Hardware | Mentra pairing, backward touch-swipe capture, account association, audio | Real backward swipe reaches the server. |
| 2 — Backend | Matching, persistence, authorization, expiry, blocks | Two authenticated inputs create exactly one match. |
| 3 — Frontend | Profiles, encounter state, match cards, notifications | Two browsers reflect a shared match. |
| 4 — AI/integration | Claude wingman, coordination with backend/frontend owners, end-to-end checks, pitch | Grounded opener card after a real match; repeatable demo. |

Agree on the event format and matching rules first. Integrate one complete interaction before adding polish or stretch features.

**90-second demo:** show two profiles and the active session; A swipes backward along the glasses arm as if brushing back a stray hair, and no match appears; B taps “Interested”; both receive the match with approved details, time, and venue. Tap “Find common ground” to reveal intersecting interests and a Claude-generated opener, then have the participants start talking without further AI involvement. Keep a reset/expiry example ready for questions. State clearly that one participant uses real glasses, the other uses the web, and the pair is pre-scoped.

**Acceptance:** repeat the full flow five times using actual backward swipes; target notification delivery within two seconds of the second server-received signal. Confirm forward swipes/taps do not submit interest, no match after expiry, no duplicate match from repeated events, no disclosure to an unmatched third account, and no match after blocking or pausing encounter mode.

For the wingman, verify evidence from both profiles for every shared-interest claim, no-overlap and sparse-profile handling, rejection of nonparticipants, and continued matching when Claude fails. A profile containing instructions must not override the wingman rules.

**Next validation:** test whether people understand the gesture, feel less pressure, and want to reconnect. General release requires reliable intended-person selection beyond the controlled pair.

## Reference notes

- [Hackathon tracks](https://live.immersethebay.org/tracks): sign-in required when checked; exact tracks, judging criteria, and sponsor eligibility remain unverified. Obtain the track text before tailoring the submission.
- [Mentra Live specifications](https://mentraglass.com/live): touch/swipe controls, buttons, camera, and speakers.
- [Mentra developer documentation](https://docs.mentraglass.com/): Miniapp and Bluetooth integration paths.
- [Mentra Bluetooth SDK event reference](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/blob/main/docs/api-reference.md): touch/swipe events and gesture-name payloads; validate availability against the loaner’s installed versions.
- [Mentra display guide](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/blob/main/docs/display-guide.md): Live has no display.
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages) and [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs): server-side text generation and schema-constrained responses.

This is a planning document. No application implementation is included.
