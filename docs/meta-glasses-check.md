# Meta glasses check — Meta Adventurer tap signal

For the person holding the Meta Adventurer glasses and an iPhone. Follow top to
bottom; it should take about ten minutes. The first three steps decide whether
the route works at all. Fill in the table at the end and commit it.

> **Status: the on-device checkpoint is NOT met (only partly seen).**
> On 2026-11-15 the owner reported that a real Meta double tap reached the live
> site under place-based matching. The two accounts were already matched, so no
> new match was created in that run, and nothing else was recorded: not the
> iPhone model or iOS version, not the command list, not the other gestures,
> background or locked behavior, or audio. Pairing a Meta double tap with a
> Mentra swipe into a new match by place has not been seen. (The Mentra swipe
> alone was verified on 2026-11-14 under the old session model.)
> **Nothing about voice (below) has been tried on a device.**
> Automated tests cover the server path and the page logic only (a scripted
> media command is not a tap on a temple). The checkpoint is met when steps 1
> to 4 below pass on the glasses and the table is filled in.

## What was chosen and why

**Runtime: the Cue web app in Safari on the iPhone, using the browser's Media
Session API.** There is no native app and no pairing code. The wearer signs in,
opens Encounter, and taps "Listen for my glasses" on the "Meta glasses" card.
The page plays a very quiet looping track to hold the phone's audio session and
receives standard headset media commands. One chosen command (default: double
tap, which arrives as next track) is sent as an interest signal with
`source: "headset_remote"`, authenticated by the web session. The server
treats it like any other signal: a Mentra Live swipe and a Meta double tap from
two people in the same place (a shared venue check-in, or phones within 40 m)
within 15 seconds create one match. The page is open on the phone by definition,
so it also reports the phone's location while Encounter mode is on.

Per Meta's help page (seen only as a search snippet, not verified on hardware):

| Gesture on the right temple | Expected media command |
|---|---|
| Single tap | play/pause |
| Double tap | next track |
| Triple tap | previous track |
| Swipe | volume (not visible to a web page) |
| Tap and hold | Meta AI (not visible to a web page) |

Alternatives that were looked at (sources: Meta's public GitHub repos and
packages; Meta's developer docs site was not reachable from the build
environment):

| Alternative | Blocker |
|---|---|
| Reuse the Mentra mini app | MentraOS has no driver for Meta glasses (the `@mentra/bluetooth-sdk` 3.4.0 device list has none). |
| Meta Wearables Device Access Toolkit (iOS Swift package `meta-wearables-dat-ios`, v1.0.1) | Temple-touchpad events exist only in the experimental `MWDATInputs` module (`InputSource.captouch`). It needs Inputs enabled for the app in Meta's Wearables Developer Center, a native iOS build (Mac, Xcode 26.4+, iOS 17.2+), and cannot be published. Not possible the same day. |
| Community Expo wrapper `@chrisgocode/expo-meta-wearables-dat` | Same toolkit limits; adds a third-party dependency. Not evaluated on a device. |
| Meta wearer taps "Interested" in the web app | Works today, but it is not a glasses signal. This is the fallback. |

### What this route does and does not show

- `headset_remote` shows that **a Bluetooth headset connected to that phone sent
  a media command**. It does **not** prove the command came from Meta glasses.
  AirPods, or any headset that sends "next track", would trigger it too.
- The Meta gesture is a **tap pattern**, not the backward swipe used on Mentra
  Live. Swipes on the Meta temple change volume and do nothing here.
- Unknown until tested on the device: whether the taps arrive as media commands
  at all; whether iOS keeps delivering them with Safari in the background or
  the phone locked; whether the Meta AI app or a music app takes over the
  audio; whether confirmation tones are audible in the glasses.

## 0. What you need

- An iPhone with Safari.
- The Meta glasses paired to the iPhone and set as its audio output (iOS:
  Control Center or Settings, Bluetooth). Note the Meta AI app version.
- A Cue account for the wearer, and the live site at `https://<cue-web-origin>`.
- For step 4: a Mentra Live wearer with the miniapp paired
  (`docs/hardware-check.md`), a second account, and both in the same place
  (checked into the same venue, or phones within 40 m of each other). Each
  account needs its own browser profile or device.

## 1. Start listening

1. On the iPhone, open `https://<cue-web-origin>` in Safari and sign in as the
   Meta wearer. Put the glasses on.
