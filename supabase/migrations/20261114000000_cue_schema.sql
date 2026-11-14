-- Cue schema. See docs/architecture.md (table names are a contract) and
-- docs/spec.md section 3 (matching rules).
--
-- Trust model: browsers reach these tables only through Realtime, with RLS
-- select policies on three tables. Everything else goes through apps/web API
-- routes using the service role, which calls the functions at the bottom.
-- Invariants live here, not in the application:
--   * at most 2 active members per session   (trigger + session row lock)
--   * one active session per user            (partial unique index)
--   * one pending signal per user + session  (partial unique index)
--   * unique (user_id, event_id)             (unique constraint)
--   * one active match per pair, a < b       (partial unique index + check)
--
-- Rows in realtime-published tables are never deleted by the application:
-- Realtime cannot apply RLS to DELETE events, so state changes are updates.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  photo_url    text,
  bio          text not null default '',
  interests    text[] not null default '{}',
  social_links jsonb not null default '[]'::jsonb,
  sharing      jsonb not null default
    '{"photo": true, "bio": true, "interests": true, "socialLinks": false, "aiAssist": true}'::jsonb,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.device_associations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  device_label       text,
  mentra_user_id     text,
  -- SHA-256 hex of the bearer token / pairing code. Plaintext is never stored.
  token_hash         text,
  pairing_code_hash  text,
  pairing_expires_at timestamptz,
  linked_at          timestamptz,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  check (linked_at is null or token_hash is not null)
);
-- One active (linked, not revoked) device per user.
create unique index device_associations_one_active_per_user
  on public.device_associations (user_id)
  where linked_at is not null and revoked_at is null;
-- One open pairing per user; an open code is unique so a claim is unambiguous.
create unique index device_associations_one_open_pairing_per_user
  on public.device_associations (user_id)
  where linked_at is null and revoked_at is null;
create unique index device_associations_open_code
  on public.device_associations (pairing_code_hash)
  where linked_at is null and revoked_at is null;
create unique index device_associations_token_hash
  on public.device_associations (token_hash)
  where token_hash is not null;

create table public.demo_sessions (
  id                 uuid primary key default gen_random_uuid(),
  join_code          text not null unique,
  venue_label        text not null check (char_length(venue_label) between 1 and 80),
  venue_label_source text not null default 'manual' check (venue_label_source in ('manual')),
  status             text not null default 'active' check (status in ('active', 'ended')),
  created_by         uuid not null references auth.users (id) on delete cascade,
  created_at         timestamptz not null default now(),
  ended_at           timestamptz
);

