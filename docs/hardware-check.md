# Hardware check — Mentra Live backward swipe

For the person holding the loaner glasses. Follow top to bottom; it should take
under ten minutes once the laptop tools are installed. Fill in the table at the
end and commit it.

> **Status: the real-swipe checkpoint was MET (2026-11-14), under the old
> session model. It has NOT been re-verified under place-based matching.**
> Matching no longer needs a pre-joined session: it needs Encounter mode on and
> a place for the wearer (see step 6). The steps below were updated for that;
> nobody has run them on a device. The 2026-11-14 result below was recorded when
> the wearer had joined a two-person demo session.
> On a real Mentra Live unit, seven real backward swipes reached the live
> server under the wearer's account in about 0.2 to 0.3 s, and two completed
> matches. One caveat: on that unit the gesture name for the toward-the-ear
> swipe was **not** the built-in default `backward_swipe`. The tester had to tap
> "Use as backward swipe" in the mini app's calibration list. The exact name
> shown was not recorded, so the default in `apps/mentra/src/config.ts` is
> still wrong for that unit. Not yet recorded: the media-control conflict, hair
> adjustments, the pocket test, and audio from the glasses. The Meta Adventurer
> tap route is separate: `docs/meta-glasses-check.md`.
>
> **2026-11-15, reported by the owner (details not recorded):** the mini app was
> installed from the website (step 2, "From the website") on the owner's phone
> with no laptop, and a real Mentra swipe and a real Meta double tap each reached
> the live site under place-based matching. The two accounts were already
> matched, so no new match was created in that run. Still NOT verified: a new
> match by place completed by real hardware (step 6, item 5), steps 7 to 10, and
> everything in step 11 (voice). **Nothing about voice has been tried on a
> device.**

## What was chosen and why

**Runtime: a MentraOS local miniapp** (`@mentra/miniapp` 3.4.0), background
layer. It runs inside the Mentra phone app, receives touch-strip events, and
calls the SocialEyes API with a device token. Code: `apps/mentra`.

Evidence (read from the published packages on 2026-11-14, nothing run on a device):

| Finding | Source |
|---|---|
| Miniapp API: `session.input.onTouch(handler)` subscribes to stream `touch_event`; payload type `TouchData { kind: string }` | `@mentra/miniapp@3.4.0` `src/modules/input.ts`, `src/modules/events.ts`, `src/protocol.ts` (`TOUCH_EVENT = "touch_event"`) |
| The phone app forwards the Bluetooth event unchanged and copies `gestureName` into `kind` | MentraOS `main`, `mobile/modules/engine/src/services/LocalMiniappRuntime.ts` (touch fan-out) |
| Bluetooth event: `touch_event` with `{ type, deviceModel, gestureName, timestamp }` (timestamp is phone receive time) | `@mentra/bluetooth-sdk@3.4.0` `src/BluetoothSdk.types.ts`, `src/index.ts` |
| Mentra Live gesture names, from firmware touch codes 0–7: `single_tap`, `double_tap`, `triple_tap`, `long_press`, `forward_swipe`, `backward_swipe`, `up_swipe`, `down_swipe` | `@mentra/bluetooth-sdk@3.4.0` `android/.../sgcs/MentraLive.kt` `mapK900GestureType`, `TouchGesture.kt` (same in iOS) |
| The miniapp type hints (`swipe_up`, `swipe_down`) are a different device's names; on Live expect `backward_swipe` | same files; `sgcs/G2.kt` |
| Stock touch actions exist (play/pause on `double_tap`, volume, previous/next). Claim/restore is `setTouchGestureDefaultBehaviorEnabled(gesture, enabled)` in the **Bluetooth SDK only**, needs firmware support, resets on disconnect. The miniapp SDK has no claim API | `@mentra/bluetooth-sdk@3.4.0` `README.md` "Claiming touchpad gestures"; grep of `@mentra/miniapp` |
| Audio: `session.speaker.play({audioUrl})` / `speak(text)`; played by the phone, reaches the glasses over Bluetooth audio | `@mentra/miniapp@3.4.0` `dist/modules/speaker.d.ts`; MentraOS `AudioPlaybackService.ts` |
| `@mentra/sdk` (cloud app server) is ruled out: npm marks it deprecated, "not compatible with the current Mentra App" | `npm view @mentra/sdk deprecated` |

