-- Place-based matching: two strangers match when both signal within the
-- window while in the same place. "Same place" is a shared venue check-in, or
-- two phone locations close to each other. Replaces the pre-joined two-person
-- demo session. Mirrors packages/contracts (encounter.ts, interest.ts,
-- common.ts) and packages/matching.
--
-- Additive: the session tables and submit_interest stay so code deployed
-- before this migration keeps working. A later migration removes them.
--
-- Constants (keep in step with packages/contracts/src/common.ts):
--   MATCH_WINDOW_SECONDS          15
--   MATCH_RADIUS_M                40
--   LOCATION_MAX_AGE_SECONDS      60
--   LOCATION_MAX_ACCURACY_M       100
--   LOCATION_RETENTION_MINUTES    10
--   CHECK_IN_HOURS                8

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A place people can check into by scanning its QR code or typing its code.
create table public.venues (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  code       text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  created_by uuid references auth.users (id) on delete set null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Where a person is right now, as far as Cue knows. One row per user.
-- Coordinates exist only here, only while encounter mode is on, and are
-- cleared when stale. They are never copied to signals or matches and are not
-- readable from a browser.
create table public.user_presence (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  encounter_mode boolean not null default false,
  venue_id       uuid references public.venues (id) on delete set null,
  checked_in_at  timestamptz,
  lat            double precision check (lat between -90 and 90),
  lng            double precision check (lng between -180 and 180),
  accuracy_m     double precision check (accuracy_m >= 0),
  located_at     timestamptz,
  updated_at     timestamptz not null default now(),
  check ((venue_id is null) = (checked_in_at is null)),
  check ((lat is null) = (lng is null)
     and (lat is null) = (accuracy_m is null)
     and (lat is null) = (located_at is null))
);
create index user_presence_venue on public.user_presence (venue_id) where venue_id is not null;

-- Signals no longer need a session.
alter table public.interest_events alter column session_id drop not null;
create unique index interest_events_one_pending_per_user
  on public.interest_events (user_id)
  where status = 'pending' and session_id is null;
create index interest_events_place_pending
  on public.interest_events (expires_at)
  where status = 'pending' and session_id is null;

-- Matches record a coarse place only: a venue's name, or "Nearby".
alter table public.matches alter column session_id drop not null;
alter table public.matches add column venue_id uuid references public.venues (id) on delete set null;
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.matches'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%venue_label_source%'
  loop
    execute format('alter table public.matches drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.matches
  add constraint matches_venue_label_source_check
  check (venue_label_source in ('manual', 'venue_checkin', 'phone_location'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Great-circle distance in metres (haversine, mean Earth radius).
create function public.distance_m(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
) returns double precision
language sql immutable set search_path = public, pg_temp as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2))));
$$;

-- Every matching decision, and everything that must not race one (mode off,
-- check-out, block), takes this one transaction-level lock. Fine at demo
-- scale; it is the limit on matching throughput.
create function public._matching_lock() returns void
language sql set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtext('cue.matching'));
$$;

-- The venue a presence row is validly checked into at p_now, or null.
create function public._presence_venue(p public.user_presence, p_now timestamptz) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select v.id from public.venues v
   where v.id = p.venue_id and v.active
     and p.checked_in_at > p_now - interval '8 hours';
$$;

-- Whether a presence row has a location fresh and accurate enough to match on.
create function public._presence_located(p public.user_presence, p_now timestamptz) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p.lat is not null
     and p.located_at > p_now - interval '60 seconds'
     and p.accuracy_m <= 100;
$$;

-- Clears coordinates nobody has refreshed for 10 minutes.
create function public._sweep_stale_locations(p_now timestamptz) returns void
language sql set search_path = public, pg_temp as $$
  update public.user_presence
     set lat = null, lng = null, accuracy_m = null, located_at = null, updated_at = p_now
   where lat is not null and located_at <= p_now - interval '10 minutes';
$$;

-- ---------------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------------

