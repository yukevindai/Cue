# AGENTS.md — SocialEyes

Guide for coding agents (and people) working in this repository. `CLAUDE.md`
points here.

## What this is

SocialEyes is a hackathon MVP (Immerse the Bay, 2026-11-14): signal interest with a
backward swipe on Mentra Live smart glasses (or a double tap on Meta glasses,
or a button). Two people who signal within 15 seconds in the same place become
a match in the web app, with profiles, in-app chat and an optional Claude
"Find common ground" card. "Same place" is a shared venue check-in or two
phone locations close together; there is no pre-joined session any more.

- Product spec: `docs/spec.md` (the original; kept unchanged). Where the owner
  has since decided otherwise, `docs/architecture.md` ("Departures from the
  spec"), `docs/place-matching.md` and `docs/profiles-and-chat.md` win.
- Technical contract, schema, trust model, ownership: `docs/architecture.md`.
- Shared types and the API route list: `packages/contracts/src`.

## Naming

The product is **SocialEyes**. It used to be called Cue, and these still say
"cue" on purpose. Do not rename them as a tidy-up:

- The Mentra mini app (`apps/mentra`): its name in the Mentra app, its screen
  text and spoken lines, its id `demo.cue.mentra`. The owner chose to leave
  it; the web install page tells people the mini app is named Cue.
- The live address `cue-gamma-five.vercel.app` and the Vercel project `cue`.
- Identifiers that live data or the mini app depend on: the glasses token
  prefix `cue_dev_`, the guest address domain `guest.cue.invalid`, the demo
  logins `@cue.demo` and their password, package names `@cue/*`, environment
  variable names `CUE_*`, SQL error codes `CUE0x`, and the hosted database
  project "Cue DB".
- `docs/spec.md`, the original spec, which predates the name.

## Commands

```bash
pnpm install
pnpm stack:start   # local Supabase (Docker); writes apps/web/.env.local
pnpm dev
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @cue/web build
pnpm test:e2e      # Playwright; pass --trace off
```

## Rules

- Next.js here is v16 and differs from older versions. Read
  `apps/web/AGENTS.md` and the docs under `apps/web/node_modules/next/dist/docs/`
  before writing Next code.
- All request/response shapes come from `@cue/contracts`. Do not redefine them.
- Never trust a client-supplied user id. Never expose the service-role key or
  `ANTHROPIC_API_KEY` to the browser or glasses. Keep `import "server-only"` in
  server modules.
- One-sided interest must stay invisible to the other person.
- App text is English only.
- Guest accounts and the spoken wingman are demo features. A device token may
  reach only the wearer's own data: `/api/devices/hype` (their own match) and
  `/api/guest/handoff` (a sign-in link for their own guest account).
- A button or simulated event does not satisfy the glasses swipe requirement;
  say so plainly if hardware is unavailable rather than faking it.
- No secrets or real personal data in the repo. Seed data is synthetic. No
  coordinates of real places anywhere: tests use small offsets around
  latitude 0, longitude 0 only.
- Coordinates never leave the server: not in API responses, signals, matches,
  logs or anything sent to Claude. They live only in `user_presence`.
- Stay inside your role's paths (`docs/architecture.md`, Ownership).
- Before saying work is done: typecheck, lint, tests, and a web build must pass,
  and you must have exercised the behavior for real against the local stack.

## Status

See "Status log" below. Update it when a milestone lands or a decision changes.

### Status log

- 2026-11-15 17:40 UTC: "Hear it again" for the wingman line (PR #13). The
  match screen's line has a replay button; the match page has a "Your wingman"
  block that asks for the line only on a tap ("Hear your wingman"), then shows
  and says it (shared `components/matches/wingman-line.tsx`, `speakNow` in
  `lib/speech.ts`). A tap speaks even when "Wingman voice" is off. Also: while
  a person's own signal is pending the page re-checks matches every 2 s
  (`POLL_SIGNAL_OUT_MS` in `live-provider.tsx`); before, a missed live update
  could delay the first signaller's match screen by up to 20 s (seen as the
  first UI match after a cold local stack). Verified: typecheck, lint, tests
  (web 426), build, `pnpm test:e2e` 251/251, browser walkthrough with speech
  output stubbed. PR #12 (rename to SocialEyes) is merged and live. NOT
  verified: real sound on a phone or glasses.
- 2026-11-15 16:30 UTC: Product and repository renamed to **SocialEyes**
  (`yukevindai/SocialEyes`), on the owner's instruction: everything in the
  web app, the tests' quoted text and the docs. Not renamed, by the owner's
  choice or because live data depends on it: see "Naming" above. Also merged
  since the last entry: PR #11 (guest accounts and spoken wingman); its
  production deployment was READY and serves mini app 0.3.0.
- 2026-11-15 15:30 UTC: Demo-only guest accounts and a spoken wingman line
  (PR #11), on the owner's instruction. Guests: `POST /api/guest {intro}`
  reads a name with `parseIntroName` (contracts), creates an ordinary account
  (`guest-<uuid>@guest.cue.invalid`, random password, name-only profile) and
  signs it in; no migration; `OwnProfile.isGuest`. Sign-in/up pages have a
  "Say hi" card (browser speech recognition, typed fallback). Mentra mini app
  0.3.0 listens while unlinked (MICROPHONE permission) and calls
  `POST /api/guest/device`; "Open Cue as {name}" uses `POST /api/guest/handoff`
  and `GET /g/<token>` (single use, lifetime set by Supabase's email OTP
  expiry, 3600 s locally). Limits: 40 per 10 min per address (in memory), 300
  guests per 24 h, switch `CUE_GUESTS_ENABLED`. Spoken line:
  `POST /api/matches/[id]/hype` and `POST /api/devices/hype` return one or two
  Gen Z style sentences built only from the existing wingman's verified shared
  items plus the other person's display name and venue; validated; fixed
  fallback on any failure or when AI assist is off. The web page speaks it
  (switch "Wingman voice"), the Mentra app speaks it via
  `DeviceContext.latestMatchId`. CONSEQUENCE: each match now calls Claude
  without a tap (still gated by both people's AI assist). Removal after the
  demos: `docs/guest-accounts.md`. Verified by the lead from a clean local DB:
  typecheck, lint, unit + stack tests (contracts 43, matching 54, mentra 160,
  web 424), web build, `pnpm test:e2e` 249/249, and a two-guest browser
  walkthrough with speech output stubbed. NOT verified: real speech
  recognition or audio on any phone, listening/speaking through Meta or Mentra
  glasses, Mentra transcription and `openUrl`, the model's real wording (no
  key here). Also since the last entry: PR #8 (website install of the mini
  app; the owner installed it on a phone with no laptop), PR #9 (calibration
  label fix; web depends on `@cue/mentra` so mini app changes rebuild the
  site), PR #10 (Chinese line removed; app text is English only) are merged. A
  real Mentra swipe and a real Meta double tap reached the live site under
  place-based matching on 2026-11-15 13:53 UTC (no new match: the two accounts
  were already matched).
