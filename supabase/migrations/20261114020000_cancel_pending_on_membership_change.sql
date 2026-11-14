-- A pending signal is interest in the one other person who was in the session
-- when it was sent. If the set of active members changes (someone leaves, or
-- someone new joins), every pending signal in that session is cancelled, so a
-- replacement participant can never complete a match from interest that was
-- meant for somebody else. Fresh gestures are required after any change.
--
-- The first migration is already applied to the hosted project, so this is a
-- separate migration rather than an edit to leave/join_demo_session.
create function public.demo_session_members_cancel_pending() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.interest_events
     set status = 'cancelled', resolved_at = clock_timestamp()
   where session_id = new.session_id and status = 'pending';
  return null;
end $$;

revoke all on function public.demo_session_members_cancel_pending() from public, anon, authenticated;

create trigger demo_session_members_cancel_pending_on_join
  after insert on public.demo_session_members
  for each row execute function public.demo_session_members_cancel_pending();

create trigger demo_session_members_cancel_pending_on_leave
  after update of left_at on public.demo_session_members
  for each row when (old.left_at is null and new.left_at is not null)
  execute function public.demo_session_members_cancel_pending();
