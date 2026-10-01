import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client (Route Handlers / Server Components).
 *
 * The auth session lives in httpOnly-adjacent cookies managed by @supabase/ssr.
 * `setAll` is wrapped in try/catch because Server Components are not allowed to
 * mutate cookies — the middleware is what actually refreshes the session.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
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
}
