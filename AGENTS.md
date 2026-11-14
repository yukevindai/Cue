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

Open items needing a human: `ANTHROPIC_API_KEY` for a live wingman call; a
hosted Supabase project for the on-site demo (local stack is used for
development); the real backward-swipe checkpoint on the loaner glasses.
