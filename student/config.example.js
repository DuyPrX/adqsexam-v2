/**
 * ADQS Exam v2 — Student SPA runtime configuration (TEMPLATE).
 * =====================================================================
 * Copy this file to `config.js` in the same directory and fill in the values
 * for YOUR deployment:
 *
 *     cp config.example.js config.js
 *
 * `config.js` is git-ignored on purpose: it names one specific Supabase project
 * and one specific Worker, and those differ per school. Nothing here is a
 * secret — see "Security" below — but committing a concrete deployment's
 * endpoints would point every other operator's students at it.
 *
 * index.html loads `config.js` before `app.js`, which reads the values through
 * `app-config.js`. If `config.js` is missing or the two required values are
 * blank, the SPA shows "Chưa cấu hình Supabase" instead of failing obscurely.
 * =====================================================================
 */

window.__APP_CONFIG__ = {
  /**
   * Supabase project URL.
   * Dashboard → Project Settings → Data API → Project URL.
   * Example: 'https://abcdefghijklmnop.supabase.co'
   */
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',

  /**
   * Supabase PUBLISHABLE key (the modern replacement for the anon key).
   *
   * The `supabaseAnonKey` name is also accepted, so either dashboard value
   * works:
   *   Modern: Project Settings → API Keys → Publishable key  ('sb_publishable_…')
   *   Legacy: Project Settings → API Keys → anon public       (a JWT)
   */
  supabasePublishableKey: 'YOUR_PUBLISHABLE_OR_ANON_KEY',

  /**
   * Base origin of the Cloudflare Worker that parses a student's own .docx
   * (the self-practice feature). `POST /api/v1/extract-practice`.
   *
   * Use the ORIGIN only, with no path and no trailing slash — the SPA appends
   * `/api/v1/extract-practice` itself. A full endpoint URL is also tolerated
   * (the known path is stripped).
   *
   * Leave EMPTY to disable the personal-.docx practice feature: the SPA then
   * tells the student it is unconfigured rather than firing a request at a
   * static host that would 404.
   * Example: 'https://docx-extractor-v2.example.workers.dev'
   */
  workerApiUrl: '',
};

/* =====================================================================
 * Security
 * ---------------------------------------------------------------------
 * Both the Supabase URL and the publishable key are PUBLIC BY DESIGN and are
 * expected to ship in this static bundle:
 *
 *   - The publishable key reaches only RLS-guarded RPCs. Students hold ZERO
 *     table privileges, and every student action goes through a SECURITY
 *     DEFINER function (see v2/supabase/schema.sql, Section B/C).
 *   - The practice endpoint is deliberately secret-free and forced to the
 *     rule engine, so it cannot burn AI tokens (Phase 5.2).
 *
 * NEVER put a service_role / secret key, or the Worker's INTERNAL_SECRET, in
 * this file. A static SPA cannot keep a secret — anything here is readable by
 * every visitor.
 * ===================================================================== */
