import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase auth session on every request and keeps the auth
 * cookies in sync between the browser and the server.
 *
 * Without this, a Server Component read after a token expiry would see a stale
 * session and silently return an empty (RLS-filtered) result set.
 *
 * Invoked from src/proxy.ts (Next.js 16 replaced the `middleware` convention
 * with `proxy`).
 *
 * Key selection mirrors client.ts/server.ts so the refreshed session is usable
 * by both.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Touch getUser() so an expired token is refreshed before the page renders.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate the teacher area. /login and the auth callback stay public.
  const { pathname } = request.nextUrl;
  const isProtected = pathname !== '/login' && !pathname.startsWith('/auth');

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return response;
}
