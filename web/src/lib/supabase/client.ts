import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client.
 *
 * Uses the publishable key only. Every teacher-owned table is guarded by RLS
 * (`auth.uid() = user_id`), so this client can never read another tenant's rows
 * even though the key ships to the browser.
 *
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` remains a fallback for projects created before
 * the publishable/secret key scheme.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
