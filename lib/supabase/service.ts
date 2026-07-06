import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client that authenticates with the service role key.
 *
 * Unlike the SSR clients in `client.ts` / `server.ts`, this one runs outside of
 * a request/cookie context (e.g. inside the Discord bot) and therefore uses the
 * service role key. It must only ever be imported from server-side code — never
 * from the browser — because the service role key bypasses row level security.
 */

function readServiceCredentials(): { url?: string; serviceKey?: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
  };
}

/**
 * Whether the environment has the credentials required to talk to Supabase with
 * the service role. Used to decide between the Supabase and in-memory stores.
 */
export function hasSupabaseServiceCredentials(): boolean {
  const { url, serviceKey } = readServiceCredentials();
  return Boolean(url && serviceKey);
}

const globalForSupabase = globalThis as typeof globalThis & {
  supabaseServiceClient?: SupabaseClient;
};

/**
 * Create (or reuse) the service-role Supabase client. Cached on a global so it
 * survives Next.js hot reloads, mirroring the Discord client pattern.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  const { url, serviceKey } = readServiceCredentials();

  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for the service client.",
    );
  }

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
