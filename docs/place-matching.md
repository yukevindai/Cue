# Place-based matching

How a signal becomes a match. This replaced the pre-joined two-person demo
session on 2026-11-15, on the owner's instruction. Code is the source of truth:
`supabase/migrations/20261115020000_place_based_matching.sql` (`submit_signal`),
`packages/contracts/src` (`encounter.ts`, `interest.ts`, `common.ts`) and
`packages/matching/src` (`place.ts`, `decide.ts`).

## What changed, and why

Before, two people had to be put in a private "demo session" with a join code
before any signal could match. Only those two accounts could ever pair. That
made the demo safe and also made it unlike the product idea, so the owner chose
to drop it.

Now a signal matches **the closest other person who signalled within the last 15
seconds in the same place**. Nobody joins anything first. The owner chose this
knowing it will sometimes pair you with someone you did not mean in a crowd.

This **reverses two rules in `docs/spec.md`**: "Never choose a random or nearest
account" and "exactly two people per session". `docs/spec.md` is kept unchanged
as the historical spec. Where it disagrees with this file or the code, this file
and the code describe what Cue does.

## What counts as "the same place"

Either of these, for both people:

1. **A shared venue check-in.** Both are checked into the same venue. Anyone can
   "Host a place": name it, and Cue makes a six-character code and a QR code that
   opens `/v/<code>`. Other people scan the QR code (or type the code under
   "Enter a venue code") to check in. A check-in lasts `CHECK_IN_HOURS` (8) unless
   the person leaves first. Everyone checked into one venue can match, wherever
   they stand in it.
2. **Close phone locations.** Both have a phone location that is fresh and
   accurate enough, and the two are within `MATCH_RADIUS_M` (40 m) once both
   reported accuracies are allowed for.

A person is **ready** when Encounter mode is on and Cue has a place for them (a
valid venue check-in, or a usable location). Only ready people's signals can
match.

## How presence works

Each person has one row in `user_presence`: whether Encounter mode is on, the
venue they are checked into (and when), and their last reported phone location.

- **Encounter mode** is a switch on the Encounter page. Turning it on is what
  makes the open page ask the browser for location.
- **Location.** While Encounter mode is on and the Cue page is visible, the page
  watches the phone's position and sends it to `POST /api/encounter/location` at
  least every `LOCATION_REPORT_INTERVAL_MS` (15 s), and sooner after a move of
  about 10 m (never more often than every 3 s). A location is usable for matching
  only if it is at most `LOCATION_MAX_AGE_SECONDS` (60 s) old and its accuracy is
  `LOCATION_MAX_ACCURACY_M` (100 m) or better. A hidden tab stops watching, so
  its location goes stale.
- **Venue check-in** needs no location. A check-in alone makes a person ready.
- Checking out of a venue, or turning Encounter mode off, cancels that person's
  pending signal.

## The matching rule

`submit_signal` runs in one database transaction under one advisory lock. For a
signal from person X at server receipt time `now`:

1. Reject if the source/gesture pair is not allowed (`invalid_event`).
2. A repeated `eventId` is a `duplicate` and creates nothing.
3. Reject with `encounter_mode_off` if X's mode is off.
4. Reject with `no_place` if X has no valid venue check-in and no usable
   location.
5. If X already has a pending signal, the new one is a `duplicate`.
6. Look for candidates: other people with an unexpired pending signal (received
   less than `MATCH_WINDOW_SECONDS`, 15 s, ago), Encounter mode on, not blocked
   in either direction, not already in an active match with X, and in the same
   place as X (same venue, or within the radius).
7. Pick **one**: if both have usable locations, the smallest distance between
   the two reported points (raw distance, not reduced by accuracy); otherwise
   the most recent signal.
8. If there is a candidate, create one match, mark both signals consumed, and set
   `first_signal_at` to the earlier receipt time. Otherwise store X's signal as
   pending for 15 s. An expired signal is never replayed.

Receipt time is the database clock, not the device clock. When both people share
a venue the match label is the venue's name; otherwise it is "Nearby". Blocked
pairs and existing matches are simply never candidates, so neither is disclosed
by a non-match. The acknowledgement to the sender says only whether a match was
created, never anything about the other person.

## What is stored, and for how long

- **Coordinates** (`lat`, `lng`, `accuracy_m`, `located_at`) exist only in
  `user_presence`, and only while Encounter mode is on. They are cleared when
  the person turns Encounter mode off, when the page tells the server to forget
  them (`DELETE /api/encounter/location`), on "End demo", on sign-out, and when
  they are older than `LOCATION_RETENTION_MINUTES` (10). The 10-minute clearing
  is not a separate timer: it runs whenever any phone reports a location and
  whenever anyone's status is read (each open Cue page polls it, and linked
  glasses check in every 2 seconds). On a system nobody is using, an old row
  can therefore sit until the next such read. A stale location is already
  unusable for matching after 60 s.
- **Signing out turns Encounter mode off** (best effort, before the session
  ends), which forgets the location and cancels a pending signal. A venue
  check-in is kept. Closing the tab without signing out does neither; the
  location then goes stale and is swept as above.
- Coordinates are **never** copied to signals or matches, never returned by any
  API (not even to their owner; the API returns only `none`, `fresh`, `stale` or
  `inaccurate` and the accuracy), and never sent to Claude.
- **Matches** keep a place label only: a venue's name or "Nearby", plus the
  venue id when there was one. A "Nearby" label is not sent to Claude as a venue.
- **Venues** (`venues`): name, code, creator, active flag. Self-reported.
- Neither new table is readable or writable from a browser (RLS on, all
  privileges revoked from `anon` and `authenticated`). Only the API, with the
  service-role key, touches them.
