import { createBrowserClient } from '@supabase/ssr';
import { getSupabasePublishableKey, getSupabaseUrl } from '../env';

/**
 * Browser-side Supabase client.
 *
 * Uses the publishable key only. Every teacher-owned table is guarded by RLS
 * (`auth.uid() = user_id`), so this client can never read another tenant's rows
 * even though the key ships to the browser.
 *
 * Key + URL resolution (including the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`
 * fallback) lives in `lib/env.ts`, so all three clients — browser, server and
 * middleware — agree on which project they are talking to.
 */
export function createClient() {
  return createBrowserClient(getSupabaseUrl(), getSupabasePublishableKey());
}
