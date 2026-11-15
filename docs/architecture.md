# Cue — architecture and team contract

`docs/spec.md` is the product spec (v0.4) and wins on product behavior. This file
fixes the technical decisions every role builds against. Change it (and
`packages/contracts`) only by agreement, because four roles work in parallel.

Working product name: **Cue** (the spec leaves the name undecided).

## Stack

- pnpm workspace monorepo, TypeScript everywhere, Node 22.
- `apps/web`: Next.js 16 App Router. **Read `apps/web/AGENTS.md`: this Next
  version differs from older ones** (e.g. `src/proxy.ts`, not middleware; docs
  are in `apps/web/node_modules/next/dist/docs/`). Tailwind 4. Vitest.
- Supabase: Auth (email + password, no email confirmation locally), Postgres,
  Realtime, Storage (`avatars` bucket).
- Claude wingman through `@anthropic-ai/sdk`, server only.
- `apps/mentra`: glasses bridge that forwards a verified backward touch-strip
  swipe as an `InterestEvent`.
- Meta glasses (no app): a web page that receives headset media commands and
  sends them as `InterestEvent`s. See "Signal sources".

## Local development

```bash
pnpm install
pnpm stack:start      # local Supabase in Docker; writes apps/web/.env.local
pnpm dev              # http://localhost:3000
pnpm stack:reset      # re-apply migrations + seed
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e         # Playwright, needs the stack
```

`scripts/dev-stack.sh` starts `dockerd` if needed and pulls Supabase images from
Docker Hub (`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`). DB is at
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

## Trust model

- Browsers hold only the anon key and the user's cookie session. They use
  Supabase directly for **auth, realtime, and avatar upload only**. All other
  reads and writes go through `apps/web` API routes.
- API routes authenticate the caller (`requireSessionUser()` in
  `apps/web/src/server/auth.ts`, or a device token), authorize, then use the
  service-role client (`getAdminSupabase()`). The service-role key never
  reaches a browser or the glasses.
- RLS is enabled on every table as defense in depth. Policies allow only what
  realtime needs (below); everything else is denied to `anon`/`authenticated`.
- The API never trusts a client-supplied user id.
- Route handlers use `handle()`, `parseBody()`, `HttpError` from
  `apps/web/src/server/http.ts`; all errors are `ApiError` from contracts.

## API

The full route list with auth and schemas is `packages/contracts/src/routes.ts`.
Every request and response body is a zod schema in `packages/contracts`.
Routes validate input with those schemas and must return bodies that parse
with them. Chat is `GET`/`POST /api/matches/[id]/messages` (schemas in
`packages/contracts/src/chat.ts`); it takes a web session only, never a device
token.

## Database (schema `public`)

Backend owns the migration; these names and meanings are fixed so other roles
can rely on them. Add columns freely; do not rename.

| Table | Key columns |
|---|---|
| `profiles` | `user_id` pk → `auth.users`, `display_name`, `photo_url`, `bio`, `interests text[]`, `social_links jsonb` (legacy, emptied, never returned), `sharing jsonb` (`SharingSettings`), `age`, `gender`, `gender_self_described`, `location`, `looking_for`, `work_or_school`, `education`, `mbti`, `ethnicity`, `drinking`, `smoking`, `drugs`, `cards text[]`, `archetype`, `version int`, `updated_at`. The new columns are nullable (`cards` defaults to empty) and the enumerated ones have CHECK constraints. |
| `device_associations` | `id`, `user_id`, `device_label`, `mentra_user_id`, `token_hash`, `pairing_code_hash`, `pairing_expires_at`, `linked_at`, `last_seen_at`, `revoked_at`. One active device per user. Tokens and codes stored hashed (SHA-256). |
| `demo_sessions` | `id`, `join_code` unique, `venue_label`, `venue_label_source` (`manual`), `status` (`active`/`ended`), `created_by`, `created_at` |
| `demo_session_members` | `session_id`, `user_id`, `encounter_mode bool`, `joined_at`. At most 2 members per session and one active session per user, enforced in the database. |
| `interest_events` | `id`, `event_id`, `user_id`, `session_id`, `source`, `gesture`, `occurred_at`, `received_at`, `expires_at`, `status` (`pending`/`consumed`/`expired`/`cancelled`). Unique (`user_id`, `event_id`). At most one `pending` row per user and session. |
| `matches` | `id`, `session_id`, `user_a`, `user_b` (`user_a < user_b`), `first_signal_at`, `venue_label`, `venue_label_source`, `status` (`active`/`ended`), `ended_by`, `ended_at`, `created_at`. One active match per pair. |
| `blocks` | `blocker_id`, `blocked_id`, `created_at` |
| `wingman_suggestions` | `match_id`, `requester_id`, `cache_key` (both profile versions + sharing), `payload jsonb`, `created_at`. Deleted when the match ends. |
| `chat_messages` | `id`, `match_id`, `sender_id`, `client_id` (idempotency key, unique with `sender_id`), `body` (1 to 1000 chars), `created_at`. Insert only for a participant of an `active` match (trigger `chat_require_active_match`, SQLSTATE `CUE03`). Deleted when the match ends. |
| `chat_reads` | `match_id`, `user_id`, `last_read_at`; primary key (`match_id`, `user_id`). Drives unread counts. Same active-match trigger. Deleted when the match ends. |

