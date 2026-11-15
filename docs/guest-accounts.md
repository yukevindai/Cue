# Guest accounts (demo only, to be deleted)

Added 2026-11-15 on the owner's instruction. Code is the source of truth; this
file says what it does, what it stores, how to switch it off and how to remove it
after the demos. `docs/spec.md` is unchanged and does not mention guests; see
"Departures from the spec" in `docs/architecture.md`.

## What it is

A guest account is an ordinary SocialEyes account that someone gets by saying or typing
"Hi, my name is Sam". It has the name Sam and nothing else: no email address
they know, no password. It exists so that people at a demo can get in within a
few seconds, with their voice, without a keyboard.

It is **demo-only and temporary**. The sign-up card tells people so ("Guest
accounts are for the demo and may be removed afterwards."), and the Profile page
says the same. After the demos the owner deletes every guest account and the
feature's code is removed (see "After the demos").

A guest is marked only by its email address, `guest-<uuid>@guest.cue.invalid`
(`GUEST_EMAIL_DOMAIN` and `isGuestEmail` in `packages/contracts/src/guest.ts`).
`.invalid` is a reserved top-level domain, so nothing is ever delivered there.
There is no database migration and no extra column or table. Once created, a
guest is treated exactly like any other account: same profile, matching, chat,
glasses linking and Claude rules.

## The three ways in

### 1. Web, typed

On Sign in and Sign up (the `(auth)` layout) a card sits above the forms.

1. The card reads "New here? Just say hi", with the text "Say 'Hi, my name is
   ...' and you're in. No email or password. Guest accounts are for the demo and
   may be removed afterwards."
2. The person types in the field "Or type it" (placeholder "Hi, my name is ...")
   and taps "Continue as guest". The field accepts a full introduction ("I'm
   Sam", "call me Sam") or just a name ("Sam").
3. Empty field: "Type your name, or 'Hi, my name is ...'." If no name can be
   read: "SocialEyes couldn't pick a name out of that. Try 'Hi, my name is Sam', or just
   your first name."
4. The browser sends `POST /api/guest` with the text. The server picks the name,
   creates the account and signs this browser in (session cookies on the
   response). The card shows "Name: Sam" and "Getting you in...", then "Yo Sam,
   you're in." The page then goes to the `next` path if there is a safe one,
   otherwise to Encounter.

### 2. Web, spoken (also the Meta glasses route)

Same card. If the browser has speech recognition, a "Say hi" button appears above
the typed field. If it does not: "Voice entry isn't available in this browser, so
type your name below."

1. Tap "Say hi". The browser asks for the microphone the first time. The card
   shows "Listening... Say 'Hi, my name is ...'" and, as the browser hears it,
   `Heard: "..."`. The button becomes "Stop listening". It stops by itself after 10
   seconds, or when the browser decides the phrase is over.
2. If a name can be read, it is sent to `POST /api/guest` exactly as in the typed
   route, and the card shows "Name: Sam" and "Getting you in...".
3. The page says out loud "Yo Sam, you're in." (browser speech output, English).
   It waits for that at most 2.5 seconds, then goes on.
4. If nothing was heard: "Didn't hear anything. Tap Say hi and speak right away,
   or type your name below." If a name cannot be read: "Couldn't pick out a name
   in that. Try again and say 'Hi, my name is ...', or type it below." Other
   problems (microphone blocked, no microphone, no connection to the recognition
   service, a failure) each have their own sentence under the card, and the typed
   route always still works.

**Meta glasses.** Meta glasses are the phone's Bluetooth headset. When they are
connected as the phone's audio device, the phone hears the wearer through them
and speaks the greeting through them. Nothing in SocialEyes knows or checks this: it is
the phone's normal audio routing.

### 3. Mentra Live glasses (spoken, no phone browser needed)

The mini app (version 0.3.0, `MICROPHONE` permission in `miniapp.json`) does this
while a server address is set and the glasses are not linked to an account.
Pairing with a code still works.

1. The setup screen shows "Say "Hi, my name is ..." to your glasses to start as a
   guest, or enter a pairing code." with a "Listening..." pill while the
   microphone is open.
2. The mini app listens through the glasses' microphone, in English, using
   Mentra's speech-to-text. It looks only at **final** transcripts and acts only
   on one that contains a real introduction ("my name is Sam", "I'm Sam"). A bare
   name or any other chatter is ignored (`parseIntroName` with `requireLeadIn`),
   because the microphone is open all the time.
3. It sends that one transcript to `POST /api/guest/device`, with the label
   "Mentra Live". The server creates the guest and links the glasses in the same
   call and returns a device token, which the mini app stores like a pairing
   token. Listening stops.
4. The glasses say "Yo Sam, you're in. Open Cue on your phone."
5. The setup screen now shows a button "Open Cue as Sam". Tapping it asks the
   server for a one-time sign-in link (`POST /api/guest/handoff`) and asks the
   phone to open it. The screen says "Opening SocialEyes in your browser. If nothing
   opens, tap the link below." and shows an "Open Cue" link as a fallback. The
   link signs the phone's browser into the same account and lands on Encounter.
6. On failure the glasses say "Couldn't set that up. Try again in a bit." At most
   one attempt per 5 seconds, and after 5 failures it stops until the setup
   screen is opened again.

If the account is not a guest the handoff answers 403 and the screen says "This
is not a guest account. Open Cue in your browser and sign in."

## API

Routes are in `packages/contracts/src/routes.ts`; schemas in
`packages/contracts/src/guest.ts`. All three answer **404 `not_found`** when the
switch is off, whatever the input. Responses carry `Cache-Control: private,
no-store`. The user id is never taken from the request.

| Route | Auth | Request | Success |
|---|---|---|---|
| `POST /api/guest` | none | `{ "intro": string }`, 1 to 200 characters after trimming, no other keys | `201 { "displayName": string }`, and the session cookies of the new account |
| `POST /api/guest/device` | none | `{ "intro": string (1 to 200), "deviceLabel"?: string (1 to 60), "mentraUserId"?: string (1 to 200) }`, no other keys | `201 { "displayName", "deviceId", "deviceToken" }` (no cookies) |
| `POST /api/guest/handoff` | device token | none | `200 { "path": "/g/<token>", "expiresAt": ISO time }` |
| `GET /g/<token>` (a page route, not an API route) | the token in the path | none | redirect to `/encounter` on success, to `/sign-in` on any failure |

Status codes:

- `400 invalid_request`: no name could be read. `POST /api/guest` says "Tell us
  your name to start, for example "I'm Sam" or just "Sam"." `POST /api/guest/device`
  is stricter and needs a lead-in: "Say your name to start, for example "Hi, my
  name is Sam"." Also malformed JSON or unknown keys.
- `401 unauthenticated`: handoff only, missing or revoked device token.
- `403 forbidden`: handoff only, the device's account is not a guest.
- `404 not_found`: the switch is off.
- `429 rate_limited`: over the per-address limit, or over the daily cap (below).
- `500 internal`: anything else. A half-made account is deleted again.

How the name is chosen (`parseIntroName`): control characters and extra spaces
are removed; leading fillers and greetings ("um", "hey", "good evening") are
dropped; a lead-in such as "my name is", "I'm", "call me" is removed; the name
ends at the first comma, full stop or words like "and" or "nice"; only letters,
apostrophes, hyphens and spaces are kept; at most 4 words after a lead-in and 3
for a bare name; at most 40 characters; single words such as "hi", "there" or
"yes" are not names. It never guesses: if it is not sure, it returns nothing and
the caller asks again. Names in any script are allowed. The server uses the same
function; the browser's copy only saves a round trip.

### Limits (`apps/web/src/server/guest-config.ts`)

| Limit | Value | Notes |
|---|---|---|
| Per client address | 40 requests per 10 minutes, counted separately for each of the three routes | The address is the first `x-forwarded-for` entry. Generous on purpose: at a demo everyone on the venue's Wi-Fi arrives from one address. In memory, per server instance (see risks) |
| Daily cap | 300 guest accounts created in any rolling 24 hours | Counted by listing Auth users and checking the guest address and creation time. Not atomic (see risks) |
| Handoff link lifetime | `HANDOFF_TTL_SECONDS` = 3600 s (1 hour) | `expiresAt` is that figure added to now. **Supabase decides the real lifetime**: the Auth setting "Email OTP Expiration" (`[auth.email] otp_expiry` in `supabase/config.toml`, 3600 s locally). If the hosted project's setting is different, the link lives for that long and `expiresAt` is wrong. Check it on the hosted project |
| Handoff link use | Once | It is a Supabase magic-link token. A newer link for the same account replaces an older unused one |
| Switch | `CUE_GUESTS_ENABLED` | On unless set to `off`, `false` or `0` (any case) |

## What is and is not stored

Stored:

- An Auth user with the synthetic email, `email_confirm` already true, and a
  random 32-byte password (base64url). The password is generated in server
  memory, used once to sign the web guest in, and **never returned, stored,
  logged or shown**. Nobody can sign in with it afterwards; the only ways back
  into a guest account are the browser session it was created with, the glasses'
  device token, and a handoff link.
- A profile with the display name only. Every other field is empty, every sharing
  toggle is at its default (so work or school, education, ethnicity and habits
  are off), and AI assist is on (the default).
- For the glasses route, a linked device (`device_associations`), exactly as if
  the glasses had been paired by code. The mini app stores the device token and
  the guest's name (`cue.guestName`) in its own storage.

Not stored:

- **The transcript.** The server keeps the name picked out of it and nothing
  else. It does not log names, emails, tokens or passwords. The Mentra mini app
  keeps no transcript and logs one only at debug level; only one final transcript
  (the introduction) is ever sent.
- Any real email address, phone number or location.

Who hears the audio:

- **Web, spoken route.** The browser's speech recognition decides where audio
  goes. In Chrome and other Chromium browsers it is sent to the browser vendor's
  servers to be transcribed; Safari on iPhone uses Apple's service. SocialEyes never
  receives audio, only the text the browser returns. The speech output is the
  browser's own.
- **Mentra route.** The glasses' audio is transcribed by Mentra's service
  (`session.transcription`); SocialEyes receives only the final text of one
  introduction.

## Limits and risks

- **Open sign-up while the switch is on.** Anyone who can reach the site can
  create accounts. The per-address limit is in memory per server instance; on
  Vercel several instances can run, so it is a brake, not a guarantee. The daily
  cap of 300 is counted from Auth and is not atomic: simultaneous requests can
  go a little over. Listing Auth users also gets slower as users grow; it is
  fine at demo scale.
- **A guest who signs out cannot get back in.** There is no password. Signing
  out of a guest account first asks: "Sign out of this guest account?" with "This
  is a guest account with no password. If you sign out you won't be able to get
  back into it." The buttons are "Sign out anyway" and "Stay". A signed-in
  guest's glasses can still hand off a new link to a browser, if the glasses
  stay linked.
- **A handoff link is a password until it is used.** Anyone holding the URL can
  sign in as that guest. It is single use and the mini app keeps it out of its
  logs, but do not paste or share it.
- **A name-only profile gives the wingman nothing specific to say.** A guest
  matched with another guest, or with anyone who has shared nothing in common,
  gets the fixed line ("Yo, Sam noticed you too. Go say hi.") and "Find common
  ground" shows its no-overlap opener. Both people can add interests and cards
  on Profile to get something specific (see `docs/profiles-and-chat.md`).
- **Names are not checked.** A guest can say any name. There is no moderation.
- **The Mentra mini app holds the microphone while it is not linked.** The
  microphone is open whenever a server address is set and no account is linked,
  so it hears everything said near the wearer, though it acts on one
  introduction only. It stops as soon as an account is linked. The manifest
  describes it as "Hears you say your name to create a guest account. Listens
  only until an account is linked."
- **Guests are real accounts.** They match, chat and can be matched by other
  people. Everything in the other docs about wrong matches and shared fields
  applies.

## Turning it off

Set `CUE_GUESTS_ENABLED=off` on Vercel (Project, Settings, Environment
Variables, Production) and **redeploy**; environment variables are read when the
deployment starts. From then on all three routes and `/g/<token>` answer 404, and
the card on the sign-in pages is replaced by "Guest entry is switched off right
now. Sign in or create an account with an email below." Existing guest accounts
keep working in already-signed-in browsers and on already-linked glasses; the
switch stops new accounts and new handoff links only. Locally, put the same
variable in `apps/web/.env.local` and restart `pnpm dev`.

A glasses mini app that is still listening gets a 404, says "Couldn't set that up.
Try again in a bit." and stops after 5 failures.

## After the demos

Do these in order. Nothing here is automatic.

1. **Switch it off** (above) and redeploy, so no new guests appear while you
   clean up.
2. **Delete the guest users.** This is irreversible and must be run deliberately
   by the owner, on the hosted project only when intended (SQL editor in the
   Supabase dashboard, project "Cue DB"). Count first:

   ```sql
   select count(*) from auth.users where email like 'guest-%@guest.cue.invalid';
   ```

   Then delete:

   ```sql
   delete from auth.users where email like 'guest-%@guest.cue.invalid';
   ```

   This cascades from the Auth user to everything that references it: their
   profiles, matches (the other person loses that match too, and its chat
   messages and read markers), pending signals, presence, blocks, cached
   suggestions and linked glasses. Venues a guest created are not deleted (their
   creator is just cleared). There is no undo and nothing to restore from except
   a database backup.
3. **Remove the code.** Remove or edit, then run `pnpm typecheck && pnpm lint &&
   pnpm test` and a web build:
   - Contracts: `packages/contracts/src/guest.ts` and `guest.test.ts`; the
     `export * from "./guest"` line in `index.ts`; `guest`, `guestDevice` and
     `guestHandoff` in `routes.ts`; `isGuest` on `OwnProfile` in `profile.ts`.
   - Web server: `apps/web/src/server/guests.ts`, `guest-config.ts` and
     `guest-config.test.ts`; `apps/web/src/app/api/guest/` (three routes) and
     `apps/web/src/app/g/`; `linkDeviceForUser` in `server/devices.ts`; the
     `isGuest` argument in `server/profiles.ts`; the guest tests in
     `server/__stack_tests__/guests-hype.test.ts` (the file also covers the
     wingman line, which stays).
   - Web pages: `components/guest-entry.tsx`, `lib/guest-entry.ts` and its test;
     `<GuestEntry />` in `app/(auth)/layout.tsx`; `createGuest` in `lib/api.ts`;
     the guest confirmation in `components/sign-out-button.tsx`; the guest line in
     the Account section of `components/profile/profile-view.tsx`. In
     `lib/speech.ts` the recognition half (`listenOnce` and what only it uses) can
     go; `speak` and `primeSpeech` stay, because the wingman line uses them.
   - Glasses app: `apps/mentra/src/guest-intro.ts`; the guest parts of
     `bridge.ts`, `api-client.ts`, `speech.ts`, `config.ts` (`guestName`),
     `ui/index.html` and `ui/main.ts`, `background/index.ts` (the transcription
     source, `openUrl` and the `cue:open-guest` handler) and
     `guest-and-hype.test.ts`; the `MICROPHONE` permission and requirement in
     `miniapp.json`, with a version bump so phones take the new bundle.
   - Tests and docs: any guest specs under `tests/e2e/`, this file, and the
     mentions in `README.md`, `docs/demo.md`, `docs/architecture.md`,
     `docs/hardware-check.md`, `docs/meta-glasses-check.md`,
     `apps/mentra/README.md` and `.env.example` (`CUE_GUESTS_ENABLED`).
4. Remove `CUE_GUESTS_ENABLED` from Vercel.

## Not verified

None of this has been tried on a phone or on glasses. It is covered by automated
tests with fakes only.

- Real speech recognition in phone browsers, iPhone Safari especially (whether
  it is available at all, whether it asks for the microphone, and how it behaves
  with the SocialEyes page in a normal tab).
- Listening and speaking through Meta glasses as the phone's Bluetooth headset.
- The Mentra `MICROPHONE` permission on a real phone and glasses, and whether
  transcription events actually arrive in a locally installed mini app.
- `openUrl` on a phone: whether "Open Cue as Sam" opens the browser, and in which
  browser.
- Speech while the SocialEyes page is in the background or the phone is locked.
- The real lifetime of a handoff link against the hosted project's "Email OTP
  Expiration" setting.
- The model's actual wording for the match line with a real Claude key (not
  related to guests, but a guest's first match is where it will be heard).
