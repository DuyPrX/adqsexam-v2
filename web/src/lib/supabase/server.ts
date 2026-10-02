import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client (Route Handlers / Server Components).
 *
 * The auth session lives in httpOnly-adjacent cookies managed by @supabase/ssr.
 * `setAll` is wrapped in try/catch because Server Components are not allowed to
 * mutate cookies — the middleware is what actually refreshes the session.
 *
 * The publishable key is preferred; `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a
 * fallback for projects created before the publishable/secret key scheme.
 *
 * Wrapped in React `cache` so a page (and everything it renders) shares ONE
 * client per request instead of constructing one per call site — each
 * construction re-reads the cookie store and re-validates the session.
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
