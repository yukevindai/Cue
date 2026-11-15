# Snap Spectacles check

What has and has not been verified for the Spectacles client
(`apps/spectacles`), and the on-device steps to verify the rest.

## Verified (2026-11-15, build environment, no Spectacles)

- Core logic unit tests: double-pinch detection, debounce, encounter gate,
  retries with the same `eventId`, unlink on 401, token never logged, and
  contract parity with `@cue/contracts` (`pnpm --filter @cue/spectacles test`).
- The real Core `CueClient` (the code the Lens runs, with a Node `fetch`
  transport in place of `InternetModule`) against the local stack and the real
  Next.js server: claimed two real pairing codes, polled `/api/devices/me`, a
  double pinch on A was `accepted` and stored as `spectacles_hand` /
  `double_pinch`, a double pinch on B returned `matched: true`, one match row,
  cues `signal_sent` for A and `match` for B, pairing code absent from logs.
- Server: stack tests for `spectacles_hand` (device token accepted, web session
  refused with 403, one-sided signal invisible to the other person, Spectacles
  plus Mentra makes one match, SQL refuses wrong pairs).

## Not verified

- `CueLens.ts` compiles in Lens Studio 5.24 (2026-11-15) after making the Core
  result unions narrow without strictNullChecks; it has not run on Spectacles. The
  API names come from the Spectacles docs (Gesture Module, Internet Access,
  Keyboard) and may need small fixes on first open.
- Whether a double pinch is comfortable and reliable in a real conversation,
  and how often normal hand movement triggers a false one.
- The system keyboard flow for the pairing code.
- Audio levels of the three cues on the Spectacles speakers.

## On-device steps

1. Set up the Lens as in `apps/spectacles/README.md` with **Server Url** = the
   live site (https). Push to Spectacles.
2. Fix any Lens Studio compile errors in `CueLens.ts` only. Core/ should not
   need changes; if it does, keep `pnpm --filter @cue/spectacles test` green.
3. Pairing: on a phone, sign in, Encounter, "Link glasses". In the Lens, double
   pinch, type the code, press return. Expect "Linking..." then "Linked. Turn on
   encounter mode in Cue". The web card should show "Snap Spectacles" and the
   double-pinch hint.
4. Turn on encounter mode on the phone. Within about 2 s the Lens shows
   "Encounter on. Double pinch to signal".
5. Single pinch 10 times with pauses. Expect nothing sent (no "Signal sent").
6. Double pinch once. Expect the soft beep and "Signal sent", and on the phone
   `GET /api/encounter` shows `pendingSignal.source = "spectacles_hand"`.
7. Have the other person signal (any route) within 15 s. Expect the match in
   both web apps. If the Spectacles wearer signals second, the Lens plays the
   two-note match cue.
8. Turn encounter mode off, double pinch, turn it back on. Expect no signal (not
   replayed).
9. Unlink in the web app. Within about 2 s the Lens returns to "Not linked".
10. Record what happened, including false double pinches from normal gestures,
    in the status log in `AGENTS.md`.