The profile, character and chat columns and tables come from
`supabase/migrations/20261115010000_rich_profiles_and_chat.sql`. It also widens
the default `sharing` JSON (sensitive fields off), extends the `profiles` version
trigger to the new columns, and replaces `matches_cleanup_on_end` so that ending
a match (unmatch, block, demo reset) deletes its suggestions, messages and read
markers. Behavior and field rules are in `docs/profiles-and-chat.md`.

### Matching

One Postgres function does the whole decision in a single transaction, so two
simultaneous signals cannot create two matches or zero matches:

```
submit_interest(p_user_id uuid, p_session_id uuid, p_event_id uuid,
                p_source text, p_gesture text, p_occurred_at timestamptz)
  returns jsonb  -- { status, received_at, expires_at, matched, match_id, reason }
```

Rules (spec section 3): caller must be a member of the active session with
encounter mode on; neither side has blocked the other; `received_at` is the
database clock; the window is `MATCH_WINDOW_SECONDS` (15 s); a repeated
`event_id` or a second signal while one is pending is `duplicate` and creates
nothing; when the other member has an unexpired pending signal, create one
match, consume both signals, `first_signal_at` = the earlier `received_at`.
Pausing encounter mode, leaving, or a device disconnect cancels the pending
signal; expired signals are never replayed. Only service role may execute it.

`packages/matching` holds the same rules as pure TypeScript (eligibility,
expiry, duplicate handling) with unit tests; it is the readable reference and
is used by the server for pre-checks and by tests. The SQL function is the
authority for atomicity.

### Signal sources

Every interest signal carries a `source` and a `gesture`. There are four
sources:

| `source` | Gestures | Credential | Meaning |
|---|---|---|---|
| `mentra_touch` | `backward_swipe` | device token | Backward swipe on Mentra Live, sent by the miniapp. |
| `web_demo` | `web_confirm` | web session | The "Interested" button in the web app. |
| `headset_remote` | `media_next_track`, `media_previous_track`, `media_play_pause` | web session | A media command received by the signed-in page (Meta Adventurer glasses paired to an iPhone). |
| `spectacles_hand` | `double_pinch` | device token | Two quick same-hand pinches recognised by the Cue Lens on Snap Spectacles (`apps/spectacles`). |

Credential rule: a **device token** may send `mentra_touch` or
`spectacles_hand` (`DEVICE_SOURCES`); a **web session** may send `web_demo` or
`headset_remote`. The server does not record which kind of glasses claimed a
token, so either glasses source works with any of the user's device tokens. The user id always comes from
the credential, never the body.

The allowed source/gesture pairs live in one place per layer:
`GESTURES_BY_SOURCE` in `packages/contracts/src/interest.ts` (used by the zod
schema and `packages/matching`) and the SQL function `public.interest_pair_ok`,
which backs the `interest_events` check constraint and the guard in
`submit_interest`. They must be kept in step. The migration that added the
third source is `supabase/migrations/20261115000000_headset_remote_source.sql`
and the fourth `20261115020000_spectacles_hand_source.sql`; matching rules are unchanged, so any two sources can complete a match.

`headset_remote` is **not proof of device**. It shows that a Bluetooth headset
connected to that phone sent a media command. AirPods, or any headset that
sends "next track", would trigger it. The Meta gesture is a tap pattern, not a
backward swipe. Nothing in this route has been run on real Meta glasses; see
`docs/meta-glasses-check.md`.

