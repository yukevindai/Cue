-- Richer profiles, a derived character, and in-app chat.
--
-- Additive and backward compatible: every new profile column is nullable or
-- defaulted, and existing rows stay valid. Mirrors packages/contracts
-- (profile.ts, archetype.ts, chat.ts).

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column age             integer check (age between 18 and 99),
  add column gender          text check (gender in ('woman', 'man', 'non_binary', 'other')),
  add column gender_self_described text check (char_length(gender_self_described) <= 40),
  add column location        text check (char_length(location) <= 60),
  add column looking_for     text check (looking_for in
                               ('long_term', 'short_term', 'casual', 'friendship', 'open', 'unsure')),
  add column work_or_school  text check (char_length(work_or_school) <= 80),
  add column education       text check (education in
                               ('high_school', 'some_college', 'bachelors', 'masters',
                                'doctorate', 'trade_school', 'other')),
  add column mbti            text check (mbti ~ '^[EI][NS][TF][JP]$'),
  add column ethnicity       text check (char_length(ethnicity) <= 60),
  add column drinking        text check (drinking in ('never', 'sometimes', 'often', 'prefer_not_to_say')),
  add column smoking         text check (smoking in ('never', 'sometimes', 'often', 'prefer_not_to_say')),
  add column drugs           text check (drugs in ('never', 'sometimes', 'often', 'prefer_not_to_say')),
  -- Personality card ids; validated against the fixed decks by the API.
  add column cards           text[] not null default '{}',
  -- Derived by the server from cards + mbti; null until cards are picked.
  add column archetype       text;

-- New profiles: sensitive fields are not shared unless the person turns them on.
alter table public.profiles alter column sharing set default
  '{"photo": true, "bio": true, "interests": true, "age": true, "gender": true,
    "location": true, "lookingFor": true, "mbti": true, "cards": true,
    "workOrSchool": false, "education": false, "ethnicity": false,
    "drinking": false, "smoking": false, "drugs": false, "aiAssist": true}'::jsonb;

-- External social links are no longer collected or shown. The column stays so
-- nothing is destroyed, but it is emptied and no code path returns it.
update public.profiles set social_links = '[]'::jsonb where social_links <> '[]'::jsonb;

-- Bump profiles.version on any content or sharing change (now covering the new columns).
create or replace function public.profiles_bump_version() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.display_name, new.photo_url, new.bio, new.interests, new.sharing,
      new.age, new.gender, new.gender_self_described, new.location, new.looking_for,
      new.work_or_school, new.education, new.mbti, new.ethnicity,
      new.drinking, new.smoking, new.drugs, new.cards, new.archetype)
     is distinct from
     (old.display_name, old.photo_url, old.bio, old.interests, old.sharing,
      old.age, old.gender, old.gender_self_described, old.location, old.looking_for,
      old.work_or_school, old.education, old.mbti, old.ethnicity,
      old.drinking, old.smoking, old.drugs, old.cards, old.archetype)
  then
    new.version := old.version + 1;
    new.updated_at := now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

create table public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  match_id   uuid not null references public.matches (id) on delete cascade,
  sender_id  uuid not null references auth.users (id) on delete cascade,
  -- Client idempotency key: a retried send returns the stored row.
  client_id  uuid not null,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique (sender_id, client_id)
);
create index chat_messages_match_created on public.chat_messages (match_id, created_at desc, id desc);

-- When each participant last opened the conversation (for unread counts).
create table public.chat_reads (
  match_id     uuid not null references public.matches (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default clock_timestamp(),
  primary key (match_id, user_id)
);

-- Messages and read markers exist only for a participant of an ACTIVE match.
create function public.chat_require_active_match() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
begin
  if tg_table_name = 'chat_messages' then
    v_user := new.sender_id;
  else
    v_user := new.user_id;
  end if;
  perform 1 from public.matches m
    where m.id = new.match_id and m.status = 'active'
      and v_user in (m.user_a, m.user_b)
    for share;
  if not found then
    raise exception 'match_not_active' using errcode = 'CUE03';
  end if;
  return new;
end $$;

create trigger chat_messages_require_active_match
  before insert on public.chat_messages
  for each row execute function public.chat_require_active_match();

create trigger chat_reads_require_active_match
  before insert or update on public.chat_reads
  for each row execute function public.chat_require_active_match();

-- Ending a match (unmatch, block, demo reset) removes its conversation too.
create or replace function public.matches_cleanup_on_end() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'ended' and old.status <> 'ended' then
    delete from public.wingman_suggestions where match_id = new.id;
    delete from public.chat_messages where match_id = new.id;
    delete from public.chat_reads where match_id = new.id;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------

alter table public.chat_messages enable row level security;
alter table public.chat_reads    enable row level security;

revoke all on table public.chat_messages, public.chat_reads from anon, authenticated;
grant all on table public.chat_messages, public.chat_reads to service_role;

-- Browsers may only SELECT, and only what Realtime needs: messages of an
-- active match they are part of. All writes go through the API.
grant select on table public.chat_messages to authenticated;

create policy chat_messages_select_participant on public.chat_messages
  for select to authenticated
  using (exists (
    select 1 from public.matches m
     where m.id = chat_messages.match_id
       and m.status = 'active'
       and (select auth.uid()) in (m.user_a, m.user_b)));

alter publication supabase_realtime add table public.chat_messages;

revoke execute on function public.chat_require_active_match() from public, anon, authenticated;
grant execute on function public.chat_require_active_match() to service_role;
