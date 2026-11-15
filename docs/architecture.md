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
  swipe as an `InterestEvent`, only when the server says the wearer is `ready`.
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
- Presence and venues (`user_presence`, `venues`) are **API-only**: RLS on, all
  privileges revoked from `anon` and `authenticated`, no policies, not in the
  realtime publication. Phone coordinates are written by `report_location`, read
  only inside `submit_signal`, and never leave the server: not in any API
  response (`presence_state` returns a status and an accuracy, not a position),
  not on signals or matches, not sent to Claude. See `docs/place-matching.md`.
- The API never trusts a client-supplied user id.
- A device token now reaches two more routes that touch match-related data.
  `POST /api/devices/hype` returns a line about the **wearer's own** active
  match only (the user id comes from the token, and the match id in the body must
  be a match that user is in, else 404). `POST /api/guest/handoff` mints a
  sign-in link for the guest account the token belongs to, and refuses (403) any
  account whose email is not `guest-<uuid>@guest.cue.invalid`. A leaked device
  token for a guest can therefore be turned into a browser session for that
  guest; it cannot reach any other account, and a non-guest token cannot use it.
- Two routes are **unauthenticated by design** and create accounts:
  `POST /api/guest` and `POST /api/guest/device` (demo only, see
  `docs/guest-accounts.md`). They are limited to 40 requests per 10 minutes per
  client address per route (in memory per server instance, so a brake only on
  Vercel) and 300 guest accounts per rolling 24 hours (counted from Auth, not
  atomic). The account gets a random password nobody sees. With
  `CUE_GUESTS_ENABLED=off` every guest route answers 404. Names, tokens and
  passwords are never logged.
- Route handlers use `handle()`, `parseBody()`, `HttpError` from
  `apps/web/src/server/http.ts`; all errors are `ApiError` from contracts.

## API

The full route list with auth and schemas is `packages/contracts/src/routes.ts`.
Every request and response body is a zod schema in `packages/contracts`.
Routes validate input with those schemas and must return bodies that parse
with them. Chat is `GET`/`POST /api/matches/[id]/messages` (schemas in
`packages/contracts/src/chat.ts`); it takes a web session only, never a device
token.

Encounter, presence and venue routes (all web session, all return an
`EncounterStatus` with no coordinates; details and status codes in
`docs/place-matching.md`):

| Route | Purpose |
|---|---|
| `GET /api/encounter` | The caller's mode, venue check-in, location status, `ready`, own pending signal, device |
| `POST /api/encounter/mode` | Encounter mode on or off |
| `POST` / `DELETE /api/encounter/location` | Report or forget the phone's position |
| `POST /api/venues` | Create a venue and check in |
| `POST /api/venues/check-in` | Check in by code (404 for an unknown code) |
| `POST /api/venues/check-out` | Leave the venue |
| `POST /api/demo/reset` | Demo reset; `leave: true` also checks out and turns mode off |
| `POST /api/interest` | Submit a signal (web session or device token) |
| `GET /api/devices/me` | Device token: `DeviceContext`: `{ deviceId, encounterMode, ready, latestMatchId, serverTime }` for the glasses bridge. `latestMatchId` is the wearer's newest **active** match created in the last 5 minutes, or `null`; the bridge speaks the wingman line once per new id |
| `POST /api/matches/[id]/hype` | Web session: one spoken wingman line (`HypeLine`) for the caller about that match. 404 unless the caller is in that active match; 429 over the limit |
| `POST /api/devices/hype` | Device token, body `{ matchId }`: the same line for the wearer. Same 404 and 429 |
| `POST /api/guest` | **No auth**, demo only: creates a name-only guest account from `{ intro }` and signs the browser in (cookies). 201; 400, 404 (switch off), 429 |
| `POST /api/guest/device` | **No auth**, demo only: creates a guest from `{ intro, deviceLabel?, mentraUserId? }` and links the calling glasses; returns a device token. 201; 400, 404, 429 |
| `POST /api/guest/handoff` | Device token, demo only: a one-time `/g/<token>` link that signs a phone into the guest account the glasses belong to. 403 unless that account is a guest |
| `GET /g/[token]` | Page route, demo only: redeems a handoff link and redirects to `/encounter` (or `/sign-in` on any failure) |

