# Cue demo runbook

Target length: 90 seconds, plus questions. Source of truth for behavior:
`docs/spec.md` section 7, as amended by `docs/profiles-and-chat.md` (richer
profiles, a character, and in-app chat) and `docs/place-matching.md` (matching by
place instead of a pre-joined session; this reverses parts of the spec). This
runbook must not promise more than the build does.

**Not yet tried on real phones.** The richer profile, the character on the match
screen and chat are covered by automated tests and have not been run on the
phones used for the demo. The live Claude call with the fuller input has not
been run with a real key. Rehearse both on the day before relying on them.

**Place matching is not yet tried on real phones.** Matching by place (venue
check-in, or phone locations within 40 m) is covered by automated tests. Nobody
has checked how accurate real phones' location is indoors, how an iPhone behaves
with the Cue page in the background or locked, or whether a real Mentra swipe and
a real Meta double tap pair by location. Rehearse on the day.

**Hardware status.** On 2026-11-14 the real-swipe checkpoint in
`docs/hardware-check.md` was met on the loaner Mentra Live, **under the old
session model**: real swipes reached the live server under the wearer's account
and completed matches. On 2026-11-15 the owner reported that the Mentra mini app
was installed from the website on their phone with no laptop, and that a real
Mentra swipe and a real Meta double tap each reached the live site under
place-based matching; the two accounts were already matched, so that run created
no new match. A new match by place completed by real hardware has not been
verified.
The gesture mapping had to be set on the phone first ("Use as backward swipe" in
the mini app). Re-run the on-device steps before each demo, because the mapping
is stored on one phone and a reinstall loses it. If they do not pass on the day, say so
openly and use the fallback in this file. A button, an
injected event, or a web input is not the glasses path and must not be
presented as one.

**Guests and the spoken wingman line are not yet tried on a phone or on
glasses.** Both are covered by automated tests with fakes. Speech recognition in
phone browsers, speech through Meta or Mentra glasses, the Mentra microphone
permission and the model's real wording are all unverified. Rehearse before
relying on them, and keep the typed path ready.

## Fastest way in: a guest account

For a demo, the quickest way to get someone an account is a guest account (demo
only; to be deleted afterwards, see `docs/guest-accounts.md`). On the sign-in or
sign-up page, the card "New here? Just say hi" takes a name:

- **Spoken:** tap "Say hi" and say "Hi, my name is Sam". The page shows what it
  heard, and says "Yo Sam, you're in." Needs a browser with speech recognition;
  otherwise the card says so and the typed field works. The browser sends the audio
  to its vendor's service to transcribe it; Cue itself only receives the text.
- **Typed:** type "Hi, my name is Sam", "I'm Sam" or just "Sam" under "Or type
  it" and tap "Continue as guest".
- **Mentra glasses:** while the glasses are not linked, the mini app listens
  through the glasses' microphone. The wearer says "Hi, my name is Sam"; the
  glasses reply "Yo Sam, you're in. Open Cue on your phone." and the setup screen
  shows "Open Cue as Sam", which opens a one-time link signing the phone into
  the same account. No pairing code is needed.
- **Meta glasses:** the phone hears and speaks through them when they are its
  Bluetooth headset. Use the spoken route above on the wearer's phone.

A guest has no email or password. If they sign out they cannot get back in (the
app warns first). A guest has only a name, so the wingman has nothing specific
to say about them: see "Wingman voice" below. To switch the feature off, set
`CUE_GUESTS_ENABLED=off` on Vercel and redeploy.

## Wingman voice

When two people match, Cue says one or two short sentences about the match in a
casual friend's voice, and shows them as "Your wingman" on the match screen. It
plays through the glasses when they are the phone's audio device, otherwise
through the phone speaker; a Mentra wearer's glasses app speaks it itself. The
"Wingman voice" switch on the Encounter page turns the speech off on that browser
(the text still shows).

- **A name-only guest, or two people with nothing in common shared, hear the fixed
  line**, for example "Yo, Sam noticed you too. Go say hi.", with the venue's name
  added when the match was made at a venue.
- **To get a specific tip,** both people add a shared interest (an interest or a
  personality card that both have) on Profile, share it, and leave AI assist on.
  The line then mentions one shared thing and nudges them to talk. It needs a
  working `ANTHROPIC_API_KEY`; without one the fixed line is used.
