import "server-only";

import { getServerSupabase } from "@/lib/supabase/server";
import { HttpError } from "@/server/http";

export interface SessionUser {
  id: string;
  email: string | null;
}

/** The signed-in web user from the Supabase cookie session, verified with the auth server. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError("unauthenticated", "Sign in required");
  return user;
}