`docs/spec.md` deferred "a second glasses ecosystem". `headset_remote` is a
deliberately narrow addition (web media commands from a signed-in page), not a
second native integration. The native Meta toolkit route is described in
`docs/meta-glasses-check.md` and is not built.

### Realtime

Clients subscribe to Postgres changes and then refetch through the API:

- `matches`: RLS `select` for `auth.uid() in (user_a, user_b)`. Any event → refetch `GET /api/matches`.
- `interest_events`: RLS `select` for `user_id = auth.uid()` only (own pending signal; never the other person's).
- `demo_session_members`: RLS `select` for own row.
- `chat_messages`: RLS `select` for participants of the **active** match only. Any event → refetch `GET /api/matches/[id]/messages` (and `GET /api/matches` for unread counts). Row contents from realtime are never rendered. Browsers cannot insert, update or delete; all writes go through the API.

All four tables are in the `supabase_realtime` publication. No profile data
travels over realtime. Chat message rows do, but only to the two participants,
and the client ignores their contents.

## Privacy rules that are easy to break

- A one-sided signal is invisible to the other person: no API response, realtime
  row, count, or timing difference may reveal it. `InterestAck` is identical
  whether or not the other person has a pending signal, except `matched`.
- `SharedProfile` is built on the server from the owner's `sharing` settings;
  unapproved fields are never sent. Profiles are visible only to an active match.
- Unmatch or block ends the match, deletes cached suggestions, and removes
  access immediately.
- Wingman input is limited to fields that are shared **and** `aiAssist` is on
  for that owner, plus the coarse venue label. Profile text is data, never
  instructions.
- Sharing is per field. Work or school, education, ethnicity, drinking, smoking
  and drugs default to off. A field the owner did not share is `null` or empty in
  `SharedProfile`; it is dropped on the server (`toSharedProfile`), not hidden by
  the client.
- Never sent to Claude, whatever the sharing settings: age, gender (and its own
  words), ethnicity, drinking, smoking, drugs (`NEVER_SENT_TO_AI` in
  `packages/contracts/src/profile.ts`, plus age, which the input builder simply
  never reads), display name, photo, ids. A test asserts none of them appears in
  the request. The input builder reads an allow-list of properties by name.
- Chat messages are never sent to Claude. Claude gives one opener and sends
  nothing; "Use this opener" only fills the message box.
- Chat is readable only by the two participants of an active match, is deleted
  when the match ends, and is plain text on screen. The send rate limit
  (20 per 10 s per sender) is in memory per server instance.
- External social links are not collected, saved or returned. Chat cannot stop a
  person typing their own contact details; this lowers exposure, it does not
  enforce anything.

## Departures from the spec

Made on the owner's instruction on 2026-11-15; `docs/spec.md` is left as
written:

- The spec deferred chat. Cue now has in-app text chat for an active match.
- The spec listed shared social links as a way to reconnect. They are removed.
- The profile gained optional fields (age, gender, location, looking for, work or
  school, education, MBTI, ethnicity, drinking, smoking, drugs), personality
  cards and a derived character, each with its own share toggle.
- The Claude input grew from interests and bio to the fields in the table in
  `docs/profiles-and-chat.md`. The prompt version is `w3`.

## Ownership

| Role | Owns (only this role edits) |
|---|---|
| Hardware | `apps/mentra/**`, `apps/spectacles/**`, `docs/hardware-check.md`, `docs/meta-glasses-check.md`, `docs/spectacles-check.md` |
| Backend | `supabase/**`, `packages/matching/**`, `apps/web/src/server/**` except `server/ai/**`, `apps/web/src/app/api/**` except `api/matches/[id]/suggestions/**` |
| Frontend | `apps/web/src/app/**` except `api/**`, `apps/web/src/components/**`, `apps/web/src/lib/**` except `lib/supabase/**` and `lib/env.ts`, `apps/web/public/**` |
| AI / integration | `apps/web/src/server/ai/**`, `apps/web/src/app/api/matches/[id]/suggestions/**`, `tests/e2e/**`, `playwright.config.ts`, `docs/demo.md`, `docs/profiles-and-chat.md`, `README.md` |
| Lead (orchestrator) | root config, `packages/contracts/**`, `docs/architecture.md`, `AGENTS.md`, CI, `apps/web` config files and `package.json` |

Need a change outside your area (a new dependency in `apps/web/package.json`, a
contract tweak)? Make the smallest possible edit, and list it under
"Cross-boundary changes" in your final report so the lead can merge it cleanly.
