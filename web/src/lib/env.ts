/**
 * Centralised environment resolution for the teacher web.
 *
 * Every credential, service endpoint and deployment-specific link is resolved
 * here so no call site reads `process.env` directly. Two reasons:
 *
 *   1. Supabase rotated its key naming scheme. Projects created before it expose
 *      `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, newer ones
 *      expose `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`, and
 *      Vercel injects either shape depending on how the integration was set up.
 *      The resolvers below accept both, in a documented priority order, so a
 *      deployment never fails merely because of which keys the operator pasted.
 *   2. A missing value throws with an actionable message instead of letting
 *      `undefined` reach a client constructor, where it surfaces as an opaque
 *      "Invalid URL" or a silently unauthenticated request.
 *
 * `NEXT_PUBLIC_*` values are inlined at BUILD time, so changing one requires a
 * redeploy. The non-prefixed fallbacks are read at runtime on the server only —
 * in the browser they are `undefined` by design, which is exactly why the
 * public name comes first in every chain.
 */

/** First candidate that is a non-empty (trimmed) string, else `undefined`. */
function firstNonEmpty(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

/** Removes every trailing slash, so path concatenation stays unambiguous. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Supabase project URL.
 *
 * `SUPABASE_URL` is accepted as a server-side alias because that is the name
 * the Vercel↔Supabase integration and the Worker both use; the browser always
 * needs the `NEXT_PUBLIC_` form.
 */
export function getSupabaseUrl(): string {
  const url = firstNonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_URL);
  if (!url) {
    throw new Error(
      'Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) — see .env.example.',
    );
  }
  return stripTrailingSlashes(url);
}

/**
 * Supabase publishable (browser-safe) key.
 *
 * This key ships to the browser by design: every teacher-owned table is guarded
 * by RLS, so holding it grants nothing beyond what `auth.uid()` already limits.
 */
export function getSupabasePublishableKey(): string {
  const key = firstNonEmpty(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_ANON_KEY,
  );
  if (!key) {
    throw new Error(
      'Missing Supabase publishable key. Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ' +
        '(or NEXT_PUBLIC_SUPABASE_ANON_KEY) — see .env.example.',
    );
  }
  return key;
}

/**
 * Supabase secret (service-role) key. SERVER ONLY — never prefix it with
 * `NEXT_PUBLIC_`, which would inline it into the browser bundle.
 *
 * Nothing in the app currently calls this: every privileged operation runs
 * through a `SECURITY DEFINER` RPC invoked with the caller's own session. It
 * exists so an admin/back-office path has one audited place to read the key
 * from, rather than a second ad-hoc `process.env` lookup appearing later.
 */
export function getSupabaseSecretKey(): string {
  const key = firstNonEmpty(process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) {
    throw new Error(
      'Missing Supabase secret key. Set SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) ' +
        '— see .env.example.',
    );
  }
  return key;
}

/**
 * AI model the teacher web requests when the teacher leaves the model selector
 * on its default option.
 *
 * Returns `null` when unset, which means "send no model" — the Worker then
 * applies its own `AI_MODEL_NAME` binding. That keeps the Worker authoritative
 * for its deployment (an operator can retarget every caller by editing
 * wrangler.toml alone) while still letting the web override it per-deployment.
 */
export function getAiModelName(): string | null {
  return firstNonEmpty(process.env.NEXT_PUBLIC_AI_MODEL_NAME, process.env.AI_MODEL_NAME) ?? null;
}

/**
 * AI provider id, lower-cased. Defaults to `gemini`, the only provider the
 * Worker's Engine 2 implements; the preset model list is keyed on it so a
 * future provider cannot silently offer models it cannot call.
 */
export function getAiProvider(): string {
  return (
    firstNonEmpty(process.env.NEXT_PUBLIC_AI_PROVIDER, process.env.AI_PROVIDER)?.toLowerCase() ??
    'gemini'
  );
}

/**
 * Origin of the student SPA, used to build every student-facing deep link
 * (exam join links, QR codes, Tree of Knowledge join URLs).
 *
 * Falls back to the current origin so local development works with no
 * configuration; callers append their own `/?<param>=` suffix.
 */
export function resolveStudentAppBaseUrl(): string {
  const configured = firstNonEmpty(process.env.NEXT_PUBLIC_STUDENT_APP_URL);
  if (configured) return stripTrailingSlashes(configured);
  if (typeof window !== 'undefined') return stripTrailingSlashes(window.location.origin);
  return '';
}

/**
 * Full Cloudflare Worker extraction endpoint (`…/api/v1/extract`).
 *
 * Trailing slashes are stripped: the proxy appends `?mode=…` to this value, and
 * a trailing slash would produce a `…//?mode=` path that some origins 404.
 * Returns `null` when unconfigured so the route can answer with a clear
 * NOT_CONFIGURED error rather than an opaque fetch failure.
 */
export function getExtractorEndpoint(): string | null {
  const endpoint = firstNonEmpty(process.env.NEXT_PUBLIC_EXTRACTOR_API_URL);
  return endpoint ? stripTrailingSlashes(endpoint) : null;
}

/**
 * Shared secret sent to the Worker in `X-Internal-Secret`. SERVER ONLY.
 *
 * Optional by design: when unset (local `wrangler dev`), the Worker bypasses
 * the header check, so the proxy simply omits the header.
 */
export function getExtractorInternalSecret(): string | null {
  return firstNonEmpty(process.env.EXTRACTOR_INTERNAL_SECRET) ?? null;
}