Not confirmed anywhere in those sources (so these are the device checks):
which physical direction `backward_swipe` is; whether the Mentra app on the
phone you have forwards Live touch events to miniapps; whether a stock action
also fires on a swipe; whether events keep arriving with the phone locked;
whether the cue comes out of the glasses. `docs.mentraglass.com` and GitHub
HTML pages were not reachable from the build environment, so nothing there was
checked.

## 0. Before you start (laptop)

- Bun ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`) — the Mentra CLI needs it. Node 22 and pnpm for the repo.
- `pnpm install` at the repo root.
- The SocialEyes web app reachable **from the phone**: the deployed HTTPS URL, or an
  HTTPS tunnel to `pnpm dev`. `http://<laptop-ip>:3000` on shared Wi-Fi may work
  on iOS; on Android plain HTTP from a miniapp is unconfirmed, so prefer HTTPS.
- Phone: the Mentra app, signed in, glasses paired and connected in it.
- No Mentra developer account, API key or app registration is needed for a
  QR-installed dev build.

## 1. Record versions

Write these in the table at the end: Mentra app version (app → Settings →
About), glasses firmware / software version (app → glasses/device settings),
phone model and OS. If the app offers a glasses update, take it first and note it.

## 2. Install the miniapp on the phone

**From the website (no laptop, no shared Wi-Fi).** Open
`https://<cue-web-origin>/mentra` on a computer or a second phone. On the phone
with the Mentra app: **Settings → Developer settings → Mini App Development →
Scan Mini App QR Code**, and scan the code on that page. If the page is open on
the Mentra phone itself, "Open in the Mentra app" is the same link. The site
serves the files `mentra-miniapp release` serves (`/mentra/miniapp.json`,
`/mentra/icon.png`, `/mentra/bundle.zip`), built by
`apps/web/scripts/build-mentra-bundle.mjs` with every web build; the server
address is preset to the production site.

> **Reported working, not recorded.** The Mentra tool itself only generates links
> to a laptop on the local network (`http://<lan-ip>:<port>`). On 2026-11-15 the
> owner reported that the install from the public site worked on their phone with
> no laptop; the Mentra app version, phone and exact steps were not recorded, so
> fill them in the table at the end next time. If it refuses, use the laptop
> install below, which is unchanged.

**From a laptop (development, and the fallback).**

```bash
cd apps/mentra
MENTRA_PUBLIC_CUE_SERVER_URL=https://<cue-web-origin> pnpm miniapp:dev
```

A QR code prints. On the phone: Mentra app → **Settings → Developer settings
→ Mini App Development → Scan Mini App QR Code** (wording printed by the CLI;
older builds may say "Miniapp Developer Settings"). Phone and laptop must be on the same Wi-Fi; on Android with
USB debugging, `bun x mentra-miniapp dev --usb` avoids that. Keep the terminal
open: miniapp logs appear there, prefixed `[cue-mentra]`.

If no such developer setting exists in this app build, or the
manifest is refused (`minHostVersion` is 1.42.0), stop and go to "Fallback".

For the demo itself, when the laptop will not be nearby:
`MENTRA_PUBLIC_CUE_SERVER_URL=… pnpm miniapp:release`, scan that QR instead.

## 3. Open "SocialEyes" in the Mentra app and set the server

If the Server field is empty or wrong, enter the web origin (no path) and Save.
The second pill should leave "Server unreachable".

## 4. Pair with an account

