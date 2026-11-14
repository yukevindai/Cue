import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { getAdminSupabase } from "@/server/supabase-admin";

/** Throws on a PostgREST error so callers never read `data` from a failed query. */
export function unwrap<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw new Error(`database error ${res.error.code}: ${res.error.message}`);
  return res.data;
}

/** Call a service-role-only SQL function (see supabase/migrations). */
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return unwrap(await getAdminSupabase().rpc(fn, args)) as T;
}

/** Postgres timestamptz text -> ISO 8601 UTC string accepted by the contracts. */
export function iso(value: string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: string | null | undefined): string | null {
  return value ? iso(value) : null;
}
