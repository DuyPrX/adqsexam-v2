/**
 * Runtime configuration resolution for the student SPA.
 *
 * Deliberately dependency-free and DOM-free so the verification suite can
 * import and execute the SAME module the browser ships (the `exam-nav.js` /
 * `practice-order.js` precedent) rather than asserting against a copy.
 *
 * NOTHING here is hardcoded. Every deployment URL comes from
 * `window.__APP_CONFIG__`, which `config.js` populates: this app is a static
 * bundle deployed by more than one operator, and a baked-in project URL would
 * silently point a school's students at someone else's database.
 */

/** Removes every trailing slash so path concatenation stays unambiguous. */
export function stripTrailingSlashes(value) {
  const text = value == null ? '' : String(value).trim();
  return text.replace(/\/+$/, '');
}

/**
 * The Supabase connection, plus a `configured` flag.
 *
 * `supabaseAnonKey` is accepted as an alias for `supabasePublishableKey` because
 * Supabase renamed its keys and an operator editing `config.js` may paste
 * whichever name their dashboard shows. Callers must treat an unconfigured
 * result as fatal rather than falling back to a default project.
 */
export function resolveSupabaseConfig(config) {
  const source = config || {};
  const url = stripTrailingSlashes(source.supabaseUrl);
  const key = String(source.supabasePublishableKey || source.supabaseAnonKey || '').trim();
  return { url, key, configured: Boolean(url && key) };
}

/**
 * Absolute base URL of the Cloudflare Worker that parses a personal .docx.
 *
 * The student SPA is a STATIC bundle on Cloudflare Pages, which serves only
 * files under its assets directory — there is no server-side route handler, so
 * a relative `/api/v1/extract-practice` request 405s/404s. The Worker lives at
 * its own origin and must therefore be addressed absolutely.
 *
 * Returns `''` when unconfigured. That is intentional: the caller then reports
 * "chưa cấu hình" instead of issuing a request that would fail as an opaque 404
 * against the static host, and no development URL can leak into production.
 *
 * A configured value MAY be either the Worker's base origin or the full
 * practice endpoint — the known path is stripped so the caller can append its
 * own consistently.
 */
export function resolveWorkerBaseUrl(config) {
  const source = config || {};
  const configured = stripTrailingSlashes(source.workerApiUrl);
  if (!configured) return '';
  return stripTrailingSlashes(configured.replace(/\/api\/v1\/extract-practice\/?$/i, ''));
}
