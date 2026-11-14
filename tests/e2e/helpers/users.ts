import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { stackEnv } from "./env";

/** A synthetic test account. Never real personal data. */
export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** Random marker embedded in the display name so leaks are greppable. */
  marker: string;
}

let admin: SupabaseClient | undefined;

/** Service-role client. Test-only; used for user lifecycle (and nothing in the web app). */
export function adminClient(): SupabaseClient {
  if (!admin) {
    const { supabaseUrl, serviceRoleKey } = stackEnv();
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

/** Creates a confirmed user through the Supabase admin API. */
export async function createTestUser(): Promise<TestUser> {
  const marker = randomBytes(4).toString("hex");
  const email = `e2e-${randomUUID()}@cue.test`;
  const password = `pw-${randomBytes(12).toString("hex")}`;
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message ?? "no user"}`);
  return { id: data.user.id, email, password, marker };
}

export async function deleteTestUser(user: TestUser): Promise<void> {
  const { error } = await adminClient().auth.admin.deleteUser(user.id);
  if (error) throw new Error(`deleteUser ${user.id} failed: ${error.message}`);
}
