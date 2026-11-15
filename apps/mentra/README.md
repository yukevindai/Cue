# @cue/mentra — glasses bridge

A MentraOS local miniapp (`@mentra/miniapp` 3.4.0) that turns one backward
swipe on the Mentra Live temple touch strip into one `InterestEvent` on the Cue
API. On-site steps, evidence for the runtime choice and what is still
unverified on hardware: `docs/hardware-check.md`.

```
raw touch event -> touch-events.ts (normalize, classify, debounce)
                -> encounter-context.ts (forwards only when the server says the
                   wearer is `ready`: mode on and a place; no replay)
                -> pipeline.ts (InterestEvent, one eventId per gesture)
                -> api-client.ts (device token, bounded retry with the same eventId)
                -> feedback.ts / tones.ts (audio cue)
```

| File | Role |
|---|---|
| `src/background/index.ts` | Runtime entry point; the only file that calls the Mentra SDK |
| `src/encounter-context.ts` | Polls `GET /api/devices/me` (about every 2 s). A swipe is forwarded only on `ready`. Otherwise it is dropped and a cue plays: "mode off", or "no place: open Cue on your phone" |
| `src/config.ts` | **The gesture mapping** (`DEFAULT_BACKWARD_SWIPE_GESTURE_NAME`) and storage keys |
| `src/bridge.ts` | Wires the modules against a host interface (miniapp, tests, harness) |
| `src/account-link.ts` | Pairing-code claim and device token storage |
| `src/ui/` | Phone setup screen: server URL, pairing, calibration, sound check |
| `src/dev/inject.ts` | Script that injects a raw event to test the server path. Not a swipe |

```bash
pnpm typecheck && pnpm lint && pnpm test   # no Mentra credentials or Bun needed
pnpm miniapp:build                         # dist/ (Node >= 22.18 or Bun)
pnpm miniapp:dev                           # needs Bun; prints the install QR
pnpm inject --server http://localhost:3000 --code ABC123 --gesture backward_swipe
```

**Installing without a laptop.** Every web build also builds this miniapp and
publishes its release files under `/mentra/` on the site
(`apps/web/scripts/build-mentra-bundle.mjs`). The page `/mentra` shows the
install QR code for the Mentra app's developer scanner. The owner reported
(2026-11-15) that this worked on their phone with no laptop; versions and exact
steps were not recorded (`docs/hardware-check.md`, step 2). Bump `version` in `miniapp.json`
when the bundle changes, so phones take the new one.

`MENTRA_PUBLIC_CUE_SERVER_URL` sets the default Cue web origin at build time.
The device token lives only in the miniapp's storage and is never logged.

**Where the wearer is.** The glasses do not report a location. The wearer's place
comes from their phone, on the same Cue account: a venue check-in, or the
location reported by the open Cue page while Encounter mode is on. For a swipe to
count, Encounter mode must be on and the server must report the wearer as
`ready`. Matching is by place, not by a pre-joined session: see
`docs/place-matching.md`.

**Verification.** A real swipe was verified on one Mentra Live unit on
2026-11-14, under the old session model. On 2026-11-15 the owner reported that a
real swipe reached the live site under place matching; the two accounts were
already matched, so no new match was created in that run, and a new match by
place from real glasses has not been seen. The new audio cues (mode off, no
place) have not been heard on a device.

**Guest by voice and spoken match line (0.3.0).** *Nothing in this section has
been tried on a device.*

- **Guest by voice.** While a server address is set and the glasses are not
  linked, the mini app listens through the glasses' microphone
  (`session.transcription.forLanguage("en-US", ...)`; `MICROPHONE` permission in
  `miniapp.json`, offered only when the manifest declares it). Only a final
  transcript is used, and only if `parseIntroName(text, {requireLeadIn: true})`
  finds a real introduction ("Hi, my name is Sam", "I'm Sam"); a bare name or
  chatter is ignored. That one transcript goes to `POST /api/guest/device`
  (label "Mentra Live"); the returned device token is stored like a pairing
  token, the glasses say "Yo Sam, you're in. Open Cue on your phone." and
  listening stops. At most one attempt per 5 s; after 5 failures it stops until
  the setup screen is reopened (failure line: "Couldn't set that up. Try again
  in a bit."). No transcript is kept; one is logged only at debug level. Pairing
  codes still work. The microphone stays open for as long as the glasses are not
  linked.
- **Open Cue as {name}.** The setup screen shows this button for a guest account.
  It asks the background for `POST /api/guest/handoff` and opens the one-time URL
  with `session.system.openUrl`; an "Open Cue" link on the screen is the fallback.
  The path is a secret and is kept out of logs.
- **Spoken match line.** When `GET /api/devices/me` reports a new `latestMatchId`
  (the wearer's newest active match under 5 minutes old), `POST /api/devices/hype`
  is called once per match (id kept in storage, remembered before the request, one
  retry on failure) and the returned line is spoken about 1.2 s later, after the
  swipe's tone. While glasses are seen by the server, the web page does not speak
  it as well (it checks the device was seen in the last 30 s).

Hardware checklist: `docs/hardware-check.md` step 11. Code: `guest-intro.ts`,
`match-hype.ts`, `speech.ts`, `bridge.ts`. Unverified: the microphone
permission, whether transcription events reach a locally installed mini app,
`openUrl` on a phone, and speaking through the glasses. Background:
`docs/guest-accounts.md`.