- Say aloud if asked: Claude is sent the other person's display name, the venue's
  name if any, and the shared things already checked
  for "Find common ground". Nothing else, and never chat.

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
- [ ] Use only the synthetic demo accounts for anything on screen. Do not type a
      real person's details into a profile or chat during the demo.
- [ ] Alex's profile is the seeded one: age, city, looking-for, work, personality
      cards and a character. Alex's ethnicity, drinking, smoking and drugs are
      filled in and none are shared. Check the profile page still shows them as
      not shared, so you can point at it.
- [ ] No chat history from an earlier run (a reset or unmatch deletes it).
- [ ] The glasses are paired to Alex. On the Encounter page as Alex, open the
      glasses card, generate a pairing code, and enter it in the Cue app on the
      glasses. The card should then read "Glasses linked".
- [ ] Both phones are in the same place. Pick one:
      - **Venue check-in (use this indoors, and on the hosted site).** On Alex's
        phone, Encounter page, "Host a place": type a name and tap "Host this
        place". Alex is checked in and a QR code and a six-character code appear.
        On Sam's phone, scan the QR code with the camera (it opens `/v/<code>`
        and checks Sam in, after sign-in if needed), or type the code under
        "Enter a venue code" and tap "Check in".
      - **Phone location.** Turn on Encounter mode on both phones and allow
        location when the browser asks. Phones must be within 40 m of each other
        once both reported accuracies are allowed for, and each location must be
        100 m accurate or better. Indoors, phone location is often off by 10 to
        30 m, so this can fail in a hall. Outdoors it is more likely to work.
- [ ] Encounter mode is on for both Alex and Sam, and the "Where you are" card
      reads "Ready" on both. If it says "Not ready", it shows why: location is
      blocked, too rough or out of date, or there is no check-in.
- [ ] The Cue page stays open and in front on both phones. Location is reported
      only while the page is open; behavior with the phone locked is not
      verified. A venue check-in does not need location.
- [ ] Nobody else in the room signals during the demo window. Cue pairs a
      signal with the closest other person who signalled in the same place within
      15 seconds, so a stranger's signal could take the match.
- [ ] Riley (`riley@cue.demo`) is available on a third browser for the "what if
      someone else signals?" question, but is not part of the demo.
- [ ] `docs/hardware-check.md` has been read, and the glasses status is known.
- [ ] Guests: if people will join by voice, `CUE_GUESTS_ENABLED` is not `off`
      on the site, and a test guest made on the day works. After the event, see
      `docs/guest-accounts.md` ("After the demos") to delete guest accounts.
- [ ] Wingman voice: the Encounter page's "Wingman voice" switch is on for the
      phone that should speak, its volume is up, and the line was heard once in a
      rehearsal match (then use "Reset demo").

## The 90-second script

| Time | Action | What to say |
|---|---|---|
| 0:00 - 0:10 | Show Alex's and Sam's profiles (cards, character, and the per-field sharing switches) and the "Where you are" card. | "These are two synthetic demo accounts. Each field has its own share switch." |
| 0:10 - 0:25 | Point at encounter mode on both accounts and the "Ready" status. | "Both people have turned encounter mode on, and Cue knows both are in the same place: a venue they checked into, or phones that are close together. A signal can only match someone in the same place." |
| 0:25 - 0:40 | Alex makes a backward swipe along the glasses' temple strip, as if brushing back a stray hair. Show that no match appears. | "Alex signals interest. Sam gets no notification about it, and no match appears yet." If the glasses path is not verified, say so here instead of implying it works. |
| 0:40 - 0:55 | Sam taps "Interested" in the web app. Alex's page reads "Your signal is out" until then. | "Sam is the second person. The web app is the second input because there is only one pair of glasses." |
| 0:55 - 1:10 | Both screens show "It's mutual." Open the other person's card from the match screen: approved profile details, their character, encounter time, and venue label. Point out that Alex's drinking, smoking, drugs and ethnicity are not shown. If Wingman voice is on, the phone (or the glasses) says the wingman line and "Your wingman" shows it; the seeded Alex and Sam share cards, so with a working `ANTHROPIC_API_KEY` the line should mention one; without it, it is the fixed line. | "Both signals arrived within 15 seconds, in the same place, so the server created one match. The place on it is the venue's name, or just "Nearby". Cue does not keep or show anyone's location. Each person sees only the fields they approved for sharing. Alex filled in some sensitive fields and shared none of them, so Sam cannot see them." |
| 1:10 - 1:25 | Tap "Find common ground" on one screen. Show the shared interests and the optional opening question, then tap "Use this opener". The question appears in the message box. Do not send it yet. | "Claude only sees the fields each person approved for sharing and for AI assistance. It never sees age, gender, ethnicity, drinking, smoking or drugs, and it never reads messages. It writes one opening question. Nothing is sent for anyone: this only fills the box, and the person decides." |
| 1:25 - 1:30 | Send the message from one account and show it arrive on the other. Then stop the demo. | "From here the conversation is theirs, inside Cue. Cue does not listen or reply." |