2. Open Encounter. Turn on Encounter mode and allow location, or check in at a
   venue; the "Where you are" card must read "Ready". Find the "Meta glasses"
   card.
3. Tap "Listen for my glasses". iOS needs this tap before it allows audio.
4. Confirm the card says it is listening. The track is very quiet: listen for it
   **in the glasses**, and check it is not coming from the phone speaker. If it
   plays from the phone speaker, the glasses are not the audio output; fix that
   and tap again.

## 2. Read the command list (decides whether the route works)

With the card open and listening, tap the right temple **once**, then **twice**,
then **three times**, pausing a couple of seconds between patterns. Look at
"Last command:" and the list of received commands.

| You do | Expected in the list |
|---|---|
| One tap | "Play (single tap)" or "Pause (single tap)" |
| Two taps | "Next track (double tap)" |
| Three taps | "Previous track (triple tap)" |

Record exactly what appears, including anything unexpected.

**If nothing appears, the route does not work on this device.** Stop and report.
Fallbacks: the Meta wearer uses the "Interested" button in the web app
(`docs/demo.md`), or the native toolkit route below is built later.

If the list shows commands but not the ones expected, write down what each
pattern produced. A different mapping is still usable: pick it in step 3.

## 3. Choose the signal command

In the list, tap "Use as my signal" on the command you want to send. The default
is double tap (next track). The choice is stored in the browser on that phone.
Tap the chosen pattern once and confirm the card shows a signal outcome. A
signal with Encounter mode off, or with no place ("Not ready"), shows a reason,
not silence.

## 4. Cross-glasses match with a Mentra wearer

Both accounts are in the same place (same venue check-in, or phones within 40 m),
both "Ready" with Encounter mode on. The Meta page is still listening. Keep other
people out of the test: a signal pairs with the closest person who signalled.
This is also the first time a Mentra swipe and a Meta double tap are paired by
place; it has not been done before.

1. Mentra wearer swipes backward. Within 15 seconds the Meta wearer double
   taps. Both screens should show "It's mutual."
2. End the match (Demo controls, reset). Repeat in the other order: Meta
   double tap first, then the Mentra swipe within 15 seconds.
3. One-sided check: Meta double tap alone, wait 20 seconds. The Mentra wearer's
   page shows nothing, and no match appears later.

## 5. Negative checks

For each, do it five times with listening on and the chosen command set to
double tap. Confirm no signal is sent (the card shows why it ignored it).

- Single tap, and triple tap.
- Swipes along the temple (volume changes; nothing sent).
- Hair adjustments: tuck hair behind the ear on the touchpad side, push the
  glasses up by the temple, take them off and put them on. Ten of each. Record
  any accidental double tap or other command.
- Phone locked and in a pocket, one minute, then double tap. Check whether a
  signal arrives.
- Safari in the background (another app in front), then double tap. Also note
  whether the phone's location still updates: the page reports it only while
  visible, so a venue check-in is the safer way to stay "Ready".
- Another audio app or Meta AI takes over: start music or invoke Meta AI, then
  double tap. Note whether commands still reach the Cue page, and whether the
  quiet track resumes.
- Tones: the "sent" and "not sent" confirmation tones are audible **in the
  glasses**, and roughly how late.
- Two double taps within a second: one signal.

## 6. Voice (NOT YET VERIFIED)

Meta glasses have no app of their own here: they are the phone's Bluetooth
headset. Two features use that. **Neither has been tried on a device.** Tick an
item only after seeing it happen. Background: `docs/guest-accounts.md` and "The
spoken line" in `docs/profiles-and-chat.md`.

Spoken guest sign-up (the glasses' microphone as the phone's input):