create table public.demo_session_members (
  session_id     uuid not null references public.demo_sessions (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  encounter_mode boolean not null default false,
  joined_at      timestamptz not null default now(),
  -- Set when the member leaves or the session ends. Active member = left_at is null.
  left_at        timestamptz,
  primary key (session_id, user_id)
);
-- One active session per user.
create unique index demo_session_members_one_active_session_per_user
  on public.demo_session_members (user_id)
  where left_at is null;

create table public.interest_events (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null references public.demo_sessions (id) on delete cascade,
  source      text not null check (source in ('mentra_touch', 'web_demo')),
  gesture     text not null check (gesture in ('backward_swipe', 'web_confirm')),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  expires_at  timestamptz not null,
  status      text not null check (status in ('pending', 'consumed', 'expired', 'cancelled')),
  resolved_at timestamptz,
  match_id    uuid,
  unique (user_id, event_id),
  check (
    (source = 'mentra_touch' and gesture = 'backward_swipe')
    or (source = 'web_demo' and gesture = 'web_confirm')
  )
);
-- One pending signal per user and session.
create unique index interest_events_one_pending_per_user_session
  on public.interest_events (user_id, session_id)
  where status = 'pending';
create index interest_events_session_pending
  on public.interest_events (session_id)
  where status = 'pending';

create table public.matches (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.demo_sessions (id) on delete cascade,
  user_a             uuid not null references auth.users (id) on delete cascade,
  user_b             uuid not null references auth.users (id) on delete cascade,
  first_signal_at    timestamptz not null,
  venue_label        text not null,
  venue_label_source text not null default 'manual' check (venue_label_source in ('manual')),
  status             text not null default 'active' check (status in ('active', 'ended')),
  ended_by           uuid references auth.users (id) on delete set null,
  ended_reason       text check (ended_reason in ('unmatch', 'block', 'reset')),
  ended_at           timestamptz,
  created_at         timestamptz not null default now(),
  check (user_a < user_b)
);
-- One active match per pair.
create unique index matches_one_active_per_pair
  on public.matches (user_a, user_b)
  where status = 'active';
create index matches_user_b on public.matches (user_b);
create index matches_session on public.matches (session_id);

alter table public.interest_events
  add constraint interest_events_match_id_fkey
  foreign key (match_id) references public.matches (id) on delete set null;

create table public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked on public.blocks (blocked_id);

-- Wingman cache. One row per (match, requester); `cache_key` records which
-- profile versions + sharing produced the payload. Written by server/ai.
create table public.wingman_suggestions (
  match_id     uuid not null references public.matches (id) on delete cascade,
  requester_id uuid not null references auth.users (id) on delete cascade,
  cache_key    text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (match_id, requester_id)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Bump profiles.version on any content or sharing change.
create function public.profiles_bump_version() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.display_name, new.photo_url, new.bio, new.interests, new.social_links, new.sharing)
     is distinct from
     (old.display_name, old.photo_url, old.bio, old.interests, old.social_links, old.sharing)
  then
    new.version := old.version + 1;
    new.updated_at := now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

create trigger profiles_bump_version
  before update on public.profiles
  for each row execute function public.profiles_bump_version();

-- At most 2 active members per session, safe under concurrent joins: the
-- session row lock serializes everyone trying to become an active member.
create function public.demo_session_members_enforce_capacity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_count  integer;
begin
  if new.left_at is not null then
    return new;                       -- not (or no longer) an active member
  end if;
  if tg_op = 'UPDATE' and old.left_at is null and old.session_id = new.session_id then
    return new;                       -- already active, e.g. encounter_mode toggle
  end if;

  select status into v_status from public.demo_sessions
   where id = new.session_id for update;
  if v_status is distinct from 'active' then
    raise exception 'session_inactive' using errcode = 'CUE02';
  end if;

  select count(*) into v_count from public.demo_session_members
   where session_id = new.session_id and left_at is null and user_id <> new.user_id;
  if v_count >= 2 then
    raise exception 'session_full' using errcode = 'CUE01';
  end if;
  return new;
end $$;

create trigger demo_session_members_enforce_capacity
  before insert or update on public.demo_session_members
  for each row execute function public.demo_session_members_enforce_capacity();

-- A match that ends (unmatch, block, reset) loses its cached suggestions.
create function public.matches_cleanup_on_end() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'ended' and old.status <> 'ended' then
    delete from public.wingman_suggestions where match_id = new.id;
  end if;
  return new;
end $$;

create trigger matches_cleanup_on_end
  after update on public.matches
  for each row execute function public.matches_cleanup_on_end();

-- Suggestions can only be cached for an active match.
create function public.wingman_suggestions_require_active_match() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.matches m
    where m.id = new.match_id and m.status = 'active'
      and new.requester_id in (m.user_a, m.user_b)
    for share;
  if not found then
    raise exception 'match_not_active' using errcode = 'CUE03';
  end if;
  return new;
end $$;

create trigger wingman_suggestions_require_active_match
  before insert or update on public.wingman_suggestions
  for each row execute function public.wingman_suggestions_require_active_match();

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.device_associations  enable row level security;
alter table public.demo_sessions        enable row level security;
alter table public.demo_session_members enable row level security;
alter table public.interest_events      enable row level security;
alter table public.matches              enable row level security;
alter table public.blocks               enable row level security;
alter table public.wingman_suggestions  enable row level security;

-- Supabase grants table privileges to anon/authenticated by default. Remove
-- them; browsers get only the SELECTs Realtime needs.
revoke all on table
  public.profiles, public.device_associations, public.demo_sessions,
  public.demo_session_members, public.interest_events, public.matches,
  public.blocks, public.wingman_suggestions
  from anon, authenticated;

grant select on table public.matches, public.interest_events, public.demo_session_members
  to authenticated;

grant all on table
  public.profiles, public.device_associations, public.demo_sessions,
  public.demo_session_members, public.interest_events, public.matches,
  public.blocks, public.wingman_suggestions
  to service_role;

create policy matches_select_participant on public.matches
  for select to authenticated
  using ((select auth.uid()) in (user_a, user_b));

-- Own signals only: the other person's pending signal is never readable.
create policy interest_events_select_own on public.interest_events
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy demo_session_members_select_own on public.demo_session_members
  for select to authenticated
  using (user_id = (select auth.uid()));

alter publication supabase_realtime
  add table public.matches, public.interest_events, public.demo_session_members;

-- ---------------------------------------------------------------------------
-- Storage: public `avatars` bucket; a signed-in user writes only under a
-- folder named with their own user id (avatars/<uid>/...).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Matching (spec section 3). The whole decision is one transaction.
-- ---------------------------------------------------------------------------

create function public._interest_result(
  p_status text, p_received_at timestamptz, p_expires_at timestamptz,
  p_matched boolean, p_match_id uuid, p_reason text
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'status', p_status,
    'received_at', p_received_at,
    'expires_at', p_expires_at,
    'matched', p_matched,
    'match_id', p_match_id,
    'reason', p_reason);
$$;

-- Returns { status, received_at, expires_at, matched, match_id, reason }.
--
-- Concurrency: every submission for a session takes that session's row lock
-- first, so two signals arriving at the same instant are processed one after
-- the other. The second one sees the first one's committed pending row and
-- completes the match: exactly one match, never two, never zero.
--
-- Privacy: nothing here reads or changes the OTHER member's signal unless a
-- match is being created. In particular their stale signal is not expired as a
-- side effect of the caller's submission (that update would reach them over
-- realtime and reveal that the caller signalled).
create function public.submit_interest(
  p_user_id uuid, p_session_id uuid, p_event_id uuid,
  p_source text, p_gesture text, p_occurred_at timestamptz
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_window   constant interval := interval '15 seconds';  -- MATCH_WINDOW_SECONDS
  v_now      timestamptz;
  v_session  public.demo_sessions%rowtype;
  v_me       public.demo_session_members%rowtype;
  v_mine     public.interest_events%rowtype;
  v_theirs   public.interest_events%rowtype;
  v_other_id uuid;
  v_match_id uuid;
begin
  if p_user_id is null or p_session_id is null or p_event_id is null or p_occurred_at is null
     or not ((p_source = 'mentra_touch' and p_gesture = 'backward_swipe')
          or (p_source = 'web_demo' and p_gesture = 'web_confirm')) then
    return public._interest_result('rejected', clock_timestamp(), null, false, null, 'invalid_event');
  end if;

  -- Unlocked pre-check so a non-member can never queue on the session lock.
  -- A session that does not exist looks exactly like one the caller is not in.
  if not exists (select 1 from public.demo_session_members
                  where session_id = p_session_id and user_id = p_user_id and left_at is null) then
    return public._interest_result('rejected', clock_timestamp(), null, false, null, 'not_in_session');
  end if;

  select * into v_session from public.demo_sessions where id = p_session_id for update;
  if not found then
    return public._interest_result('rejected', clock_timestamp(), null, false, null, 'not_in_session');
  end if;

  -- Server receipt time: the database clock, read after the lock is held, so
  -- receipt order is the order in which signals are actually processed.
  v_now := clock_timestamp();

  -- Idempotency: a repeated event id never creates anything.
  select * into v_mine from public.interest_events
   where user_id = p_user_id and event_id = p_event_id;
  if found then
    return public._interest_result(
      'duplicate', v_mine.received_at,
      case when v_mine.status = 'pending' and v_mine.expires_at > v_now then v_mine.expires_at end,
      v_mine.status = 'consumed', v_mine.match_id, null);
  end if;

  if v_session.status <> 'active' then
    return public._interest_result('rejected', v_now, null, false, null, 'session_inactive');
  end if;

  select * into v_me from public.demo_session_members
   where session_id = p_session_id and user_id = p_user_id and left_at is null;
  if not found then
    return public._interest_result('rejected', v_now, null, false, null, 'not_in_session');
  end if;
  if not v_me.encounter_mode then
    return public._interest_result('rejected', v_now, null, false, null, 'encounter_mode_off');
  end if;

  -- Expire the caller's OWN stale signals. Expired signals are never replayed.
  update public.interest_events
     set status = 'expired', resolved_at = v_now
   where user_id = p_user_id and status = 'pending' and expires_at <= v_now;

  -- One gesture: a second signal while one is pending creates nothing.
  select * into v_mine from public.interest_events
   where user_id = p_user_id and session_id = p_session_id and status = 'pending';
  if found then
    return public._interest_result('duplicate', v_mine.received_at, v_mine.expires_at, false, null, null);
  end if;

  -- The sole other participant. Never a random or nearest account.
  select user_id into v_other_id from public.demo_session_members
   where session_id = p_session_id and left_at is null and user_id <> p_user_id
   limit 1;

  if v_other_id is not null then
    -- The caller blocked the other member: they know, so say so.
    if exists (select 1 from public.blocks
                where blocker_id = p_user_id and blocked_id = v_other_id) then
      return public._interest_result('rejected', v_now, null, false, null, 'blocked');
    end if;
    if exists (select 1 from public.matches
                where user_a = least(p_user_id, v_other_id)
                  and user_b = greatest(p_user_id, v_other_id)
                  and status = 'active') then
      return public._interest_result('rejected', v_now, null, false, null, 'already_matched');
    end if;

    -- The other member blocked the caller: the signal is accepted and simply
    -- never matches, so the block is not disclosed to the blocked person.
    if not exists (select 1 from public.blocks
                    where blocker_id = v_other_id and blocked_id = p_user_id) then
      select * into v_theirs from public.interest_events
       where user_id = v_other_id and session_id = p_session_id
         and status = 'pending' and expires_at > v_now
       for update;

      if found then
        insert into public.matches
          (session_id, user_a, user_b, first_signal_at, venue_label, venue_label_source)
        values
          (p_session_id, least(p_user_id, v_other_id), greatest(p_user_id, v_other_id),
           v_theirs.received_at, v_session.venue_label, v_session.venue_label_source)
        returning id into v_match_id;

        update public.interest_events
           set status = 'consumed', resolved_at = v_now, match_id = v_match_id
         where id = v_theirs.id;

        insert into public.interest_events
          (event_id, user_id, session_id, source, gesture, occurred_at,
           received_at, expires_at, status, resolved_at, match_id)
        values
          (p_event_id, p_user_id, p_session_id, p_source, p_gesture, p_occurred_at,
           v_now, v_now + v_window, 'consumed', v_now, v_match_id);

        return public._interest_result('accepted', v_now, null, true, v_match_id, null);
      end if;
    end if;
  end if;

  insert into public.interest_events
    (event_id, user_id, session_id, source, gesture, occurred_at, received_at, expires_at, status)
  values
    (p_event_id, p_user_id, p_session_id, p_source, p_gesture, p_occurred_at,
     v_now, v_now + v_window, 'pending');

  return public._interest_result('accepted', v_now, v_now + v_window, false, null, null);
end $$;

-- Marks the caller's own elapsed pending signals as expired (lazy expiry; the
-- API also treats expires_at <= now as not pending). Own rows only.
create function public.expire_own_signals(p_user_id uuid) returns void
language sql set search_path = public, pg_temp as $$
  update public.interest_events
     set status = 'expired', resolved_at = clock_timestamp()
   where user_id = p_user_id and status = 'pending' and expires_at <= clock_timestamp();