## What to say about sensitive fields and chat

Read aloud if asked, or when the profile is on screen:

"Ethnicity, drinking, smoking and drugs are optional. They are off by default
and never sent to Claude. If someone fills them in, they are stored in the
database, and this is a demo with no privacy policy, so we only use made-up
people. Age is something the person types in; nothing about anyone is verified."

"Chat is only between the two matched people, and it is deleted when either of
them unmatches or blocks. Messages show as plain text, with no links. Cue cannot
stop someone typing their own phone number into a message. There is also no way
to report a message yet: the controls are Unmatch and Block."

## What to say about matching strangers and the one-glasses limitation

Read aloud, in plain words:

"Only one pair of glasses is available, so one person uses the glasses and the
other uses the web app. Cue matches a signal with the closest other person who
signalled within 15 seconds in the same place. Nobody was put in a private
session first. In a crowd that can be the wrong person: phone location indoors is
often off by 10 to 30 meters, and being near someone does not prove who you
meant. If it is wrong, 'Not who you meant? Unmatch' ends it, and they only ever
saw what you chose to share. For this demo it is two people in a quiet room."

"Cue keeps a phone's location only while Encounter mode is on, only to decide who
is near, and deletes it when the mode is turned off or after ten minutes
without an update. It is never shown to anyone and never saved with a match."

## Two-glasses variant (Mentra Live and Meta Adventurer)

Use only if `docs/meta-glasses-check.md` steps 1 to 4 have passed on the day.
As of writing, nothing in this route has been run on real Meta glasses or a real
iPhone, and no Mentra swipe and Meta double tap have been paired by location; if the check has not passed, use the button fallback below and say so.

Setup for the Meta wearer:

- [ ] The Meta glasses are paired to the wearer's iPhone and are its audio
      output.
- [ ] On the iPhone, in Safari, the wearer signs in to the Cue site as their
      demo account (not the same browser profile as the other account).
- [ ] The wearer is in the same place as the other person (venue check-in, or
      phone location), turns encounter mode on, and on Encounter taps "Listen for my glasses" on the "Meta glasses" card. The quiet track is
      heard in the glasses.
- [ ] A test tap shows "Last command:" updating. The chosen signal is double tap
      unless changed with "Use as my signal".
- [ ] The Mentra wearer is paired and in encounter mode as in the checklist above.
- [ ] The phone stays unlocked with the Cue page in front; background and locked
      behavior is not verified.

Script change: at 0:25 the Mentra wearer swipes backward; at 0:40 the Meta wearer
double taps the right temple instead of tapping "Interested". Everything else is
the same.

Say aloud:

"One person signals with a backward swipe on Mentra Live. The other uses Meta
glasses, where the gesture is a double tap, not a swipe. On the Meta side Cue
receives a headset media command from the phone. That shows a Bluetooth headset
sent a command; it does not verify that the glasses are Meta glasses, and
another headset would do the same. Cue matches each signal
with the closest person who signalled in the same place within 15 seconds."

Fallback: if the Meta taps do not arrive, the Meta wearer taps "Interested" in
the web app, and say that this is not the glasses path.

## Reset between runs

A match belongs to the pair: while Alex and Sam have an active match, a new
swipe does not create a second one. Between runs, end the match first.

- "Demo controls" on the Encounter page, then "Reset demo". This ends the matches
  you made in the last 12 hours and clears your pending signal, so the same pair
  can match again. It also deletes their chat messages. Each person resets their
  own side; ending the match ends it for both. "End demo" does the same and also
  checks you out of the venue, turns Encounter mode off and forgets your
  location. Use these between demo runs.
- `pnpm stack:reset` from the repository root. This re-applies migrations and
  seed data and clears everything for all accounts, including glasses pairing,
  venues and check-ins. Use it only when the app state is beyond a demo reset.
  Restart `pnpm dev` if it was stopped.

