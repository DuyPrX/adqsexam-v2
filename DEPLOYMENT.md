# ADQS Exam v2 — Deployment Runbook

Production deployment for the four components of the serverless v2 stack.

| Component | Path | Target | Runtime |
|---|---|---|---|
| Database, Auth, API | `v2/supabase/` | Supabase (managed Postgres) | PostgreSQL 17 |
| DOCX extractor | `v2/worker/` | Cloudflare Workers | V8 isolates |
| Teacher dashboard | `v2/web/` | Vercel | Next.js 16 (Node) |
| Student exam app | `v2/student/` | Cloudflare Pages | Static SPA |

**Architecture contract:** `v2/ARCHITECTURE_FREEZE.md` (F1–F5, D1–D4).
**Deployment order matters** — each step consumes the previous step's output:

```
1. Supabase ──► (URL + publishable key)
2. Worker   ──► (worker URL)
3. Teacher Web  (needs 1 + 2)
4. Student SPA  (needs 1)
```

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20+ (24 tested) | `node --version` |
| Supabase CLI | 2.x | `npx supabase --version` |
| Wrangler | 4.x | `npx wrangler --version` |
| Docker Desktop | running | only for local verification |

Accounts: [Supabase](https://supabase.com), [Cloudflare](https://dash.cloudflare.com), [Vercel](https://vercel.com), and a [Google AI Studio](https://aistudio.google.com/apikey) key (Engine 2 only).

---

## 1. Supabase (remote)

### 1.1 Create the project

Create a project at **Supabase Dashboard → New project**. Note the **project ref**,
the **Project URL**, the **publishable key**, and the **secret key**
(Settings → API Keys).

> Supabase now issues `sb_publishable_…` / `sb_secret_…` keys instead of the legacy
> `anon` / `service_role` JWTs. The v2 clients accept both —
> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is preferred, with
> `NEXT_PUBLIC_SUPABASE_ANON_KEY` as a fallback.

### 1.2 Apply the schema

**Option A — CLI (recommended, versioned):**

```bash
cd v2
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

`db push` applies every file in `supabase/migrations/` in timestamp order:

| Migration | Contents |
|---|---|
| `20261001183541_phase1_schema.sql` | 6 tables, RLS, 5 SECURITY DEFINER RPCs |
| `20261002120000_phase5_realtime_publication.sql` | Realtime publication + replica identity |

**Option B — SQL Editor (manual):**

Dashboard → **SQL Editor** → paste the **entire** `v2/supabase/schema.sql` → **Run**.

The script is idempotent (`create or replace` / `drop policy if exists` /
guarded publication adds), so re-running it is safe. It wraps everything in a
single transaction (`begin; … commit;`) — if anything fails, nothing is applied.

### 1.3 Enable Realtime replication

> **Do not skip this step.** Supabase creates the `supabase_realtime` publication
> **empty**. A table that is not a member emits **no** `postgres_changes` events,
> even when Realtime is enabled. Without it the teacher live monitor stays blank
> forever — with no error anywhere.

Both migrations above already do this. Verify, or apply manually:

```sql
-- Verify (expect 2 rows)
SELECT schemaname, tablename
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime';

-- Apply if missing
ALTER PUBLICATION supabase_realtime ADD TABLE active_sessions, exam_results;

-- Required: exam_results is keyed on `id`, so a filter on the non-key column
-- `exam_code` cannot match an UPDATE/DELETE WAL record under the default
-- replica identity. Without this, realtime filters silently drop events.
ALTER TABLE exam_results REPLICA IDENTITY FULL;
```

`active_sessions` needs no replica-identity change: `exam_code` is part of its
composite primary key.

> Re-running `ALTER PUBLICATION … ADD TABLE` raises `42710 (duplicate_object)`.
> That means it is already configured — safe to ignore.

### 1.4 Create a teacher account

Student access needs no account (RPC-only). The dashboard requires one teacher:

```bash
curl -X POST 'https://<project-ref>.supabase.co/auth/v1/signup' \
  -H "apikey: <publishable-key>" \
  -H 'Content-Type: application/json' \
  -d '{"email":"teacher@your-school.edu.vn","password":"<strong-password>"}'
```

Or Dashboard → **Authentication → Users → Add user** (tick *Auto Confirm User*).

---

## 2. Cloudflare Worker — DOCX extractor

```bash
cd v2/worker
npm install
```

### 2.1 Configure secrets

```bash
npx wrangler secret put GEMINI_API_KEY    # Engine 2 (AI). Required for mode=ai/auto fallback.
npx wrangler secret put INTERNAL_SECRET   # Shared secret for the X-Internal-Secret header.
```

Non-secret defaults live in `wrangler.toml` `[vars]` — edit and redeploy, no
`secret put` needed:

| `[vars]` key | Default | Purpose |
|---|---|---|
| `AI_MODEL_NAME` | `gemini-3.5-flash-lite` | Engine 2's default model. A caller's `?model=` overrides it |
| `ALLOWED_ORIGINS` | `*` | Browser origins allowed to call the Worker; a comma-separated allow-list narrows it |

For local runs `Copy-Item .dev.vars.example .dev.vars` — see
[worker/README.md](worker/README.md).

Generate a strong shared secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`INTERNAL_SECRET` is **server-to-server only** — it must match
`EXTRACTOR_INTERNAL_SECRET` in Vercel (§3.2) and must never carry a
`NEXT_PUBLIC_` prefix. It never reaches a browser: the teacher app proxies
through `/api/extract` ([route.ts](web/src/app/api/extract/route.ts)).

> If `INTERNAL_SECRET` is unset, the Worker **bypasses** the header check. Never
> deploy to production without it.

### 2.2 Deploy

```bash
npm run build          # tsc --noEmit
npx wrangler deploy
```

Note the deployed URL (`https://docx-extractor-v2.<account>.workers.dev`) — it
becomes `NEXT_PUBLIC_EXTRACTOR_API_URL` in §3.

### 2.3 Smoke test

```bash
curl -X POST 'https://docx-extractor-v2.<account>.workers.dev/api/v1/extract?mode=rule' \
  -H "X-Internal-Secret: <your-secret>" \
  -F 'file=@sample.docx'
```

Expect `{"success":true,"engine_used":"rule","count":N,"data":[…],"meta":{…}}`.
A `401` means the secret does not match.

---

## 3. Teacher Web — Vercel

### 3.1 Import the project

Vercel → **Add New → Project** → select the repo → **Root Directory: `v2/web`**.

`vercel.json` is not needed; Vercel auto-detects Next.js.

### 3.2 Environment variables

Project → **Settings → Environment Variables** (Production + Preview).
[web/.env.example](web/.env.example) is the canonical, fully-commented list —
this table is the short version:

| Variable | Value | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | no |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (alias: `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | no |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (alias: `SUPABASE_SERVICE_ROLE_KEY`) | **yes** |
| `NEXT_PUBLIC_EXTRACTOR_API_URL` | `https://docx-extractor-v2.<account>.workers.dev/api/v1/extract` | no |
| `EXTRACTOR_INTERNAL_SECRET` | same value as the Worker's `INTERNAL_SECRET` | **yes** |
| `NEXT_PUBLIC_AI_MODEL_NAME` | e.g. `gemini-3.5-flash-lite` — label/default for the AI model picker | no |
| `NEXT_PUBLIC_AI_PROVIDER` | `gemini` (default) | no |
| `NEXT_PUBLIC_STUDENT_APP_URL` | `https://adqs-exam-student.pages.dev` — **required in production** | no |

Rules:

- `NEXT_PUBLIC_*` is inlined into the browser bundle — public values only.
- `SUPABASE_SECRET_KEY` and `EXTRACTOR_INTERNAL_SECRET` have no `NEXT_PUBLIC_`
  prefix, so they stay server-side.
- Set variables **before** the first build; `NEXT_PUBLIC_*` is baked in at build
  time, so changing them requires a redeploy.
- Both Supabase key schemes are accepted. `lib/env.ts` resolves the modern name
  first and falls back to the legacy one, so paste whichever your dashboard
  shows.
- Omitting `NEXT_PUBLIC_STUDENT_APP_URL` makes every student join link and QR
  code point at the teacher app, where the student views do not exist.

### 3.3 Deploy

```bash
cd v2/web
npm install
npm run build     # must exit 0
```

Then push to the connected branch, or use `vercel --prod`.

### 3.4 Verify

Open the deployment → `/login` → sign in with the §1.4 teacher.
Confirm `/` lists exams and the browser console shows **no** Realtime errors.

---

## 4. Student SPA — Cloudflare Pages

The SPA is plain static assets (no build step).

### 4.1 Point it at Supabase

The SPA has **no committed configuration**. Create it from the template:

```bash
cd v2/student
cp config.example.js config.js     # Windows: Copy-Item config.example.js config.js
```

Then edit `config.js`:

```js
window.__APP_CONFIG__ = {
  supabaseUrl: 'https://<project-ref>.supabase.co',
  supabasePublishableKey: 'sb_publishable_…',
  // Optional: base origin of the Worker, for the personal-.docx practice mode.
  workerApiUrl: 'https://docx-extractor-v2.<account>.workers.dev',
};
```

`config.js` is **git-ignored**: it names one specific project, and a committed
copy would point every other operator's students at it. It must exist in the
deployed asset directory, so create it on the build machine (or add a CI step
that writes it from a platform secret).

Nothing in `config.js` is a secret — see the security note in the template.

`Verify with`: open the deployed site with `config.js` missing → the SPA shows
**"Chưa cấu hình Supabase"** rather than failing obscurely. That is the expected
behaviour, not a bug.

### 4.2 Deploy via Wrangler (direct)

```bash
cd v2/student
npx wrangler pages deploy . --project-name adqs-exam-student
```

### 4.3 Deploy via Git (recommended for CI)

Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

| Setting | Value |
|---|---|
| Root directory | `v2/student` |
| Build command | *(leave empty)* |
| Build output directory | `.` |

> Never expose `SUPABASE_SECRET_KEY` or `INTERNAL_SECRET` to this app — a static
> SPA cannot keep secrets.

### 4.4 Verify

Open the Pages URL, then sign in with a whitelisted candidate
(exam code + student code + full name + class must match the roster exactly).
Use a **real exam code** created in the teacher dashboard.

---

## 5. Local end-to-end verification

Runs the full pipeline against a local stack — no cloud resources needed.

```bash
cd v2
npx supabase start                     # first run pulls ~2 GB of images
node tests/e2e_flow_verification.mjs   # 33 assertions
```

Expected tail:

```
RESULT: 33 passed, 0 failed
```

The script covers: teacher authoring → roster seed → student login → **zero
answer-leak assertions** → heartbeats with telemetry → submission with
server-side scoring → teacher query + **Realtime INSERT/DELETE delivery** →
post-submit guards. Exit code 0 = all passed.

Useful during development:

```bash
npx supabase status          # URLs and keys
npx supabase db reset        # re-apply migrations from scratch
npx supabase stop --no-backup
```

---

## 6. Post-deployment checklist

All items below are confirmed complete. Items 1–2 were re-verified directly
against the live database (`pg_publication_tables` lists both tables;
`pg_class.relreplident = 'f'` for `exam_results`); the remainder were confirmed
during the production rollout.

- [x] `pg_publication_tables` lists **both** `active_sessions` and `exam_results`
- [x] `exam_results` replica identity is `full`
- [x] Worker secrets set (`GEMINI_API_KEY`, `INTERNAL_SECRET`) — no production bypass
- [x] Vercel env vars set on **Production and Preview**; build exits 0
- [x] Teacher can log in and sees the **“Trực tiếp”** badge on a results page
- [x] Student login works with a real exam code; a second device is rejected
      (`SESSION_ACTIVE_ELSEWHERE`)
- [x] Submitting updates the teacher scoreboard **without a page reload**
- [x] A tab switch during an exam increments the live “Rời tab” counter

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Live monitor never updates, no errors | Tables missing from `supabase_realtime` | §1.3 — add both tables |
| Realtime INSERT works, UPDATE/DELETE does not | `exam_results` replica identity is `default` | `ALTER TABLE exam_results REPLICA IDENTITY FULL;` |
| `401` from the extractor | `INTERNAL_SECRET` ≠ `EXTRACTOR_INTERNAL_SECRET` | Re-set both to the same value |
| Extract fails only for AI mode | `GEMINI_API_KEY` missing/invalid | `npx wrangler secret put GEMINI_API_KEY` |
| Every save with an essay fails (`23502`) | `correct_answer` is `NOT NULL` (pre-Phase-3 schema) | Re-apply `schema.sql`; the column must be nullable |
| `23502` … actually `42710` on migration replay | Publication already configured | Ignore — expected, guarded |
| Teacher sees another tenant's exams | RLS not applied | Re-run `schema.sql`; verify `exams_owner_all` exists |
| Student login says `STUDENT_NOT_WHITELISTED` | Not in `students` for that exam | Upload the roster in the dashboard |
| Env var change has no effect on Vercel | `NEXT_PUBLIC_*` is baked at build time | Redeploy |

---

## 8. Security invariant

Students reach the database **only** through SECURITY DEFINER RPCs and hold zero
table privileges ([schema.sql §B](supabase/schema.sql)):

```sql
REVOKE ALL ON public.exams, public.question_bank, public.students,
              public.active_sessions, public.exam_results,
              public.proctoring_snapshots
  FROM anon;
```

`get_student_exam_payload()` strips `correct_answer`, `explanation`, and every
sub-question key; scoring happens exclusively inside `submit_exam_result()`.
The student browser therefore cannot compute or discover any answer key — the
E2E script asserts this on every run (§5, step 5).
