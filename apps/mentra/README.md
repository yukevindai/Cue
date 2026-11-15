# @cue/mentra — glasses bridge

A MentraOS local miniapp (`@mentra/miniapp` 3.4.0) that turns one backward
swipe on the Mentra Live temple touch strip into one `InterestEvent` on the Cue
API. On-site steps, evidence for the runtime choice and what is still
unverified on hardware: `docs/hardware-check.md`.

```
raw touch event -> touch-events.ts (normalize, classify, debounce)
                -> encounter-context.ts (encounter mode + place gate, no replay)
                -> pipeline.ts (InterestEvent, one eventId per gesture)
                -> api-client.ts (device token, bounded retry with the same eventId)
                -> feedback.ts / tones.ts (audio cue)
```

| File | Role |
|---|---|
| `src/background/index.ts` | Runtime entry point; the only file that calls the Mentra SDK |
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

`MENTRA_PUBLIC_CUE_SERVER_URL` sets the default Cue web origin at build time.
The device token lives only in the miniapp's storage and is never logged.
