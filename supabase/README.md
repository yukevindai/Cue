# Database and backend tests

`migrations/` holds the schema, RLS and the service-role SQL functions
(`submit_interest` is the matching authority). `seed.sql` creates three
synthetic accounts, password `cue-demo-123`: `alex@cue.demo`, `sam@cue.demo`
(overlapping interests with Alex) and `riley@cue.demo` (the third account).

## Running the stack-backed tests

```bash
pnpm stack:start                 # local Supabase
pnpm dev &                       # only needed for the HTTP-level tests
pnpm --filter @cue/web test      # apps/web/src/server/__stack_tests__
```

The tests create and delete their own throwaway users and never touch the
seeded accounts. Without the stack they skip (exit 0), so `pnpm test` stays
green in CI; without the web server only `http.test.ts` skips. Override the
web origin with `CUE_BASE_URL`.

## Demo notes

- A match belongs to the pair, not the session: use `POST /api/demo/reset`
  (not a new session) to let the same two people match again.
- Signals expire lazily; a pending row may still say `pending` in the table
  after `expires_at`. The API and `submit_interest` both ignore it.
