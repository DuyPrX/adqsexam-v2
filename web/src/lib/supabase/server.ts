import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabasePublishableKey, getSupabaseUrl } from '../env';

/**
 * Server-side Supabase client (Route Handlers / Server Components).
 *
 * The auth session lives in httpOnly-adjacent cookies managed by @supabase/ssr.
 * `setAll` is wrapped in try/catch because Server Components are not allowed to
 * mutate cookies — the middleware is what actually refreshes the session.
 *
 * URL + key resolution (including the legacy anon-key fallback) lives in
 * `lib/env.ts` and is shared with the browser client and the middleware, so the
 * session written by one is always readable by the others.
 *
 * Wrapped in React `cache` so a page (and everything it renders) shares ONE
 * client per request instead of constructing one per call site — each
 * construction re-reads the cookie store and re-validates the session.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(
    getSupabaseUrl(),
    getSupabasePublishableKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component: the middleware refreshes instead.
          }
        },
      },
    },
  );
});
