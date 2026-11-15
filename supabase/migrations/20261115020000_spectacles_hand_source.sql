-- A fourth signal source: `spectacles_hand`.
--
-- The Cue Lens on Snap Spectacles (apps/spectacles) recognises a double pinch
-- with Spectacles hand tracking and sends it as an interest signal with a
-- device token, exactly like the Mentra miniapp. Matching rules are unchanged:
-- any two distinct members' signals inside the window match, whatever their
-- sources.
--
-- interest_pair_ok backs both the interest_events check constraint and the
-- guard in submit_interest (20261115000000_headset_remote_source.sql), so
-- widening it here is the whole database change. The new definition is a strict
-- superset of the old one, so every existing row still satisfies the constraint.
-- Mirrors GESTURES_BY_SOURCE in packages/contracts/src/interest.ts.
--
-- Which credential may send which source (device token vs web session) is
-- checked in the API (sourceAllowedForAuth, packages/matching), not here.

create or replace function public.interest_pair_ok(p_source text, p_gesture text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
    (p_source = 'mentra_touch' and p_gesture = 'backward_swipe')
    or (p_source = 'web_demo' and p_gesture = 'web_confirm')
    or (p_source = 'headset_remote'
        and p_gesture in ('media_next_track', 'media_previous_track', 'media_play_pause'))
    or (p_source = 'spectacles_hand' and p_gesture = 'double_pinch'),
    false);
$$;

-- create or replace keeps existing grants; restate them so the intent is local.
revoke execute on function public.interest_pair_ok(text, text) from public, anon, authenticated;
grant execute on function public.interest_pair_ok(text, text) to service_role;
