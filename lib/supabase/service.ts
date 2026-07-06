import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client using the service role key.
 * Cached globally to survive Next.js hot reloads.
 */
const globalForSupabase = globalThis as typeof globalThis & {
  supabaseServiceClient?: SupabaseClient;
};

export function hasSupabaseServiceCredentials(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function getSupabaseServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!globalForSupabase.supabaseServiceClient) {
    globalForSupabase.supabaseServiceClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return globalForSupabase.supabaseServiceClient;
}