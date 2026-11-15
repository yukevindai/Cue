-- A third signal source: `headset_remote`.
--
-- A signed-in web page that holds the phone's audio session receives standard
-- headset media commands (for example a double tap on the temple of Meta
-- glasses arrives as "next track"). The page sends such a command as an
-- interest signal with its web session. Matching rules are unchanged: any two
-- distinct members' signals inside the window match, whatever their sources.
--
-- The allowed (source, gesture) pairs now live in ONE function used by both the
-- table constraint and submit_interest, so the next source is a one-line change.
-- Mirrors GESTURES_BY_SOURCE in packages/contracts/src/interest.ts.

create function public.interest_pair_ok(p_source text, p_gesture text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
    (p_source = 'mentra_touch' and p_gesture = 'backward_swipe')
    or (p_source = 'web_demo' and p_gesture = 'web_confirm')
    or (p_source = 'headset_remote'
        and p_gesture in ('media_next_track', 'media_previous_track', 'media_play_pause')),
    false);
$$;

revoke execute on function public.interest_pair_ok(text, text) from public, anon, authenticated;
grant execute on function public.interest_pair_ok(text, text) to service_role;

-- Replace the three inline CHECKs (source list, gesture list, pairing) with one.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.interest_events'::regclass
       and contype = 'c'
       and (pg_get_constraintdef(oid) like '%mentra_touch%'
            or pg_get_constraintdef(oid) like '%backward_swipe%')
  loop
    execute format('alter table public.interest_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.interest_events
  add constraint interest_events_source_gesture_check
  check (public.interest_pair_ok(source, gesture));

-- submit_interest: swap its hard-coded pair test for the shared function. The
-- first migration is already applied to the hosted project, so the stored
-- definition is rewritten in place; everything else in the function is kept
-- byte for byte. Fails loudly if the expected text is not there.
do $$
declare
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_old
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_interest';

  v_new := regexp_replace(
    v_old,
    'not \(\(p_source = ''mentra_touch'' and p_gesture = ''backward_swipe''\)\s+or \(p_source = ''web_demo'' and p_gesture = ''web_confirm''\)\)',
    'not public.interest_pair_ok(p_source, p_gesture)');

  if v_new is null or v_new = v_old then
    raise exception 'submit_interest: source/gesture guard not found; migration needs updating';
  end if;
  execute v_new;
end $$;
