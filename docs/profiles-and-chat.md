# Profiles, character and chat

Added on 2026-11-15, on the owner's instruction. This is the reference for what
a profile contains, who sees which field, how the character is chosen, how chat
works, and what Claude does and does not receive. Source of truth: the schemas in
`packages/contracts/src` (`profile.ts`, `archetype.ts`, `chat.ts`, `wingman.ts`,
`match.ts`, `routes.ts`), the migration
`supabase/migrations/20261115010000_rich_profiles_and_chat.sql`, and
`apps/web/src/server/{profiles,chat,matches}.ts` and `server/ai/*`.

Two departures from `docs/spec.md`, which stays as written: the spec deferred
chat, and it listed shared social links as a way to reconnect. Cue now has
in-app chat and no external links. See "Departures from the spec" in
`docs/architecture.md`.

## What a profile contains

Only the display name is required. Everything else is optional.

- Display name, photo, bio (up to 280 characters), up to 12 interests.
- Age: whole number, 18 to 99. Self-declared. Under 18 is rejected.
- Gender: woman, man, non-binary or other, plus optional own words (up to 40
  characters).
- Location: a city or area the person types in (up to 60 characters). Never GPS.
- What they are looking for: one of six options (long-term, short-term, casual,
  friendship first, open to exploring, not sure yet).
- Work or school: free text, up to 80 characters.
- Education: one of seven levels.
- MBTI: one of the 16 types.
- Ethnicity: free text, up to 60 characters.
- Drinking, smoking, drugs: never, sometimes, often, or prefer not to say.
- Personality cards: up to 3 from each of four fixed decks (what you listen to,
  your kind of weekend, your energy, things you love). At most 12 cards.
- Character: derived by the server, not editable. See below.

Fixed option lists live in `packages/contracts/src/profile.ts` and the same
values are enforced by CHECK constraints in the database.

## Who sees what

One share toggle per field. Display name is always shared with a match. Cards and
the character share together under one toggle; gender and the own-words text
share under the gender toggle.

| Field | Shared by default | Can reach Claude |
|---|---|---|
| Photo | Yes | No |
| Bio | Yes | Yes, if shared and AI assist is on |
| Interests | Yes | Yes, if shared and AI assist is on |
| Age | Yes | **Never** |
| Gender (and own words) | Yes | **Never** |
| Location | Yes | Yes, if shared and AI assist is on |
| Looking for | Yes | Yes, if shared and AI assist is on (as its label) |
| MBTI | Yes | Yes, if shared and AI assist is on |
| Personality cards | Yes | Yes, if shared and AI assist is on (as card labels) |
| Character | Yes (with cards) | Yes, if shared and AI assist is on (as its name) |
| Work or school | **No** | Yes, if shared and AI assist is on |
| Education | **No** | Yes, if shared and AI assist is on (as its label) |
| Ethnicity | **No** | **Never** |
| Drinking | **No** | **Never** |
| Smoking | **No** | **Never** |
| Drugs | **No** | **Never** |
| Social links | Not collected | Not applicable |

"AI assist" is a separate switch in the same settings. It is on by default. With
it off, nothing about that person is sent to Claude.

### How sharing is enforced

- The browser never builds the shared view. `toSharedProfile` in
  `apps/web/src/server/profiles.ts` does, from the owner's saved sharing
  settings. A field the owner did not share is returned as `null` or an empty
  list, so it is not in the response at all.
- Profiles are visible only to the other person of an active match.
- If stored sharing settings cannot be read, the server shares nothing
  optional rather than everything.
- The settings are part of the profile `version`. Changing a toggle bumps the
  version, so a cached Claude card is not reused after a field is hidden.
- External social links are no longer collected, saved, or returned. The
  `social_links` column still exists and the migration emptied it. No code path
  reads it.

## The character

A character is a short name and a line of description, for example "The Night
Owl". There are twelve: Night Owl, Guardian, Wanderer, Spark, Dreamer, Anchor,
Storyteller, Explorer, Homebody, Maverick, Muse, Sage.

- Fixed rules, no model call. Each card, and lightly each MBTI letter, carries
  weights toward characters. The highest total wins. A tie goes to the earlier
  entry in a fixed list, so the same picks always give the same character.
- With no cards and no MBTI there is no character.
- `computeArchetype` runs on the server when the profile is saved, and the result
  is stored. The client cannot supply it.
- A match sees the character only when the person shares their cards.

## Chat

Text messages between the two people of an active match, inside Cue.

