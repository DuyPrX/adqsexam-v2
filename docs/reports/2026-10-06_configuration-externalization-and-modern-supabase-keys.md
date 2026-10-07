# Change Report: Configuration Externalization & Modern Supabase Key Standardization (Phase 9)

- **Date:** 2026-10-06
- **Scope:** Major Change
- **Author/Agent:** TraeCode agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Remove every hardcoded credential, service endpoint, deep link and AI
  model name from the three deployable surfaces (teacher web, student SPA, Cloudflare
  Worker), and make all three accept Supabase's modern Publishable/Secret key names as
  well as the legacy anon/service-role names.
- **Root Cause / Motivation:** The v2 stack was deployable but not *portable*. Concrete
  Supabase endpoints and a production Worker URL were committed in
  `student/config.js`; AI model ids were literals in two runtimes; every `process.env`
  read was spread across call sites with its own ad-hoc fallback chain, so the answer to
  "which key does this actually use?" depended on which file you opened. A second
  operator could not deploy this codebase without editing source, and a wrong key name
  failed as an opaque `Invalid URL` instead of a clear message.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - **One resolution layer per runtime.** `web/src/lib/env.ts` owns every server/edge
    env read; `student/app-config.js` owns the SPA's `window.__APP_CONFIG__` reads.
    Both are dependency-free and DOM-free so the e2e suite imports and executes the
    same code the apps ship.
  - **Fallback chains, modern name first.**
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` → `NEXT_PUBLIC_SUPABASE_ANON_KEY` →
    `SUPABASE_ANON_KEY`, and `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`.
    A *blank* value is treated as absent (`firstNonEmpty` trims before testing), so a
    half-filled Vercel entry cannot shadow a real fallback with `''`.
  - **Fail loudly, not obscurely.** An unconfigured Supabase URL/key throws an error
    naming the missing variable and pointing at `.env.example`. Previously an
    undefined URL reached the client constructor.
  - **Trailing slashes stripped at every boundary** — Supabase URL, extractor endpoint,
    student app base, and the SPA's Worker base — because each is concatenated with a
    leading `/` at its call site.
  - **AI model split by authority.** The Worker's `AI_MODEL_NAME` binding is
    authoritative (the web sends *no* model when the teacher leaves the picker on
    "default"). `NEXT_PUBLIC_AI_MODEL_NAME` supplies only the picker's label. This
    means one Worker config edit retargets every caller.
  - **Preset shortlist kept in code (deliberate).** `lib/ai.ts` still lists three
    curated Gemini ids, gated on the configured provider, so a malformed env value
    cannot break the picker or advertise a model the deployment cannot call. The
    free-text option covers anything outside the shortlist.
- **Database Migrations:** None. This phase touches no schema.
- **API Contracts:**
  - **Worker `Env` gained `AI_MODEL_NAME` and `ALLOWED_ORIGINS`.** The previous names
    `DEFAULT_AI_MODEL` and `GEMINI_MODEL` remain honoured, with `AI_MODEL_NAME`
    winning, so already-deployed configurations keep working untouched.
  - **CORS is now binding-driven.** `app.use('*', cors())` became
    `app.use('*', (c, next) => cors(corsOptions(c.env))(c, next))`. `ALLOWED_ORIGINS`
    accepts `*` (default) or a comma-separated allow-list. A blank/whitespace value
    falls back to `*` rather than blocking every caller.
  - **No RPC, table or payload shape changed.**

## 3. Impacted Files

**Teacher web (`v2/web/`)**
- `src/lib/env.ts` *(new)*: all env resolution — Supabase URL + both key schemes, AI
  model/provider, student-app base, extractor endpoint + internal secret.
- `src/lib/ai.ts` *(new)*: `buildModelOptions()` + the `CUSTOM_MODEL` sentinel; the
  provider-gated preset shortlist and the env-driven default label.
- `src/lib/supabase/client.ts`, `server.ts`, `session.ts`: now call the shared
  resolvers; hold zero `process.env` reads (asserted).
- `src/app/api/extract/route.ts`: endpoint + secret via `lib/env.ts`.
- `src/components/UploadZone.tsx`: model dropdown built from `buildModelOptions()`;
  the hardcoded `MODEL_OPTIONS` array is deleted.
- `src/components/ExamShareModal.tsx`, `src/components/tree/TreeProjector.tsx`: both
  deep-link builders use `resolveStudentAppBaseUrl()`.
- `src/lib/extractor.ts`: doc comment retargeted to `AI_MODEL_NAME`.
- `.env.example`: rewritten as a fully-commented template — every variable states
  which side reads it (browser vs server), both key schemes, and the
  `NEXT_PUBLIC_`-inlining rule.

**Student SPA (`v2/student/`)**
- `app-config.js` *(new)*: `stripTrailingSlashes`, `resolveSupabaseConfig`,
  `resolveWorkerBaseUrl`.
- `config.example.js` *(new)*: the documented template, with a security note.
- `config.js`: **untracked** (`git rm --cached`) and added to `.gitignore`. Values
  kept for local use. A committed copy would point every other operator's students at
  this deployment's project.
- `app.js`: reads only `window.__APP_CONFIG__`; the `resolveWorkerBaseUrl()` body with
  its `localhost:8787` and `*.workers.dev` fallbacks is gone; `initSupabase()` uses
  `resolveSupabaseConfig`.
- `verify.html`: same resolver, so the certificate page cannot drift from the SPA.
- `index.html`: comment marking the `config.js` load point.

**Cloudflare Worker (`v2/worker/`)**
- `src/index.ts`: `Env` gains `AI_MODEL_NAME` + `ALLOWED_ORIGINS`; `envDefaultModel()`
  walks a 3-name priority chain; new `corsOptions(env)`; CORS middleware is
  binding-driven.
- `src/ai/ai-engine.ts`: `DEFAULT_MODEL` documented as the last-resort floor.
- `wrangler.toml`: `[vars]` now declares `AI_MODEL_NAME` and `ALLOWED_ORIGINS` with
  rationale for the `*` default.
- `.dev.vars.example` *(new)*: documents the local secret set.
- `.gitignore`: ignores `.dev.vars.*` but allows `!.dev.vars.example`.
- `README.md`: variable table now distinguishes secret vs `[vars]`.

**Docs / tests**
- `DEPLOYMENT.md`: §2.1 `[vars]` table; §3.2 env table with aliases and
  `NEXT_PUBLIC_STUDENT_APP_URL`; §4.1 rewritten for the untracked `config.js`.
- `ARCHITECTURE_FREEZE.md`: Engine 2 model-resolution paragraph.
- `tests/e2e_flow_verification.mjs`: **Step 39** (76 assertions) plus a **Step 32e**
  repair (below).

## 4. Verification & Testing

- **Test Commands Executed:**
  - `node --check student/app.js` → exit 0
  - `node --check student/app-config.js` → exit 0
  - `node --check tests/e2e_flow_verification.mjs` → exit 0
  - `npm run build` in `v2/web` → compiled successfully, TypeScript clean, 5/5 static pages
  - `npm run build` in `v2/worker` (`tsc --noEmit`) → exit 0
  - `node tests/e2e_flow_verification.mjs` → **758 passed, 0 failed**
  - `git check-ignore -v student/config.js` → matched by `student/.gitignore:8`
- **Results:** Baseline was 687; **+71 net** assertions, all green. Step 39 executes
  rather than inspects where it can:
  - 39e/39f/39g/39h import and drive the real `app-config.js` and `lib/env.ts`,
    including both key schemes, the "modern wins over legacy" precedence, the
    blank-value fall-through, and each throw-on-missing path.
  - 39k drives the real Hono app in-process: CORS headers for wildcard /
    allow-list / blank bindings, and `meta.model_used` proving the Worker consumes
    `AI_MODEL_NAME` (plus the legacy alias and the `?model=` override).
  - The suite snapshots and restores every env var it touches.
- **Regression caught and fixed during this phase:** Step 32e asserted the literal
  `function resolveWorkerBaseUrl(` existed in `app.js`. Phase 9 legitimately moved the
  resolver into `app-config.js`, so the assertion failed (**757 passed, 1 failed**).
  It was **repointed at the behaviour** (the SPA imports the shared module, calls
  `workerBaseUrl()`, and still builds the absolute `/api/v1/extract-practice` path)
  rather than at the now-moved declaration. Re-run: 758/0.
- **One deliberate deviation from the task spec:** the spec's
  `resolveSupabaseConfig`-style snippet for the SPA exposed `supabaseKey`; the shipped
  name is `supabasePublishableKey` (with `supabaseAnonKey` accepted) so the field says
  which key scheme it wants. The spec's `CreateExamInput`/`UpdateExamInput` analogues
  in Phase 8.7 were likewise already named differently.
- **Rollback Strategy:**
  1. `git revert <this commit>` restores the previous wiring in one step.
  2. For the SPA only: `git checkout <prev> -- student/config.js` re-tracks the file
     and removes it from `.gitignore`.
  3. For the Worker only: set `DEFAULT_AI_MODEL` (instead of `AI_MODEL_NAME`) and
     `ALLOWED_ORIGINS = "*"` — both legacy names are still honoured, so reverting the
     code is optional.
  4. No database or data migration is involved, so no data repair is required.