- Signals and matches are kept as before. Ending a match deletes its suggestions
  and chat.

## API

All routes are in `packages/contracts/src/routes.ts`. Auth is the web session
unless stated. Errors use `ApiError`. Every response below is an
`EncounterStatus` unless stated; none contains coordinates.

| Route | Does | Statuses |
|---|---|---|
| `GET /api/encounter` | The caller's own mode, venue check-in, location status, `ready`, own pending signal, device status | 200, 401 |
| `POST /api/encounter/mode` `{ enabled }` | Turn Encounter mode on or off. Off cancels a pending signal and forgets the location | 200, 400, 401 |
| `POST /api/encounter/location` `{ lat, lng, accuracyM }` | Report the phone's position. With mode off nothing is stored and the status comes back unchanged | 200, 400, 401, 429 |
| `DELETE /api/encounter/location` | Forget the stored location | 200, 401 |
| `POST /api/venues` `{ name }` | Create a venue (name 1 to 80 characters) and check the caller in | 200, 400, 401, 429 |
| `POST /api/venues/check-in` `{ code }` | Check in by code. Unknown and inactive codes look the same | 200, 400, 401, 404 `not_found`, 429 |
| `POST /api/venues/check-out` | Leave the venue; cancels a pending signal | 200, 401 |
| `POST /api/demo/reset` `{ leave? }` | Expire the pending signal and end matches made in the last 12 hours. `leave: true` also checks out, turns Encounter mode off and forgets the location | 200, 401 |
| `POST /api/interest` | Submit a signal. Web session or device token | 200 for `accepted`, `duplicate` and `rejected` (`reason`: `encounter_mode_off`, `no_place`, `invalid_event`), 400, 401, 403, 429 |
| `GET /api/devices/me` (device token) | `{ encounterMode, ready }` for the glasses bridge | 200, 401 |

Rate limits are in memory per server instance: location 30 per minute, venue
creation 10 per minute, check-in 10 per minute (codes are short and guessable),
signals 30 per 10 seconds.

## The screens

- **Encounter** (`/encounter`): the "Encounter mode" switch, a "Where you are"
  card (Ready, Not ready or Off; "Checked in at <name>"; the location line;
  "Show QR code", "Leave", "Try location again"), "Enter a venue code" and "Host
  a place" ("Host this place"), the signal panel with the "Interested" button,
  and the glasses cards. "Demo controls" has "Reset demo" and "End demo".
- **`/v/<code>`**: what a venue's QR code opens. Signed in, it goes to
  `/encounter?venue=<code>`, which checks the person in and says "You're checked
  in at <name>". Signed out, it goes to sign-in and comes back afterwards.
- **Match moment**: "It's mutual." with the other person's name, character, the
  place label and the time. It says "Cue pairs you with the nearest person who
  signalled within the same few seconds. In a crowd, that can be the wrong
  person." and offers "Not who you meant? Unmatch".

## Glasses

The glasses do not know where the wearer is. The wearer's place comes from their
phone: a venue check-in, or the location reported by the open Cue page on the
same account. The Mentra bridge asks `GET /api/devices/me` about every 2 s and
forwards a swipe **only** when the server says the wearer is `ready`. Otherwise
the swipe is dropped (nothing is queued or replayed) and the wearer hears a cue:
one for "mode off" and one for "no place: open Cue on your phone". A Meta
headset command comes through the signed-in page, which is open by definition.

## Limits and risks

- **Wrong-person matches.** In a crowd the nearest person who signalled in the
  window may not be the one you meant. Phone location indoors is often off by
  10 to 30 m (the code allows for reported accuracy, but reported accuracy is
  itself unreliable). A venue check-in removes the range problem, but not the
  problem of who meant whom: everyone checked in at the venue is a candidate.
- **A wrong match is visible.** It shows the other person whatever you share with
  matches until you unmatch. Use "Not who you meant? Unmatch" on the match screen.
  Unmatch deletes the match and its chat for both. Block also prevents any later
  pairing.
- **Location can be faked.** A modified client can report any position. Nothing
  verifies it.
- **The Cue page must be open for location.** It reports only while Encounter
  mode is on and the page is visible. On iPhone, location is expected not to
  update in the background or with the phone locked. That has not been checked on
  a real phone. A venue check-in does not need location.
- **Self-reported venues.** Anyone can create one with any name. A code or QR
  image can be shared outside the place, and anyone who has it can check in.
- **Throughput.** One advisory lock serialises every matching decision. That is
  fine for a demo and is the limit on how many signals per second Cue can handle.
- **Sign-up from a QR link loses the venue code.** Signing in returns to the
  venue link; signing up does not. A new user must scan again or type the code.
- **No print layout** for the QR code. It is shown on screen; printing it means
  printing the page.
- Signing out leaves Encounter mode on (see "What is stored").
- No identity verification, and a match does not prove either person meant the
  other.

## Not verified

- Real phones' GPS accuracy indoors, and the 40 m rule against it.
- Location and page behaviour on an iPhone in the background or locked.
- A real Mentra swipe, and a real Meta double tap, pairing two people by place.
  The Mentra swipe was verified on real hardware on 2026-11-14 under the old
  session model. On 2026-11-15 the owner reported that a real swipe and a real
  Meta double tap each reached the live site under this model, but the two
  accounts were already matched, so no new match was created. A new match by
  place from real hardware has not been verified.
- The hosted database. The migration is tested on the local stack; applying it
  to the hosted project is a separate step.

## Old session tables

The migration is additive. `demo_sessions`, `demo_session_members` and
`submit_interest` are still in the database so the previously deployed code keeps
working. A later migration will remove them. No current signal or match path
uses them; `block_user` still looks up the caller's old session row before it takes
the matching lock.