In the SocialEyes web app, signed in as the wearer (`alex@cue.demo` / `cue-demo-123`
locally), open the encounter page and request a pairing code (it calls
`POST /api/devices/pair`). Type the 6 characters into "Pair" in the miniapp
within the code's lifetime. Expect the pill "Paired". The web encounter page
should now show the device as linked ("Mentra Live").

## 5. Calibrate: which raw gesture is "backward"?

1. Tap **Start calibration** (orange pill: nothing is sent in this mode).
2. Wearing the glasses, slide one finger along the temple strip **toward your
   ear**. Look at the top row of the gesture list (also in the laptop log as
   `CALIBRATION raw gesture: "…"`). Do it five times.
3. Slide **toward the lenses** five times. Then single tap, double tap, long press.
4. Write the names in the table. The published SDK source suggests
   `backward_swipe` for toward-the-ear, but on the unit tested on 2026-11-14
   that default did NOT match and the override below was needed.
   If a different name shows up for toward-the-ear, tap **Use as backward
   swipe** on that row (stored on the phone), and also change
   `DEFAULT_BACKWARD_SWIPE_GESTURE_NAME` in `apps/mentra/src/config.ts`.
5. If **no rows appear at all**, the phone app is not forwarding Live touch
   events to miniapps: go to "Fallback".
6. Tap **Stop calibration**.

## 6. First checkpoint: a real backward swipe reaches the server under the right account