The guest routes and the switch `CUE_GUESTS_ENABLED` are described in
`docs/guest-accounts.md`; the spoken line in `docs/profiles-and-chat.md`.
`DeviceContext` is in `packages/contracts/src/devices.ts`; `latestMatchId` is
`Uuid.nullable().default(null)`, so an older server's response still parses.

The `/v/[code]` page (not an API route) is what a venue's QR code opens.

## Database (schema `public`)

Backend owns the migration; these names and meanings are fixed so other roles
can rely on them. Add columns freely; do not rename.

| Table | Key columns |
|---|---|
| `profiles` | `user_id` pk → `auth.users`, `display_name`, `photo_url`, `bio`, `interests text[]`, `social_links jsonb` (legacy, emptied, never returned), `sharing jsonb` (`SharingSettings`), `age`, `gender`, `gender_self_described`, `location`, `looking_for`, `work_or_school`, `education`, `mbti`, `ethnicity`, `drinking`, `smoking`, `drugs`, `cards text[]`, `archetype`, `version int`, `updated_at`. The new columns are nullable (`cards` defaults to empty) and the enumerated ones have CHECK constraints. |
| `device_associations` | `id`, `user_id`, `device_label`, `mentra_user_id`, `token_hash`, `pairing_code_hash`, `pairing_expires_at`, `linked_at`, `last_seen_at`, `revoked_at`. One active device per user. Tokens and codes stored hashed (SHA-256). |
| `venues` | `id`, `name` (1 to 80 chars), `code` unique (6 chars, `A-Z0-9`), `created_by`, `active`, `created_at`. Self-reported: anyone can create one. No browser access. |
| `user_presence` | `user_id` pk, `encounter_mode`, `venue_id`, `checked_in_at` (set together with `venue_id`), `lat`, `lng`, `accuracy_m`, `located_at` (all four set or all null), `updated_at`. One row per user. Coordinates exist only here. No browser access. |
| `interest_events` | `id`, `event_id`, `user_id`, `session_id` (nullable; null for every place-based signal), `source`, `gesture`, `occurred_at`, `received_at`, `expires_at`, `status` (`pending`/`consumed`/`expired`/`cancelled`). Unique (`user_id`, `event_id`). At most one `pending` place-based row per user. |
| `matches` | `id`, `session_id` (nullable; null for place-based matches), `venue_id` (nullable), `user_a`, `user_b` (`user_a < user_b`), `first_signal_at`, `venue_label` (a venue's name, or "Nearby"), `venue_label_source` (`manual`, `venue_checkin`, `phone_location`), `status` (`active`/`ended`), `ended_by`, `ended_at`, `created_at`. One active match per pair. No coordinates. |
| `demo_sessions`, `demo_session_members` | **Legacy.** The pre-joined two-person session. Kept only so code deployed before the place-based migration keeps working; no current signal or match path uses them (`block_user` still looks up the caller's old session row). A follow-up migration will drop them, with `submit_interest`. |
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

`supabase/migrations/20261115020000_place_based_matching.sql` adds `venues` and
`user_presence`, makes `session_id` nullable on `interest_events` and `matches`,
adds `matches.venue_id`, and adds `submit_signal`, `presence_state`,
`set_presence_mode`, `report_location`, `clear_location`, `create_venue`,
`check_in_venue`, `check_out_venue` and `reset_my_demo`. It is additive: the
session tables and `submit_interest` stay until a later migration removes them.

### Matching

A signal matches the closest other person who signalled within
`MATCH_WINDOW_SECONDS` (15 s) in the same place. There is no session to join.
Full design, limits and risks: `docs/place-matching.md`.

One Postgres function does the whole decision in a single transaction, under a
single advisory lock (`_matching_lock`, also taken by mode off, check-out, block
and reset), so two simultaneous signals cannot create two matches or zero
matches:

```
submit_signal(p_user_id uuid, p_event_id uuid,
              p_source text, p_gesture text, p_occurred_at timestamptz)
  returns jsonb  -- { status, received_at, expires_at, matched, match_id, reason }
```

Rules: the pair is allowed (`interest_pair_ok`); a repeated `event_id`, or a
second signal while one is pending, is `duplicate` and creates nothing; the
caller must have encounter mode on (`encounter_mode_off`) and a place (`no_place`);
`received_at` is the database clock, read after the lock. A candidate is another
person with an unexpired pending signal, encounter mode on, not blocked either
way, not already in an active match with the caller, and in the same place:
the same valid venue check-in (8 hours), or both phone locations usable
(at most `LOCATION_MAX_AGE_SECONDS` = 60 s old, accuracy at most
`LOCATION_MAX_ACCURACY_M` = 100 m) and `max(0, distance - accuracy_a -
accuracy_b) <= MATCH_RADIUS_M` (40 m). The closest candidate by distance wins
when both have usable locations; otherwise the most recent signal. It creates
one match, consumes both signals, and sets `first_signal_at` to the earlier
`received_at`. The match label is the venue's name (shared check-in) or
"Nearby". Pausing encounter mode or leaving a venue cancels the pending signal;
expired signals are never replayed. Only service role may execute it.

`packages/matching` holds the same rules as pure TypeScript (`place.ts`: distance,
usable location, radius, readiness; `decide.ts`: eligibility, expiry, duplicate
handling) with unit tests; it is the readable reference. The SQL function is the
authority for atomicity. The constants live in `packages/contracts/src/common.ts`
and are mirrored in SQL; change both.

### Presence

`user_presence` holds, per user: encounter mode, the venue they are checked into,
and the phone's last reported location. `presence_state(user)` returns
`{ encounter_mode, ready, venue, location: { status, accuracy_m, located_at } }`
and never coordinates. `ready` = mode on and (a valid venue check-in or a usable
location). The glasses bridge reads `ready` through `GET /api/devices/me`.
Coordinates are written only while mode is on, cleared on mode off, on
`DELETE /api/encounter/location`, on "End demo", and once older than
`LOCATION_RETENTION_MINUTES` (10; the sweep runs inside `report_location`).

### Signal sources

Every interest signal carries a `source` and a `gesture`. There are three
sources:

| `source` | Gestures | Credential | Meaning |
|---|---|---|---|
| `mentra_touch` | `backward_swipe` | device token | Backward swipe on Mentra Live, sent by the miniapp. |
| `web_demo` | `web_confirm` | web session | The "Interested" button in the web app. |
| `headset_remote` | `media_next_track`, `media_previous_track`, `media_play_pause` | web session | A media command received by the signed-in page (Meta Adventurer glasses paired to an iPhone). |

Credential rule: a **device token** may send `mentra_touch` only; a **web
session** may send `web_demo` or `headset_remote`. The user id always comes from
the credential, never the body.

The allowed source/gesture pairs live in one place per layer:
`GESTURES_BY_SOURCE` in `packages/contracts/src/interest.ts` (used by the zod
schema and `packages/matching`) and the SQL function `public.interest_pair_ok`,
which backs the `interest_events` check constraint and the guard in
`submit_signal`. They must be kept in step. The migration that added the
third source is `supabase/migrations/20261115000000_headset_remote_source.sql`;
matching rules do not depend on the source, so any two sources can complete a match.

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
- `chat_messages`: RLS `select` for participants of the **active** match only. Any event → refetch `GET /api/matches/[id]/messages` (and `GET /api/matches` for unread counts). Row contents from realtime are never rendered. Browsers cannot insert, update or delete; all writes go through the API.

The old `demo_session_members` subscription is gone: the page no longer needs a
session. `venues` and `user_presence` are not in the publication and have no
policies; the page learns its place from `GET /api/encounter`. All three
subscribed tables are in the `supabase_realtime` publication. No profile data
travels over realtime. Chat message rows do, but only to the two participants,
and the client ignores their contents.

## Privacy rules that are easy to break

- A one-sided signal is invisible to the other person: no API response, realtime
  row, count, or timing difference may reveal it. `InterestAck` is identical
  whether or not the other person has a pending signal, except `matched`.
- Phone coordinates stay on the server (`user_presence` only, only while
  encounter mode is on, deleted on mode off or after 10 minutes without a
  refresh). A match records a venue name or "Nearby", never a position. The
  Claude input gets no coordinates and no "Nearby" label.
- A wrong match (the closest signaller in a crowd may not be who you meant) shows
  the other person what you share with matches until you unmatch. This is an
  accepted cost of the place-based design, not something the server can prevent.
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
  the request. The input builder reads an allow-list of properties by name. The
  one exception is the spoken wingman line, which sends the other person's
  display name (next but one bullet).
- Chat messages are never sent to Claude. Claude gives one opener and sends
  nothing; "Use this opener" only fills the message box.
- The spoken wingman line (`/api/matches/[id]/hype`, `/api/devices/hype`) sends
  Claude only the other person's display name, a venue's name (not "Nearby"),
  and the grounded suggestion's verified shared items and opener. It is
  requested automatically on a match, needs AI assist on for both people, and
  falls back to a fixed line otherwise. The never-sent list above is unchanged
  for it.
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
- **Matching no longer needs a pre-joined two-person session.** The spec says
  "Never choose a random or nearest account" and describes exactly two people
  per session. Cue now pairs a signal with the closest other person who signalled
  within 15 seconds in the same place (a shared venue check-in, or phone
  locations within 40 m). Phone location is stored, in `user_presence` only and
  only while encounter mode is on. See `docs/place-matching.md`.
- The Claude input grew from interests and bio to the fields in the table in
  `docs/profiles-and-chat.md`. The prompt version is `w3`.
- **Guest sign-up without credentials** (demo only, temporary). The spec has
  email and password accounts. Someone can now get an account by saying or
  typing "Hi, my name is Sam": no email, no password, a synthetic address
  `guest-<uuid>@guest.cue.invalid` as the only marker, no migration. On Mentra
  glasses the mini app listens through the glasses' microphone while unlinked and
  creates and links the account in one call. To be deleted after the demos:
  `docs/guest-accounts.md` has the switch and the removal checklist.
- **Spoken coaching.** The spec has the wingman as a card the person asks for.
  On a match Cue now also says one or two short sentences in a casual friend's
  voice, requested automatically and spoken through the phone or the glasses.
  It is built from the existing wingman's verified shared items and opener plus
  the other person's display name and a venue's name, and falls back to a fixed
  line. This is the one place a display name is sent to Claude. See
  `docs/profiles-and-chat.md`.

## Ownership

| Role | Owns (only this role edits) |
|---|---|
| Hardware | `apps/mentra/**`, `docs/hardware-check.md`, `docs/meta-glasses-check.md` |
| Backend | `supabase/**`, `packages/matching/**`, `apps/web/src/server/**` except `server/ai/**`, `apps/web/src/app/api/**` except `api/matches/[id]/suggestions/**` |
| Frontend | `apps/web/src/app/**` except `api/**`, `apps/web/src/components/**`, `apps/web/src/lib/**` except `lib/supabase/**` and `lib/env.ts`, `apps/web/public/**` |
| AI / integration | `apps/web/src/server/ai/**`, `apps/web/src/app/api/matches/[id]/suggestions/**`, `tests/e2e/**`, `playwright.config.ts`, `docs/demo.md`, `docs/profiles-and-chat.md`, `README.md` |
| Lead (orchestrator) | root config, `packages/contracts/**`, `docs/architecture.md`, `AGENTS.md`, CI, `apps/web` config files and `package.json` |

Need a change outside your area (a new dependency in `apps/web/package.json`, a
contract tweak)? Make the smallest possible edit, and list it under
"Cross-boundary changes" in your final report so the lead can merge it cleanly.
