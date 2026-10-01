import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/session';

/**
 * Next.js 16 request interceptor (the `proxy` convention, which supersedes the
 * deprecated `middleware.ts` file name).
 *
 * Sole responsibility: keep the Supabase auth session fresh and gate the
 * teacher area. It is not a data proxy — the extractor proxy lives in
 * src/app/api/extract/route.ts.
 */
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Every path except Next.js internals and static assets, so the auth
     * session is refreshed consistently across pages and route handlers.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