| Property | Behavior |
|---|---|
| Who | Only the two participants of an **active** match. Anyone else, an ended match, or a malformed id gets `404 not_found`. |
| Routes | `GET /api/matches/[id]/messages` (newest page of 50, oldest first, `before` cursor for older) and `POST /api/matches/[id]/messages`. |
| Credential | Web session only. A glasses device token cannot read or send. |
| Message | 1 to 1000 characters, plain text. |
| Retries | The client sends a `clientId`. A repeat returns the stored message: `201` for a new message, `200` for a repeat. |
| Read state | Loading the newest page marks the conversation read for that person. `GET /api/matches` returns `unreadCount` and `lastMessageAt` on each match. |
| Rate limit | 20 sends per 10 seconds per sender, across conversations. In memory, per server instance. Over the limit: `429 rate_limited`. |
| Realtime | `chat_messages` is in the realtime publication. A participant's browser may only `SELECT` rows of its own active match. Realtime only means "something changed": the client refetches through the API and never renders realtime row contents. |
| Writes | Only through the API, with the service-role client. A database trigger also rejects an insert unless the sender is in an active match (`match_not_active`). |
| Sender id | Reduced to `mine: true/false` in the response. |
| Rendering | Clients show the body as plain text. No links, previews or markup. |
| Deletion | Messages and read markers are deleted when the match ends: unmatch, block, or demo reset. Neither person can read them afterwards. |
| Logging | Message bodies are not logged. |

There is no way to report a message. Unmatch and Block are the only controls.

## What Claude sees

The "Find common ground" card is optional and shown only to the person who asks.

Sent, per person, only if that person shared the field and has AI assist on:
interests, bio, personality card labels, character name, MBTI, the looking-for
label, location, work or school, and the education label. The venue's name is
also sent when the match was made at a venue check-in. A match made by phone
location is labelled "Nearby", which is not a venue, so no venue is sent (and
never a position).

**Never sent:** age, gender (and own words), ethnicity, drinking, smoking, drugs,
display name, photo, ids, and chat messages. This is structural: the code that
builds the model input reads a fixed list of properties by name and never
touches those. A test checks that these values do not appear in the request.
`NEVER_SENT_TO_AI` in `packages/contracts/src/profile.ts` lists them.

What Claude returns, and what the server does with it:

- Up to five "you both..." lines, each with a quote from your profile and a quote
  from theirs. Each quote must appear verbatim in the text supplied for that
  person, or the line is dropped. The sentence you read is written by code from
  the quotes, not by the model.
- One suggested opening question, or none.
- If either person gives too little (no interests, bio, cards or work or school),
  the model is not called and a fixed opener is shown (based on the venue's name, or generic for a "Nearby" match).
- Claude never receives chat messages and never sends anything. "Use this opener"
  copies the question into the message box. The person edits it and sends it, or
  does not.
- Profile text is treated as data, not instructions.

## Limits

- **Chat cannot stop someone typing their own contact details.** Removing social
  links and not making links clickable lowers exposure. It does not enforce it.
- **Ethnicity and substance use are sensitive.** They are optional, off by
  default and never sent to Claude. Once someone fills them in they are stored in
  the hosted database. This is a demo project with no privacy policy. Use
  synthetic data for demos.
- **Age is self-declared and not verified.** Nothing about a person is verified.
- **The rate limit is in memory** and works per server instance only.
- **No message reporting or moderation** beyond Unmatch and Block.
- **The live Claude call with the fuller input has not been run with a real
  key.** Automated tests use a fake model.
- **The new profile, character and chat screens have not been tried on the real
  phones.** They are covered by automated browser tests only.

## Demo accounts

All synthetic, from `supabase/seed.sql`.

| Account | Profile |
|---|---|
| Alex | 29, San Francisco, looking for something long-term, INFP, character The Explorer. Shares work and education. Fills ethnicity, drinking, smoking and drugs and shares none of them. |
| Sam | 27, San Francisco, open to exploring, ENFJ, character The Spark. Shares work, not education. |
| Riley | 34, Oakland, friendship first, ISTJ, character The Homebody. Bio hidden, AI assist off. Little overlap with Alex or Sam. |

Alex and Sam share a city and several cards (indie, trails, cafes, the outdoors).

## Manual test list

Use two browsers signed in as two demo accounts, in the same place (host a place
on one and check the other in by QR code or code, or turn on Encounter mode on
both with location). Run these against the local stack with `pnpm dev`.

1. Sign in as Alex. Open the profile, change a few fields and a few cards, and
   save. The character appears and updates when the cards change. With no cards
   and no MBTI it is absent.
2. Under sharing, turn off one field that is on (for example location) and note
   what the preview says a match will see.
3. Match with Sam (see `docs/demo.md`). On Sam's screen open Alex's card. The
   hidden field is not shown. Turn on one off-by-default field (work or school)
   and confirm Sam sees it after a refresh.
4. Confirm the sensitive fields Alex filled are not on Sam's screen. In the
   browser network tab the match response should not contain them either.
5. Open the chat on both sides. Send a message each way. It appears live on the
   other side without a refresh. Reload: it is still there. Unread count clears
   when the conversation is opened.
6. Paste a link into a message. It is shown as plain text, not a link.
7. As Sam, tap "Find common ground", then "Use this opener". The question is in
   the message box, and nothing is sent until Sam sends it.
8. Unmatch as either person. The conversation is gone for both. Matching again
   starts an empty conversation.
9. Check a non-match: sign in as Riley and do not signal, or signal on her own
   with nobody else in the window. There is no match, so there is no chat.