After "Reset demo", both accounts are still checked in and Encounter mode is
still on; confirm "Ready" on both. After "End demo" or `pnpm stack:reset`, sign in
again if needed, turn Encounter mode on, check in again (host or scan the venue),
and pair the glasses again after a stack reset.

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
| "Not ready" on a phone, location blocked, too rough, or out of date | Check in at the venue instead: scan the QR code or type the code. Keep the Cue page open and in front. "Try location again" retries the browser's location. |
| Two phones are in the same room but do not match | Check both read "Ready", both signalled within 15 seconds, and neither has an active match with the other (reset). If using location, indoor accuracy may put them more than 40 m apart on paper: use a venue check-in. |
| Glasses are unlinked, or the swipe does not arrive | Generate a new pairing code in the web app and pair the glasses again. If the hardware path cannot be recovered in the time available, say so openly. Then show the web input for both sides, and state clearly that this is not the glasses path and does not test the swipe. |
| No wingman line is heard | Check the "Wingman voice" switch, the phone's volume and that the match screen shows "Your wingman". The line plays once per match per tab; a new match is needed to hear it again. If Claude is slow or fails, a fixed line is used instead. If nothing shows, move on: matching does not depend on it. |
| Claude times out or returns an error | The card shows a retry state. Tap retry once. If it fails again, move on. Matching is not affected, and chat does not use Claude. |
| A chat message does not appear on the other screen | Realtime is only a nudge. Reload the match page: the message is stored and loads through the API. If sends fail with a rate-limit error, wait ten seconds. |
| Realtime notification is late | Refresh the matches page. The match is stored and appears after a refresh. |
| A third person asks "what if someone else signals?" | Say plainly that it can take the match. If Riley (`riley@cue.demo`) is checked into the same venue and signals within the window, Cue pairs with the closest person if locations are usable, otherwise the most recent signal. Do not stage this unless you want to show the limit. Riley sees no profile or match data of Alex's and Sam's unless Riley matches. |

## Likely questions

**Does Sam know when Alex signals?**
No. A one-sided signal is not shown to the other person. There is no
notification, count, or timing signal for Sam. Sam only sees a match when both
signals have arrived within 15 seconds, in the same place.

**Can it match me with the wrong person?**
Yes. Cue pairs you with the closest other person who signalled within 15 seconds
in the same place. In a crowd that may not be who you meant. Phone location is
often off by 10 to 30 m indoors, and a venue check-in does not say who meant
whom. The match screen offers "Not who you meant? Unmatch". Until you unmatch,
that person can see whatever you share with matches.

**Where is my location stored?**
Only while Encounter mode is on, in one table the browser cannot read, and
deleted when you turn the mode off or after ten minutes without an update. It is
never shown to anyone, saved with a match, or sent to Claude. A match keeps only
the venue's name or "Nearby". Location can also be faked by a modified client.

**What does Claude see?**
Only the fields that each person approved for sharing and for AI assistance
(interests, bio, personality cards, character, MBTI, what they are looking for,
city, work or school, education), plus the venue's name when the match was made at a venue (not for a "Nearby"
match, and never a location). The spoken wingman line on a match is built from
the same checked shared items and opener, and also sends the other person's
display name, which "Find common ground" does not. It is requested
automatically on a match and falls back to a fixed line if either person has AI
assist off. It never sees age,
gender, ethnicity, drinking, smoking or drugs, and it never sees chat messages.
It returns one opening question and does not send it: "Use this opener" only
fills the message box. Every "you both..." line has to be backed by a quote that
appears in both people's supplied text. Profile text is treated as data, not
instructions. The card is shown only to the person who asked for it.

**Can people swap phone numbers in chat?**
Yes, if they type them. Cue removed external social links and does not make links
clickable, which lowers exposure, but it cannot stop someone typing their own
contact details. Say so plainly.

**Is the age checked?**
No. It is self-declared, 18 to 99. Nothing about a person is verified.

**What if someone sends something abusive?**
Either person can Unmatch or Block, which ends the match and deletes the
conversation. There is no message reporting or moderation beyond that.

**Why 15 seconds?**
It is the proposed matching window in `docs/spec.md` (section 3). It keeps the
two signals close together in time, so a match means both people signaled
around the same moment. It is a proposed default, not a measured value.
