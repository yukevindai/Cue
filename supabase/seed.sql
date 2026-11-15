-- Demo accounts for local development. Synthetic data only.
-- Password for every account: cue-demo-123
--
-- Idempotent: running this file again removes the demo accounts first
-- (ON DELETE CASCADE clears profiles, identities and anything else keyed to them)
-- and then recreates them with the same ids.
--
-- Run with: docker exec -i supabase_db_Cue psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/seed.sql

begin;

-- 1. Clean up previous demo accounts (by email or fixed id).
delete from auth.users
where email in ('alex@cue.demo', 'sam@cue.demo', 'riley@cue.demo')
   or id in (
     '00000000-0000-4000-8000-00000000a1e0',
     '00000000-0000-4000-8000-0000000005a0',
     '00000000-0000-4000-8000-000000000b1e'
   );

-- 2. Auth users. GoTrue scans these token columns as strings, so they must be
--    '' rather than NULL or password login fails with a scan error.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-00000000a1e0',
    'authenticated', 'authenticated', 'alex@cue.demo',
    extensions.crypt('cue-demo-123', extensions.gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-0000000005a0',
    'authenticated', 'authenticated', 'sam@cue.demo',
    extensions.crypt('cue-demo-123', extensions.gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000b1e',
    'authenticated', 'authenticated', 'riley@cue.demo',
    extensions.crypt('cue-demo-123', extensions.gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

-- 3. Identities, one per user (email provider).
insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  u.id::text,
  'email',
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  now(), now(), now()
from auth.users u
where u.email in ('alex@cue.demo', 'sam@cue.demo', 'riley@cue.demo');

-- 4. Profiles. Every value is synthetic. Alex and Sam overlap for real (both
--    in San Francisco, both on trails and in cafés, both into indie, both open
--    to something lasting) and differ elsewhere; Riley overlaps little with
--    either. Alex alone fills the sensitive fields (ethnicity, drinking,
--    smoking, drugs) and shares none of them, to show that hidden means hidden.
--    `archetype` equals computeArchetype(cards, mbti) from
--    packages/contracts/src/archetype.ts (asserted by a stack test).
--    `sharing` lists every key explicitly. `social_links` stays empty: external
--    links are no longer collected or shown.
insert into public.profiles (
  user_id, display_name, photo_url, bio, interests, social_links,
  age, gender, gender_self_described, location, looking_for, work_or_school,
  education, mbti, ethnicity, drinking, smoking, drugs, cards, archetype, sharing
)
values
  (
    '00000000-0000-4000-8000-00000000a1e0',
    'Alex',
    null,
    'Weekend trail hikes and a long-running hunt for the best pour-over coffee in town. Always up for a roll of film.',
    array['hiking', 'coffee', 'film photography', 'board games'],
    '[]'::jsonb,
    29, 'man', null, 'San Francisco', 'long_term', 'Designer at Example Studio (demo)',
    'bachelors', 'INFP', 'Synthetic demo value', 'sometimes', 'never', 'never',
    array['music.indie', 'music.jazz', 'weekend.trails', 'weekend.cafes',
          'energy.early-bird', 'energy.deep-talks', 'loves.outdoors', 'loves.film'],
    'explorer',
    '{"photo": true, "bio": true, "interests": true, "age": true, "gender": true,
      "location": true, "lookingFor": true, "mbti": true, "cards": true,
      "workOrSchool": true, "education": true, "ethnicity": false,
      "drinking": false, "smoking": false, "drugs": false, "aiAssist": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-0000000005a0',
    'Sam',
    null,
    'Exploring cafés one latte at a time, practicing latte art with mixed results. Day hikes on the weekend and live music when possible.',
    array['day hikes', 'latte art', 'live music', 'climbing'],
    '[]'::jsonb,
    27, 'woman', null, 'San Francisco', 'open', 'Barista trainer at Example Coffee Co. (demo)',
    'some_college', 'ENFJ', null, null, null, null,
    array['music.indie', 'music.rnb', 'weekend.trails', 'weekend.cafes', 'weekend.live-shows',
          'energy.big-groups', 'energy.talker', 'loves.food', 'loves.outdoors'],
    'spark',
    '{"photo": true, "bio": true, "interests": true, "age": true, "gender": true,
      "location": true, "lookingFor": true, "mbti": true, "cards": true,
      "workOrSchool": true, "education": false, "ethnicity": false,
      "drinking": false, "smoking": false, "drugs": false, "aiAssist": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000b1e',
    'Riley',
    null,
    'Throwing pots on weeknights and riding bikes on weekends. Currently working through a backlog of sci-fi novels.',
    array['pottery', 'cycling', 'sci-fi novels'],
    '[]'::jsonb,
    34, 'non_binary', null, 'Oakland', 'friendship', 'Ceramics teacher at Example Arts Center (demo)',
    'masters', 'ISTJ', null, null, null, null,
    array['music.lo-fi', 'music.classical', 'weekend.reading', 'weekend.staying-in',
          'energy.planner', 'energy.one-on-one', 'loves.cats', 'loves.books'],
    'homebody',
    '{"photo": true, "bio": false, "interests": true, "age": true, "gender": true,
      "location": true, "lookingFor": true, "mbti": true, "cards": true,
      "workOrSchool": false, "education": false, "ethnicity": false,
      "drinking": false, "smoking": false, "drugs": false, "aiAssist": false}'::jsonb
  );

commit;
