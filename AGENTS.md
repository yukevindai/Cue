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
  STILL UNVERIFIED: real glasses swipe (docs/hardware-check.md step 6), live
  Claude call, live sign-in on the hosted site.
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