- 2026-11-15 13:30 UTC: PR #5 (place-based matching) and PR #6 (sign-in page
  explainer lines removed) merged to `main` by the owner; production
  deployment of the PR #5 merge was READY. Phones with the Mentra mini app
  installed before PR #5 must reinstall it (old builds send a session id and
  are rejected). Website install for the Mentra mini app added (PR #8): every
  web build runs `apps/web/scripts/build-mentra-bundle.mjs`, which builds
  `apps/mentra` and writes `miniapp.json`, `icon.png`, `bundle.zip` to
  `apps/web/public/mentra/` (generated, git-ignored; zip written with
  node:zlib, same layout as `mentra-miniapp pack`). Public page `/mentra`
  shows the `miniapp://release?url=<site>/mentra&…` QR code and link. Mini app
  version is now 0.2.0. NOT verified: that the MentraOS app accepts a public
  https release URL (the Mentra tool only generates LAN http ones); the laptop
  install remains the fallback. The swipe itself is unchanged.
- 2026-11-15 12:30 UTC: Place-based matching (PR #5) replaces the two-person
  demo session, on the owner's instruction (reverses the spec's "never choose
  the nearest account"). A signal carries no session; `submit_signal` pairs it
  on arrival with the closest other pending signal (15 s) in the same place: a
  shared venue check-in (`venues`, QR code opens `/v/<code>`, anyone can host)
  or two phone locations within 40 m after both accuracies (`user_presence`,
  reported by the open page while Encounter mode is on; usable when under 60 s
  old and 100 m or better). Blocked and already-matched people are silently
  not candidates. Rejections are `encounter_mode_off`, `no_place`,
  `invalid_event`. Match labels: venue name or "Nearby". Sign-out turns
  Encounter mode off. Glasses app forwards a swipe only when the server says
  `ready`. Design and limits: `docs/place-matching.md`. Known cost: in a crowd
  it can match the wrong person ("Not who you meant? Unmatch" on the match
  screen). Verified by the lead from a clean local DB: typecheck, lint, unit +
  stack tests (contracts 13, matching 54, mentra 129, web 345), web build,
  `pnpm test:e2e` 194/194, and a three-browser crowd walkthrough. Migration
  `20261115020000_place_based_matching.sql` is applied to hosted Cue DB
  (fingerprint identical to local apart from SQL comments); it only adds, and
  the old session tables and `submit_interest` stay until a follow-up
  migration drops them (`block_user` still reads them). NOT verified: real
  phone GPS, iPhone background behaviour, real Mentra swipe or Meta double tap
  under the new model.
- 2026-11-15 07:10 UTC: PR #4 (rich profiles, characters, chat) merged to
  `main` by the owner (`59d743d`); Vercel's production deployment of that
  commit is READY, so https://cue-gamma-five.vercel.app runs it. A Codex
  review on PR #4 found two chat bugs (an idle refetch loop from an unstable
  `markGone`; messages skipped when over a page arrived after "Load earlier");
  both were reproduced, fixed and covered by e2e tests before the merge.
  Not yet checked on the live site: profiles and chat on real phones, and a
  live Claude call with the fuller input.
- 2026-11-15: Rich profiles, character names and in-app chat (PR #4). Profiles
  gain age (18+), gender, city, looking-for, work/school, education, MBTI,
  ethnicity, drinking/smoking/drugs and personality cards; a character ("the
  Night Owl" etc.) is derived by fixed rules (`computeArchetype`, contracts).
  One sharing toggle per field; work, education, ethnicity and habits are
  hidden by default. Social links are gone (column kept, emptied, never
  returned). Chat: `chat_messages`/`chat_reads`, `/api/matches/[id]/messages`,
  page `/matches/[id]/chat`, deleted when a match ends. Claude gives the opener
  only ("Use this opener" fills the composer), never reads chat, and never
  receives age, gender, ethnicity or habits (`NEVER_SENT_TO_AI`). Design:
  `docs/profiles-and-chat.md`. Verified by the lead on the final tree:
  typecheck, lint, unit + stack tests (contracts 13, matching 41, mentra 119,
  web 291), web build, `pnpm test:e2e` 144/144, and a two-phone-width browser
  walkthrough. Migration `20261115010000_rich_profiles_and_chat.sql` and the
  new demo profiles are applied to hosted Cue DB (fingerprint identical to
  local). NOT verified: real phones, a live Claude call with the fuller input.
- 2026-11-15: Second glasses route added (PR #3): a Meta glasses wearer
  (Meta Adventurer on an iPhone) signals with a headset media command. No
  native app: the signed-in web page ("Meta glasses" card on Encounter,
  "Listen for my glasses") holds the phone's audio session and receives
  play/pause/next/previous through the Media Session API; the chosen command
  (default double tap = next track) is sent as `source: headset_remote` with
  the web session. Allowed source/gesture pairs live in `GESTURES_BY_SOURCE`
  (contracts) and SQL `public.interest_pair_ok`; migration
  `20261115000000_headset_remote_source.sql`. NOT verified on a real iPhone or
  real Meta glasses: see `docs/meta-glasses-check.md`. It shows a headset sent
  the command, not which headset. The native Meta toolkit route (experimental
  Inputs module) is documented there and not built.
- 2026-11-14 19:13 UTC: Real Mentra Live swipe verified on the live site: seven
  swipes reached the server under the wearer's account in ~0.2–0.3 s and two
  completed matches. The mini app's default gesture name did not match on that
  unit; "Use as backward swipe" in calibration was needed (name not recorded).
  PR #2 (reload a tab when the browser login changes) merged.
  A Codex review finding (pending signal survives a partner swap inside the
  window) was reproduced and fixed on a branch, then parked at the owner's
  request; the fix is in PR #2's commit history, not in `main`.

- 2026-11-14 15:10 UTC: Final merged tree verified by the lead: typecheck,
  lint, unit tests (matching 33, mentra 119, web 112 + stack/live-gated),
  `pnpm test:e2e` 55/55. Vercel project `cue` (team "Kevin's projects",
  `prj_ybnr8S5OdLb5S55CLZ40T466i1E7`, root `apps/web`, Node 22, functions in
  pdx1) is linked to the repo; Vercel promoted the first build of the lead
  branch to production at https://cue-gamma-five.vercel.app. Later pushes to
  non-`main` branches are login-protected previews; production updates only
  from `main`. Follow-up migration `20261114010000_pin_interest_result_search_path.sql`
  merged and applied to Cue DB.
  STILL MISSING ON VERCEL (owner must add): `SUPABASE_SERVICE_ROLE_KEY` (all
  API routes fail without it) and `ANTHROPIC_API_KEY` (wingman), then redeploy.
  (Superseded: the swipe, live sign-in and keys were all verified later on
  2026-11-14; see above.)
- 2026-11-14 15:05 UTC: Schema (`20261114000000_cue_schema.sql`) and seed
  applied to hosted **Cue DB** (`ubnwwhpkjazejttdmstf`) through the Supabase
  connector. Verified identical to the local stack by fingerprint (columns,
  constraints, indexes, RLS flags, 17 functions and their grants, policies,
  triggers, realtime publication, `avatars` bucket); the three demo accounts
  exist with the seeded password. Not verified: a live sign-in against the
  hosted project (its host is blocked from the build environment). If the
  migration changes, apply the delta as a new migration; do not re-run this one.
- 2026-11-14 14:56 UTC: All four role branches merged into the lead branch
  (`f226b4b`); CI green; lead drove the two-phone flow in a browser. Browser-level
  e2e specs still in progress in the AI/integration session.
- 2026-11-14: Foundation landed (workspace, contracts, web scaffold, local
  Supabase stack, architecture doc). Role work in progress on
  `claude/cue-hardware`, `claude/cue-backend`, `claude/cue-frontend`,
  `claude/cue-ai-integration`, merged into the lead branch
  `claude/friendly-tesla-p1oduu`.

### Orchestration (lead notes)

Role sessions (children of lead session `session_01NFc7bJEVY8d6Rnk95kGiot`),
each pushing its own branch; the lead merges them into
`claude/friendly-tesla-p1oduu` and runs final integration:

| Role | Session | Branch |
|---|---|---|
| Backend | `session_01NFc7bKcVth3YNcgJKFiGQf` | `claude/cue-backend` |
| Frontend | `session_01NFc7bMeLaBuKBm85whk7vx` | `claude/cue-frontend` |
| AI / integration | `session_01NFc7bLR7ZJAaywNpreftjf` | `claude/cue-ai-integration` |
| Hardware | `session_01NFc7bKpRFPweCZeZ5FnG9M` | `claude/cue-hardware` |

Lead procedure: wait for role reports; merge backend first, then AI, frontend,
hardware; run `pnpm typecheck && pnpm lint && pnpm test`, web build, stack-backed
tests and `pnpm test:e2e` on the merged branch; send integration bugs back to
the owning session; update this log.

Open items needing a human, on the live site: installing the Mentra mini app
from `/mentra` on a real phone (no laptop); two real
phones matching by location (outdoors and indoors) and by venue QR; whether an
iPhone keeps reporting location with SocialEyes in the background (expected not);
a real Mentra swipe and a real Meta double tap matching by place; one "Find
common ground" with the real key; profiles and chat on real phones; the Mentra
negative checks (media conflict, hair, pocket, audio); the gesture name used
for "Use as backward swipe" (to set `DEFAULT_BACKWARD_SWIPE_GESTURE_NAME` in
`apps/mentra/src/config.ts`). "Confirm email" in Cue DB Auth settings must be
off if new sign-ups are wanted. Follow-up work: a migration dropping the old
session tables once the merged code is live.

Hosted Supabase project for the demo: **Cue DB**, ref `ubnwwhpkjazejttdmstf`,
region us-west-2, organization "SocialEyes" (created by the owner 2026-11-14; the
Supabase connector is authorized for that organization only). Schema and seed applied 2026-11-14 (see status log). Development and tests stay on the local stack. An earlier empty project named
"SocialEyes" in the "Feidy AI" organization (`dwimciiijiebiskocfjx`) is superseded and
must not be used. Keys are not stored in the repo.