$$;

-- ---------------------------------------------------------------------------
-- Sessions and encounter mode
-- ---------------------------------------------------------------------------

-- Leave the caller's active session: cancels their pending signal and ends the
-- session when nobody is left.
create function public.leave_demo_session(p_user_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
begin
  select session_id into v_session_id from public.demo_session_members
   where user_id = p_user_id and left_at is null;
  if v_session_id is null then
    return;
  end if;

  perform 1 from public.demo_sessions where id = v_session_id for update;

  update public.demo_session_members
     set left_at = clock_timestamp(), encounter_mode = false
   where session_id = v_session_id and user_id = p_user_id and left_at is null;

  update public.interest_events
     set status = 'cancelled', resolved_at = clock_timestamp()
   where user_id = p_user_id and session_id = v_session_id and status = 'pending';

  if not exists (select 1 from public.demo_session_members
                  where session_id = v_session_id and left_at is null) then
    update public.demo_sessions set status = 'ended', ended_at = clock_timestamp()
     where id = v_session_id and status = 'active';
  end if;
end $$;

-- Create a session and join it (leaving any current one). A join_code
-- collision raises unique_violation (23505); the caller retries with a new code.
create function public.create_demo_session(p_user_id uuid, p_venue_label text, p_join_code text)
returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
begin
  perform public.leave_demo_session(p_user_id);

  insert into public.demo_sessions (join_code, venue_label, created_by)
  values (upper(btrim(p_join_code)), btrim(p_venue_label), p_user_id)
  returning id into v_session_id;

  insert into public.demo_session_members (session_id, user_id) values (v_session_id, p_user_id);
  return v_session_id;
end $$;

-- Returns { status: 'joined' | 'not_found' | 'session_full', session_id }.
-- A full session rejects the third account even under a race (session row lock
-- here, plus the capacity trigger as the invariant of last resort).
create function public.join_demo_session(p_user_id uuid, p_join_code text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_target_id  uuid;
  v_current_id uuid;
  v_status     text;
  v_count      integer;
begin
  select id into v_target_id from public.demo_sessions
   where join_code = upper(btrim(p_join_code)) and status = 'active';
  if v_target_id is null then
    return jsonb_build_object('status', 'not_found', 'session_id', null);
  end if;

  select session_id into v_current_id from public.demo_session_members
   where user_id = p_user_id and left_at is null;
  if v_current_id = v_target_id then
    return jsonb_build_object('status', 'joined', 'session_id', v_target_id);
  end if;

  -- Lock both sessions in a stable order so two users swapping sessions cannot deadlock.
  perform 1 from public.demo_sessions
   where id in (v_target_id, v_current_id) order by id for update;

  select status into v_status from public.demo_sessions where id = v_target_id;
  if v_status is distinct from 'active' then
    return jsonb_build_object('status', 'not_found', 'session_id', null);
  end if;

  select count(*) into v_count from public.demo_session_members
   where session_id = v_target_id and left_at is null;
  if v_count >= 2 then
    return jsonb_build_object('status', 'session_full', 'session_id', null);
  end if;

  perform public.leave_demo_session(p_user_id);

  insert into public.demo_session_members (session_id, user_id)
  values (v_target_id, p_user_id)
  on conflict (session_id, user_id) do update
    set left_at = null, joined_at = clock_timestamp(), encounter_mode = false;

  return jsonb_build_object('status', 'joined', 'session_id', v_target_id);
end $$;

-- Returns false when the caller is not in an active session. Turning encounter
-- mode off cancels the caller's pending signal in the same transaction, under
-- the session lock, so it cannot race a match.
create function public.set_encounter_mode(p_user_id uuid, p_enabled boolean) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
begin
  select session_id into v_session_id from public.demo_session_members
   where user_id = p_user_id and left_at is null;
  if v_session_id is null then
    return false;
  end if;

  perform 1 from public.demo_sessions where id = v_session_id for update;

  update public.demo_session_members set encounter_mode = p_enabled
   where session_id = v_session_id and user_id = p_user_id and left_at is null;
  if not found then
    return false;
  end if;

  if not p_enabled then
    update public.interest_events
       set status = 'cancelled', resolved_at = clock_timestamp()
     where user_id = p_user_id and session_id = v_session_id and status = 'pending';
  end if;
  return true;
end $$;

-- Clean demo reset for the caller's current session: expires pending signals
-- and ends that session's matches (which deletes cached suggestions).
-- p_leave also ends the session for everyone. False when not in a session.
create function public.reset_demo_session(p_user_id uuid, p_leave boolean) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
begin
  select session_id into v_session_id from public.demo_session_members
   where user_id = p_user_id and left_at is null;
  if v_session_id is null then
    return false;
  end if;

  perform 1 from public.demo_sessions where id = v_session_id for update;
  v_now := clock_timestamp();

  update public.interest_events set status = 'expired', resolved_at = v_now
   where session_id = v_session_id and status = 'pending';

  update public.matches
     set status = 'ended', ended_by = p_user_id, ended_reason = 'reset', ended_at = v_now
   where session_id = v_session_id and status = 'active';

  if p_leave then
    update public.demo_session_members set left_at = v_now, encounter_mode = false
     where session_id = v_session_id and left_at is null;
    update public.demo_sessions set status = 'ended', ended_at = v_now
     where id = v_session_id and status = 'active';
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Unmatch and block
-- ---------------------------------------------------------------------------

-- Ends an active match the caller participates in. False otherwise (the caller
-- cannot tell "not yours" from "does not exist").
create function public.end_match(p_match_id uuid, p_user_id uuid, p_reason text) returns boolean
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.matches
     set status = 'ended', ended_by = p_user_id, ended_reason = p_reason, ended_at = clock_timestamp()
   where id = p_match_id and status = 'active' and p_user_id in (user_a, user_b);
  return found;
end $$;

-- Records the block and ends any active match between the two. Takes the
-- blocker's session lock first, so a concurrent submit_interest either
-- finished before (its match is ended here) or runs after (and sees the block).
create function public.block_user(p_blocker_id uuid, p_blocked_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
begin
  if p_blocker_id = p_blocked_id then
    return;
  end if;

  select session_id into v_session_id from public.demo_session_members
   where user_id = p_blocker_id and left_at is null;
  if v_session_id is not null then
    perform 1 from public.demo_sessions where id = v_session_id for update;
  end if;

  insert into public.blocks (blocker_id, blocked_id) values (p_blocker_id, p_blocked_id)
  on conflict do nothing;

  update public.matches
     set status = 'ended', ended_by = p_blocker_id, ended_reason = 'block', ended_at = clock_timestamp()
   where user_a = least(p_blocker_id, p_blocked_id)
     and user_b = greatest(p_blocker_id, p_blocked_id)
     and status = 'active';
end $$;

-- ---------------------------------------------------------------------------
-- Devices. Codes and tokens arrive already hashed (SHA-256 hex).
-- ---------------------------------------------------------------------------

-- Replaces the caller's open pairing. A code collision raises 23505; retry.
create function public.start_device_pairing(p_user_id uuid, p_code_hash text, p_ttl_seconds integer)
returns timestamptz
language plpgsql set search_path = public, pg_temp as $$
declare
  v_expires timestamptz := clock_timestamp() + make_interval(secs => p_ttl_seconds);
begin
  delete from public.device_associations
   where user_id = p_user_id and linked_at is null;

  insert into public.device_associations (user_id, pairing_code_hash, pairing_expires_at)
  values (p_user_id, p_code_hash, v_expires);
  return v_expires;
end $$;

-- Single-use claim: the row lock plus clearing the code make a second claim of
-- the same code fail. Returns the device id, or null for an unknown, expired or
-- already used code (indistinguishable to the caller).
create function public.claim_device(
  p_code_hash text, p_token_hash text, p_device_label text, p_mentra_user_id text
) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row public.device_associations%rowtype;
  v_now timestamptz;
begin
  select * into v_row from public.device_associations
   where pairing_code_hash = p_code_hash and linked_at is null and revoked_at is null
   for update;
  v_now := clock_timestamp();
  if not found or v_row.pairing_expires_at is null or v_row.pairing_expires_at <= v_now then
    return null;
  end if;

  -- One active device per user: the new link replaces the old one, and a
  -- signal sent by the old device does not survive it.
  update public.device_associations set revoked_at = v_now
   where user_id = v_row.user_id and linked_at is not null and revoked_at is null;
  update public.interest_events set status = 'cancelled', resolved_at = v_now
   where user_id = v_row.user_id and status = 'pending' and source = 'mentra_touch';

  update public.device_associations
     set token_hash = p_token_hash, device_label = p_device_label,
         mentra_user_id = p_mentra_user_id, linked_at = v_now, last_seen_at = v_now,
         pairing_code_hash = null, pairing_expires_at = null
   where id = v_row.id;
  return v_row.id;
end $$;

-- Unlink (device disconnect): revokes the device, drops any open pairing and
-- cancels a pending glasses signal. A fresh gesture is required after re-linking.
create function public.unlink_device(p_user_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.device_associations set revoked_at = v_now
   where user_id = p_user_id and linked_at is not null and revoked_at is null;
  delete from public.device_associations
   where user_id = p_user_id and linked_at is null;
  update public.interest_events set status = 'cancelled', resolved_at = v_now
   where user_id = p_user_id and status = 'pending' and source = 'mentra_touch';
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: service role only.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
