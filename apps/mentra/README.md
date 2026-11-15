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
install QR code for the Mentra app's developer scanner. Not yet verified on a
phone: see `docs/hardware-check.md`, step 2. Bump `version` in `miniapp.json`
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
2026-11-14, under the old session model. It has not been re-verified under place
matching, and the new audio cues (mode off, no place) have not been heard on a
device.
