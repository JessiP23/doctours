import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '@/lib/env';
import type { Database } from './types';

/**
 * Server-only Supabase client using the service-role key.
 *
 * RLS is enabled on every table with no policies, so this client is the only
 * thing that can read or write. It must never be imported into client code —
 * the 'server-only' import makes that a build error.
 */
let client: SupabaseClient<Database> | undefined;

export function db(): SupabaseClient<Database> {
  if (client) return client;
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
