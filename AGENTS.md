# AGENTS.md — Cue

Guide for coding agents (and people) working in this repository. `CLAUDE.md`
points here.

## What this is

Cue is a hackathon MVP (Immerse the Bay, 2026-11-14): signal interest with a
backward swipe on Mentra Live smart glasses; mutual interest inside a
two-person demo session creates a match in the web app, with an optional
Claude "Find common ground" card.

- Product spec: `docs/spec.md` (wins on behavior).
- Technical contract, schema, trust model, ownership: `docs/architecture.md`.
- Shared types and the API route list: `packages/contracts/src`.

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
- A button or simulated event does not satisfy the glasses swipe requirement;
  say so plainly if hardware is unavailable rather than faking it.
- No secrets, real personal data, or fabricated coordinates in the repo. Seed
  data is synthetic.
- Stay inside your role's paths (`docs/architecture.md`, Ownership).
- Before saying work is done: typecheck, lint, tests, and a web build must pass,
  and you must have exercised the behavior for real against the local stack.

## Status

See "Status log" below. Update it when a milestone lands or a decision changes.

### Status log

- 2026-11-15: Spectacles diamond + match card (branch
  `claude/spectacles-client`, PR #7). `CueLens` builds a gem 3 ft ahead; an SIK
  tap on it sends like a double pinch. `DeviceContext.activeMatchId` (optional,
  contracts) lets a device that signalled first learn of a mutual match; the
  Lens then plays the match cue and shows a synthetic "Kevin, Ping-pong" card.
  Verified: typecheck, lint, all unit + stack tests, web build, Preview shows
  the diamond. NOT verified: tap in Preview or on a device, the card on a
  device; live site needs PR #7 merged and migration
  `20261115020000_spectacles_hand_source.sql` applied to Cue DB.

- 2026-11-15: Snap Spectacles client (`apps/spectacles`, branch
  `claude/spectacles-client`). A Lens Studio Lens: a double pinch (two
  same-hand pinches within 450 ms, Spectacles hand tracking) sends
  `source: spectacles_hand`, `gesture: double_pinch` with a device token, using
  the same pairing code flow as Mentra (the Lens claims with label "Snap
  Spectacles"). Logic lives in `lens/Assets/Scripts/Cue/Core` (plain TS,
  unit-tested, contract parity test); `CueLens.ts` is the only Lens API file.
  Server: `GESTURES_BY_SOURCE`, `DEVICE_SOURCES`, `sourceAllowedForAuth`, SQL
  `interest_pair_ok` (migration `20261115020000_spectacles_hand_source.sql`,
  NOT yet applied to hosted Cue DB). Verified: unit tests, stack tests, and the
  real Core client against the local server (pair, signal, match). NOT verified:
  Lens Studio compile or real Spectacles; see `docs/spectacles-check.md`.
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
  The live site still runs the old code until PR #4 is merged to `main`
  (owner's go-ahead needed); the old code works against the new schema.
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

Open items needing a human: `ANTHROPIC_API_KEY` for a live wingman call; hosting the web app (Vercel or laptop + tunnel) with the Cue DB URL, anon key and service-role key, and turning off "Confirm email" in Cue DB Auth settings if new sign-ups are wanted; the real backward-swipe checkpoint on the loaner glasses.

Hosted Supabase project for the demo: **Cue DB**, ref `ubnwwhpkjazejttdmstf`,
region us-west-2, organization "Cue" (created by the owner 2026-11-14; the
Supabase connector is authorized for that organization only). Schema and seed applied 2026-11-14 (see status log). Development and tests stay on the local stack. An earlier empty project named
"Cue" in the "Feidy AI" organization (`dwimciiijiebiskocfjx`) is superseded and
must not be used. Keys are not stored in the repo.