-- What the caller's own screens (and their glasses bridge) need to know.
-- Never returns coordinates.
--   { encounter_mode, ready,
--     venue: { id, name, code, checked_in_at, expires_at } | null,
--     location: { status: none|fresh|stale|inaccurate, accuracy_m, located_at } }
create function public.presence_state(p_user_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_p     public.user_presence%rowtype;
  v_venue public.venues%rowtype;
  v_loc   jsonb;
  v_ven   jsonb := null;
begin
  select * into v_p from public.user_presence where user_id = p_user_id;
  if not found then
    return jsonb_build_object(
      'encounter_mode', false, 'ready', false, 'venue', null,
      'location', jsonb_build_object('status', 'none', 'accuracy_m', null, 'located_at', null));
  end if;

  select * into v_venue from public.venues where id = public._presence_venue(v_p, v_now);
  if found then
    v_ven := jsonb_build_object(
      'id', v_venue.id, 'name', v_venue.name, 'code', v_venue.code,
      'checked_in_at', v_p.checked_in_at,
      'expires_at', v_p.checked_in_at + interval '8 hours');
  end if;

  v_loc := jsonb_build_object(
    'status', case
      when v_p.lat is null then 'none'
      when v_p.located_at <= v_now - interval '60 seconds' then 'stale'
      when v_p.accuracy_m > 100 then 'inaccurate'
      else 'fresh' end,
    'accuracy_m', v_p.accuracy_m,
    'located_at', v_p.located_at);

  return jsonb_build_object(
    'encounter_mode', v_p.encounter_mode,
    'ready', v_p.encounter_mode and (v_ven is not null or public._presence_located(v_p, v_now)),
    'venue', v_ven,
    'location', v_loc);
end $$;

-- Turning encounter mode off cancels the caller's pending signal and forgets
-- their location, under the matching lock so it cannot race a match.
create function public.set_presence_mode(p_user_id uuid, p_enabled boolean) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz;
begin
  perform public._matching_lock();
  v_now := clock_timestamp();

  insert into public.user_presence (user_id, encounter_mode, updated_at)
  values (p_user_id, p_enabled, v_now)
  on conflict (user_id) do update set encounter_mode = excluded.encounter_mode, updated_at = v_now;

  if not p_enabled then
    update public.user_presence
       set lat = null, lng = null, accuracy_m = null, located_at = null
     where user_id = p_user_id;
    update public.interest_events
       set status = 'cancelled', resolved_at = v_now
     where user_id = p_user_id and session_id is null and status = 'pending';
  end if;
end $$;

-- Stores the phone's latest position. Ignored (false) unless encounter mode is
-- on: Cue does not keep a location for someone who is not open to signals.
create function public.report_location(
  p_user_id uuid, p_lat double precision, p_lng double precision, p_accuracy_m double precision
) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  perform public._sweep_stale_locations(v_now);
  update public.user_presence
     set lat = p_lat, lng = p_lng, accuracy_m = p_accuracy_m, located_at = v_now, updated_at = v_now
   where user_id = p_user_id and encounter_mode;
  return found;
end $$;

create function public.clear_location(p_user_id uuid) returns void
language sql set search_path = public, pg_temp as $$
  update public.user_presence
     set lat = null, lng = null, accuracy_m = null, located_at = null, updated_at = clock_timestamp()
   where user_id = p_user_id and lat is not null;
$$;

-- ---------------------------------------------------------------------------
-- Venues
-- ---------------------------------------------------------------------------

create function public._check_in(p_user_id uuid, p_venue_id uuid, p_now timestamptz) returns void
language sql set search_path = public, pg_temp as $$
  insert into public.user_presence (user_id, venue_id, checked_in_at, updated_at)
  values (p_user_id, p_venue_id, p_now, p_now)
  on conflict (user_id) do update
    set venue_id = excluded.venue_id, checked_in_at = excluded.checked_in_at, updated_at = p_now;
$$;

-- Creates a venue and checks its creator in. A code collision raises 23505; retry.
create function public.create_venue(p_user_id uuid, p_name text, p_code text) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.venues (name, code, created_by) values (p_name, p_code, p_user_id)
  returning id into v_id;
  perform public._check_in(p_user_id, v_id, clock_timestamp());
  return v_id;
end $$;

-- 'checked_in' or 'not_found' (unknown or inactive code; indistinguishable).
create function public.check_in_venue(p_user_id uuid, p_code text) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  select id into v_id from public.venues where code = p_code and active;
  if v_id is null then
    return 'not_found';
  end if;
  perform public._check_in(p_user_id, v_id, clock_timestamp());
  return 'checked_in';
end $$;

-- Leaving a venue cancels a pending signal that relied on it.
create function public.check_out_venue(p_user_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz;
begin
  perform public._matching_lock();
  v_now := clock_timestamp();
  update public.user_presence
     set venue_id = null, checked_in_at = null, updated_at = v_now
   where user_id = p_user_id and venue_id is not null;
  if found then
    update public.interest_events
       set status = 'cancelled', resolved_at = v_now
     where user_id = p_user_id and session_id is null and status = 'pending';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------

-- Returns { status, received_at, expires_at, matched, match_id, reason }.
--
-- A signal pairs, on arrival, with the closest other person who has an
-- unexpired pending signal and is in the same place: checked into the same
-- venue, or with a usable phone location within MATCH_RADIUS_M once both
-- accuracies are allowed for. "Closest" is by distance when both have a
-- usable location; otherwise the most recent signal. In a crowd this can pick
-- someone the caller did not mean: that is the accepted cost of matching
-- strangers without a pre-joined session.
--
-- Privacy: nothing here reads back or changes another person's signal unless
-- a match is being created. Blocked pairs (either direction) and pairs that
-- are already matched are simply never candidates, so neither a block nor an
-- existing match is disclosed.
create function public.submit_signal(
  p_user_id uuid, p_event_id uuid, p_source text, p_gesture text, p_occurred_at timestamptz
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_window    constant interval := interval '15 seconds';
  v_radius_m  constant double precision := 40;
  v_now       timestamptz;
  v_me        public.user_presence%rowtype;
  v_mine      public.interest_events%rowtype;
  v_my_venue  uuid;
  v_located   boolean;
  v_theirs_id uuid;
  v_other_id  uuid;
  v_their_at  timestamptz;
  v_shared    boolean;
  v_label     text;
  v_match_id  uuid;
begin
  if p_user_id is null or p_event_id is null or p_occurred_at is null
     or not coalesce(public.interest_pair_ok(p_source, p_gesture), false) then
    return public._interest_result('rejected', clock_timestamp(), null, false, null, 'invalid_event');
  end if;

  perform public._matching_lock();
  -- Server receipt time: read after the lock, so receipt order is processing order.
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

  select * into v_me from public.user_presence where user_id = p_user_id;
  if not found or not v_me.encounter_mode then
    return public._interest_result('rejected', v_now, null, false, null, 'encounter_mode_off');
  end if;

  v_my_venue := public._presence_venue(v_me, v_now);
  v_located  := public._presence_located(v_me, v_now);
  if v_my_venue is null and not v_located then
    return public._interest_result('rejected', v_now, null, false, null, 'no_place');
  end if;

  -- Expire the caller's OWN stale signals. Expired signals are never replayed.
  update public.interest_events
     set status = 'expired', resolved_at = v_now
   where user_id = p_user_id and status = 'pending' and expires_at <= v_now;

  -- One gesture: a second signal while one is pending creates nothing.
  select * into v_mine from public.interest_events
   where user_id = p_user_id and session_id is null and status = 'pending';
  if found then
    return public._interest_result('duplicate', v_mine.received_at, v_mine.expires_at, false, null, null);
  end if;

  select e.id, e.user_id, e.received_at,
         (v_my_venue is not null and public._presence_venue(pr, v_now) = v_my_venue)
    into v_theirs_id, v_other_id, v_their_at, v_shared
    from public.interest_events e
    join public.user_presence pr on pr.user_id = e.user_id
   where e.status = 'pending' and e.session_id is null and e.expires_at > v_now
     and e.user_id <> p_user_id
     and pr.encounter_mode
     and not exists (select 1 from public.blocks b
                      where (b.blocker_id = p_user_id and b.blocked_id = e.user_id)
                         or (b.blocker_id = e.user_id and b.blocked_id = p_user_id))
     and not exists (select 1 from public.matches m
                      where m.user_a = least(p_user_id, e.user_id)
                        and m.user_b = greatest(p_user_id, e.user_id)
                        and m.status = 'active')
     and (
       (v_my_venue is not null and public._presence_venue(pr, v_now) = v_my_venue)
       or (v_located and public._presence_located(pr, v_now)
           and greatest(0, public.distance_m(v_me.lat, v_me.lng, pr.lat, pr.lng)
                           - v_me.accuracy_m - pr.accuracy_m) <= v_radius_m)
     )
   order by
     case when v_located and public._presence_located(pr, v_now)
          then public.distance_m(v_me.lat, v_me.lng, pr.lat, pr.lng) end asc nulls last,
     e.received_at desc
   limit 1
   for update of e;

  if found then
    if v_shared then
      select name into v_label from public.venues where id = v_my_venue;
    end if;

    insert into public.matches
      (session_id, venue_id, user_a, user_b, first_signal_at, venue_label, venue_label_source)
    values
      (null, case when v_shared then v_my_venue end,
       least(p_user_id, v_other_id), greatest(p_user_id, v_other_id), v_their_at,
       case when v_shared then v_label else 'Nearby' end,
       case when v_shared then 'venue_checkin' else 'phone_location' end)
    returning id into v_match_id;

    update public.interest_events
       set status = 'consumed', resolved_at = v_now, match_id = v_match_id
     where id = v_theirs_id;

    insert into public.interest_events
      (event_id, user_id, session_id, source, gesture, occurred_at,
       received_at, expires_at, status, resolved_at, match_id)
    values
      (p_event_id, p_user_id, null, p_source, p_gesture, p_occurred_at,
       v_now, v_now + v_window, 'consumed', v_now, v_match_id);

    return public._interest_result('accepted', v_now, null, true, v_match_id, null);
  end if;

  insert into public.interest_events
    (event_id, user_id, session_id, source, gesture, occurred_at, received_at, expires_at, status)
  values
    (p_event_id, p_user_id, null, p_source, p_gesture, p_occurred_at,
     v_now, v_now + v_window, 'pending');

  return public._interest_result('accepted', v_now, v_now + v_window, false, null, null);
end $$;

-- Demo reset: expires the caller's pending signal and ends the matches they
-- made in the last 12 hours (which deletes cached suggestions and chat).
-- p_leave also checks them out, turns encounter mode off and forgets their
-- location.
create function public.reset_my_demo(p_user_id uuid, p_leave boolean) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz;
begin
  perform public._matching_lock();
  v_now := clock_timestamp();

  update public.interest_events set status = 'expired', resolved_at = v_now
   where user_id = p_user_id and session_id is null and status = 'pending';

  update public.matches
     set status = 'ended', ended_by = p_user_id, ended_reason = 'reset', ended_at = v_now
   where p_user_id in (user_a, user_b) and status = 'active'
     and created_at > v_now - interval '12 hours';

  if p_leave then
    update public.user_presence
       set encounter_mode = false, venue_id = null, checked_in_at = null,
           lat = null, lng = null, accuracy_m = null, located_at = null, updated_at = v_now
     where user_id = p_user_id;
  end if;
end $$;

-- Block also takes the matching lock, so a concurrent submit_signal either
-- finished before (its match is ended here) or runs after (and sees the block).
create or replace function public.block_user(p_blocker_id uuid, p_blocked_id uuid) returns void
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
  perform public._matching_lock();

  insert into public.blocks (blocker_id, blocked_id) values (p_blocker_id, p_blocked_id)
  on conflict do nothing;

  update public.matches
     set status = 'ended', ended_by = p_blocker_id, ended_reason = 'block', ended_at = clock_timestamp()
   where user_a = least(p_blocker_id, p_blocked_id)
     and user_b = greatest(p_blocker_id, p_blocked_id)
     and status = 'active';
end $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------

-- No browser access at all: presence (and its coordinates) and venues are read
-- and written only through the API.
alter table public.venues        enable row level security;
alter table public.user_presence enable row level security;
revoke all on table public.venues, public.user_presence from anon, authenticated;
grant all on table public.venues, public.user_presence to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