1. In the web app on the wearer's phone (same account as the paired glasses),
   turn on Encounter mode and give SocialEyes a place: allow location, or check in at a
   venue ("Host a place", or scan a venue's QR code / "Enter a venue code"). The
   "Where you are" card must read "Ready". The glasses cannot report where the
   wearer is: the place always comes from the phone. Keep the SocialEyes page open on
   the phone if relying on location. The miniapp pill turns to "Encounter mode
   ON" within ~2 s. The miniapp forwards a swipe only once the server reports
   the wearer as ready; otherwise it drops it and plays a cue.
2. Swipe backward once on the glasses.
3. Look at all three:
   - Miniapp: "Last swipe: submitted: accepted".
   - Web app, wearer's encounter page: "pending signal" appears, source
     `mentra_touch` (`GET /api/encounter` → `pendingSignal.source`).
   - Server database (local stack):
     ```bash
     psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
       "select u.email, e.source, e.gesture, e.status, e.received_at from interest_events e join auth.users u on u.id = e.user_id order by received_at desc limit 3"
     ```
     The newest row must be the **wearer's email**, `mentra_touch`,
     `backward_swipe`, within a second or two of the swipe.
4. The other account's encounter page must show nothing.
5. For a match, a second person in the same place (same venue check-in, or a
   phone within 40 m) signals within 15 seconds. A signal pairs with the closest
   such person, so keep other people out of the test.

Only when this passes, change the status box at the top of this file.

## 7. Negative tests (encounter mode still on)

For each: do it five times, then confirm no new `interest_events` row and no sound.

- Forward swipe (toward the lenses).
- Single tap, double tap, long press.
- **Ordinary hair adjustments**: tuck hair behind the ear on the strip side,
  push the glasses up by the temple, take them off and put them on, scratch
  near the temple. Ten of each. Record how many produced a `backward_swipe`
  row in the gesture list. Any accidental activation goes in the table.
- Turn encounter mode off in the web app, wait 3 s, swipe backward: "Last
  swipe: ignored: encounter_mode_off", no row, and the "mode off" cue. Turn it
  back on: still no row until you swipe again (nothing is replayed).
- Encounter mode on but no place (location blocked and not checked in; the
  "Where you are" card says "Not ready"), wait 3 s, swipe backward: ignored as
  `no_place`, no row, and the "no place: open Cue on your phone" cue.
- Two backward swipes within one second: one row.
- Phone in airplane mode, swipe, airplane mode off: no row appears afterwards.

## 8. Media-control conflict

Start music on the phone so it plays through the glasses. Swipe backward and
forward, single/double tap. Record what the glasses do by themselves (volume
change, track skip, pause, any built-in beep). If a backward swipe also changes
volume or skips a track, the miniapp cannot suppress it (no API); note it, and
if it is unacceptable for the demo, that is a reason to use the fallback, which
can call `setTouchGestureDefaultBehaviorEnabled("backward_swipe", false)`.
Also check whether the swipe is still delivered while music is playing.

## 9. Audio feedback

In the miniapp's "Sound check", tap Sent, Match, Not sent. Record whether each
is heard **from the glasses** (not the phone speaker) and roughly how late.
If nothing is heard, check the glasses are the phone's active Bluetooth audio
output (iOS: Settings → Bluetooth). Then, in a real match (a second person in the same place taps
"Interested" in the web app within 15 s, either order), the wearer should hear
the single beep on their swipe and the two rising beeps if their swipe
completes the match. If their swipe came first, the match itself is announced
in the web app only.

## 10. Pocket test

Lock the phone, put it in a pocket, wait one minute, swipe backward, check for
the row. Record the result (the miniapp design says this works; untested).

## 11. Voice: spoken guest sign-up and the spoken match line (NOT YET VERIFIED)

Added in mini app version 0.3.0. **Nothing in this step has been tried on a
device.** Tick each item only after seeing it happen; leave it "not yet recorded"
otherwise. Background: `docs/guest-accounts.md`, and "The spoken line" in
`docs/profiles-and-chat.md`. These are demo-only conveniences; the swipe does not
depend on them.

Install the 0.3.0 bundle first (`version` in `apps/mentra/miniapp.json`), so the
phone has the MICROPHONE permission in the manifest. Note whether the Mentra app
asks for it.

A. Microphone permission and transcription (needs the glasses **unlinked**, so
   unlink first, or use a fresh install):

1. Open the Cue mini app. The setup screen should read "Say "Hi, my name is ..."
   to your glasses to start as a guest, or enter a pairing code." and show a
   "Listening..." pill. If the pill never appears, the microphone permission was
   not granted or transcription is not available to a locally installed mini
   app: record which, and stop here.
2. Say "Hi, my name is" and a first name, at normal volume. Expect the glasses to
   say "Yo <name>, you're in. Open Cue on your phone." and the pill to turn to
   "Paired". Record how long it took.
3. Say only a name, and then unrelated sentences, with the glasses unlinked.
   Expect nothing to happen (an introduction is required). Record any account
   created by accident.
4. The web app's Encounter page for that account should show the glasses linked.

B. Hand off to the phone:

5. Tap "Open Cue as <name>". Expect the phone's browser to open SocialEyes, signed in
   as that guest, on Encounter. If nothing opens, the "Open Cue" link below the
   button should work. Record which browser opened.

C. The spoken match line (needs a match by place, so another person or account in
   the same place; see step 6, item 5):

6. When a match is made, wait for the swipe's confirmation tone, then expect about
   a second later one or two short spoken sentences through the glasses. Record
   what was said and whether it came from the glasses or the phone speaker. A
   name-only account hears the fixed line ("Yo, <name> noticed you too. Go say
   hi."); a specific tip needs both people to share an interest (add one on
   Profile) and a working `ANTHROPIC_API_KEY` on the server.
7. The same match must be spoken only once: restart the mini app, or wait through
   several polls, and confirm it does not repeat.
8. With an account linked (by code or as a guest), confirm the "Listening..." pill
   is gone, i.e. the mini app stopped listening once linked. Unlink and confirm it
   starts listening again.

If any of A to C fails, the guest and voice features are simply unavailable; the
backward swipe, pairing by code and the web app are unaffected.

## Fallback: Bluetooth SDK bridge

Switch if any of these is true after 30 minutes on site: the Mentra app has no
miniapp developer install; no touch events reach the miniapp (step 5.5); the
stock swipe action cannot be tolerated (step 8).

Route: a minimal Expo development build using `@mentra/bluetooth-sdk` 3.4.0
(start from `Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit`,
`examples/react-native`). It needs Xcode or Android Studio and a physical
phone; expect 1.5–3 hours to a first event. Disconnect the glasses from the
Mentra app first (one phone app at a time). The binding is about ten lines,
because everything else in `apps/mentra/src` is SDK-independent:

```ts
BluetoothSdk.addListener("touch_event", (e) => void bridge.handleTouch(e)); // e.gestureName
await BluetoothSdk.setTouchGestureDefaultBehaviorEnabled("backward_swipe", false); // after every connect; may time out on older firmware
```

with a `BridgeHost` backed by AsyncStorage and `expo-audio` (see
`apps/mentra/src/bridge.ts`). This fallback is **not built**. Ask the Mentra
staff on site which route they support before spending the time.

## Lessons from the first on-site run

- **Windows QR code.** The Mentra CLI's QR code can point at a virtual network
  adapter (for example a VM or VPN adapter) that the phone cannot reach. Use the
  PC's real hotspot or LAN address instead.
- **`zip` on Windows.** The Mentra CLI needs a `zip` program on the PATH; install
  one before `pnpm miniapp:dev`.
- **Two different codes.** In the web app, the Glasses card's "Link glasses"
  code is the **pairing code** you type into the miniapp. A venue's six-character
  code (under its QR code) is for checking a phone in at a place. They are not
  interchangeable. (Before place matching, the second code was a session join
  code.)
- **One browser, one account.** Two tabs of one browser share one login. Give
  each demo account its own browser profile (or device).
- **Check the gesture name.** Do step 5 even if the default looks right: the
  default `backward_swipe` was wrong on this unit.

## Results (fill in on site)

| Item | Value |
|---|---|
| Date / tester | |
| Phone model, OS | |
| Mentra app version | |
| Glasses firmware / software version | |
| `@mentra/miniapp` / miniapp CLI version | 3.4.0 / 0.1.0-dev.0 |
| Miniapp dev install available? | |
| Raw gesture for swipe toward the ear | |
| Raw gesture for swipe toward the lenses | |
| Raw names seen for tap / double tap / long press | |
| Configured backward gesture (`config.ts` or UI override) | UI override ("Use as backward swipe"); the default `backward_swipe` did not match on this unit. Name shown: not recorded |
| Step 6 passed (real swipe → wearer's row)? | **Yes, 2026-11-14, under the old session model.** 7 real swipes reached the live server under the wearer's account in about 0.2 to 0.3 s; 2 matches completed. Not re-verified under place-based matching |
| Step 6 under place-based matching (Ready via venue or location)? | not yet recorded |
| "Mode off" and "no place" cues heard from the glasses? | not yet recorded |
| Forward swipe / taps submit nothing? | not yet recorded |
| Hair-adjustment accidental activations (n / 10 each) | not yet recorded |
| Stock action on backward swipe (volume, track, beep)? | not yet recorded |
| SocialEyes audible from glasses? Delay? | not yet recorded |
| Works with phone locked in pocket? | not yet recorded |
| Route used (miniapp / Bluetooth fallback) | miniapp |
| Mini app installed from the website with no laptop? | Reported yes by the owner on 2026-11-15; app version, phone and steps not recorded |
| Real swipe reached the live site under place-based matching? | Reported yes on 2026-11-15; accounts were already matched, so no new match was created. Details not recorded |
| Step 11: MICROPHONE permission granted, "Listening..." pill shown? | not yet recorded (never tried) |
| Step 11: spoken "Hi, my name is ..." creates and links a guest; glasses speak the greeting? | not yet recorded (never tried) |
| Step 11: chatter or a bare name creates nothing? | not yet recorded (never tried) |
| Step 11: "Open Cue as ..." opens the phone's browser signed in? | not yet recorded (never tried) |
| Step 11: spoken match line heard from the glasses, once per match? | not yet recorded (never tried) |