1. Sign out on the iPhone and open the sign-in page in Safari, with the glasses
   as the audio device. Tap "Say hi" on the card "New here? Just say hi". Safari
   should ask for the microphone. Record whether "Say hi" is shown at all (if
   not, the card says "Voice entry isn't available in this browser, so type your
   name below.").
2. Say "Hi, my name is" and a first name. Record: does the card show
   `Heard: "..."`; is the audio taken from the glasses' microphone or the phone's;
   and does the page say "Yo <name>, you're in." and is it heard in the glasses
   or the phone speaker. Typing the name always works as a fallback.
3. Note that the browser sends the audio to its vendor's service to transcribe
   it (Cue only receives the text). Record any network failure message.

Spoken match line:

4. With "Listen for my glasses" on and the Encounter page open, match with
   another account in the same place. The match screen should show "Your wingman"
   with one or two sentences, and the phone should say them. Record whether it was
   heard in the glasses, whether it came after the signal tones, and whether
   "Wingman voice" off silences it (the text still shows).
5. Does the line play when Cue is in the background or the phone is locked? It is
   expected not to: the page speaks only while it runs, and speech after a
   gesture needs the page open. Record what happens.
6. Does the quiet track from "Listen for my glasses" still play, and do double
   taps still arrive, after the line has been spoken?

## What a failure means

| Observation | Meaning |
|---|---|
| No quiet track in the glasses | The glasses are not the phone's audio output, or Safari blocked audio. Retry the tap; check Bluetooth routing. |
| Taps never appear in the list | The glasses do not send media commands to the browser on this setup. The route does not work here. |
| Taps appear only with the screen on and Safari in front | iOS stops the page in the background. The wearer must keep the page open; note this in the demo. |
| Commands stop after music or Meta AI is used | Another app took the audio session. Tap "Listen for my glasses" again; record it as a limitation. |
| A different command than expected for a pattern | The help-page mapping is wrong for this unit. Choose the command that arrives, via "Use as my signal". |
| A signal is sent by accident | The chosen pattern is too easy to trigger. Record it; consider triple tap or the "Interested" button for the demo. |
| A non-Meta headset triggers it | Expected. This is the "not proof of device" limit. |
| Match works with the button but not the glasses | The server path is fine; the failure is in the device chain above. |

## Results (fill in on site)

| Item | Value |
|---|---|
| Date / tester | |
| iPhone model, iOS version | |
| Meta AI app version | |
| Glasses firmware / software version | |
| Quiet track heard in the glasses (not phone speaker)? | |
| Command shown for one tap | |
| Command shown for two taps | |
| Command shown for three taps | |
| Swipe produces anything in the list? | |
| Command chosen as signal | |
| Step 4: Mentra swipe then Meta tap, match? | |
| Step 4: Meta tap then Mentra swipe, match? | |
| One-sided Meta tap invisible to the other wearer? | |
| Single / triple tap send nothing? | |
| Hair-adjustment accidental signals (n / 10 each) | |
| Phone locked in pocket works? | |
| Safari in background works? | |
| Meta AI or music app takes over audio? | |
| Tones audible in the glasses? Delay? | |
| Route used (web media commands / button fallback) | |
| Real Meta double tap reached the live site under place-based matching? | Reported yes by the owner on 2026-11-15 (accounts already matched, no new match). iPhone, iOS and details not recorded |
| Voice 1 to 3: "Say hi" shown, name heard, greeting heard in the glasses? | not yet recorded (never tried) |
| Voice 4: spoken match line heard in the glasses? | not yet recorded (never tried) |
| Voice 5: line spoken with Cue in the background or locked? | not yet recorded (never tried) |
| Voice 6: quiet track and double taps still work afterwards? | not yet recorded (never tried) |

## Long-term route: native toolkit integration

The proper integration is a native iOS app using Meta's Wearables Device Access
Toolkit (`github.com/facebook/meta-wearables-dat-ios`, v1.0.1), which would
read the touchpad directly instead of inferring it from media commands. It is
**not built**.

Prerequisites and blockers:

- The experimental `MWDATInputs` module (`InputSource.captouch`) is the only
  toolkit path to temple-touchpad events. It requires Inputs to be enabled for
  the app in Meta's Wearables Developer Center, and apps using it cannot be
  published.
- A Mac with Xcode 26.4 or newer, an iPhone on iOS 17.2 or newer, and the
  glasses connected through the Meta AI app.
- Toolkit version 0.8.0 added "Meta Glasses" device support two days after the
  Adventurer launch. Support for the Adventurer by name is inferred, not
  confirmed.
- A stable fallback inside the toolkit: a single tap pauses a running camera
  stream, which the app can observe. It is a single fixed gesture and needs a
  camera stream running.
- A community Expo wrapper, `@chrisgocode/expo-meta-wearables-dat`, could
  shorten the build. It has not been evaluated.
- The app would send the same `InterestEvent` to the same API. It would need a
  device-token style credential or the web session; today a device token is
  accepted for `mentra_touch` only (`docs/architecture.md`).
