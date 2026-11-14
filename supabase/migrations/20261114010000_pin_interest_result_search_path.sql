-- Pin the search_path of the one helper that was created without it
-- (Supabase advisor: function_search_path_mutable). The first migration is
-- already applied to the hosted project, so this is a separate migration.
alter function public._interest_result(text, timestamptz, timestamptz, boolean, uuid, text)
  set search_path = public, pg_temp;
