# Change Report: Exam Candidates, Share/QR Modal, Clean Student Code & SPA View Isolation (Phase 8.1)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Three teacher/student ergonomics gaps closed together:
  1. Teachers can now manage an exam's candidate roster directly in the editor
     (list / search / edit / add / delete) instead of only importing whole classes.
  2. Teachers can share an exam with students via a first-class modal showing the
     exam code, the direct student link, and a rendered QR code.
  3. The student SPA lost every visible "student code" input — identity is now
     strictly **Class + Full Name (+ PIN)** — and gained a dedicated full-viewport
     Tree view that no longer nests inside the exam shell.
- **Root Cause / Motivation:**
  - The candidate whitelist (`public.students`) was previously writable only
    through `import_class_to_exam`; ad-hoc additions/edits required SQL.
  - There was no in-app way to hand a student the join link/QR.
  - Students had to know and type an opaque `student_code`, which was both a UX
    obstacle and inconsistent with the roster picker that already resolved
    identity by class + name.
  - `#treeScreen` was rendered *inside* the exam shell, so the header/tabs/forms
    remained visible behind the Tree of Knowledge, and the `.docx` personal-practice
    upload targeted a relative `/api/...` path that Cloudflare Pages (a static
    assets host) cannot serve — resulting in HTTP 405.

## 2. Technical Implementation Details

### Database Migrations
`supabase/migrations/20261005140000_practice_roster_and_flexible_auth.sql`
(mirrored into `supabase/schema.sql`).

**The overload hazard.** `create or replace function` matches on the **argument
signature**. Adding a parameter therefore does *not* replace the old function — it
creates a second overload, and any call matching both then fails with *"function is
not unique"*. Every function whose signature changed is preceded by an explicit
`drop function if exists <old signature>`:

1. `get_exam_roster(p_exam_code varchar, p_for_practice boolean default false)`
   — adds practice mode. With `p_for_practice = true` the ONLY gate is
   `allow_practice`; the open/close switch and schedule are deliberately ignored,
   which is the entire point (self-study on a closed exam). Trashed exams remain
   invisible in both modes; the payload now also carries `allow_practice`.
2. `get_practice_exam_payload(p_exam_code, p_student_code default null,
   p_class_name default null, p_full_name default null)` — authorises by
   `student_code` OR by `(full_name, class_name)`, both case/whitespace
   insensitive. Returns `student_name` from the matched roster row.
3. `verify_student_practice(p_class_name, p_full_name, p_student_code default null)`
   — **not in the original task list, but required for coherence**: the personal
   `.docx` path has no exam code, so with the code input gone it can only supply
   class + name; leaving it code-only would have silently broken that feature.

Two correctness fixes applied to the supplied draft bodies:
- The practice question CTE joins on `q.exam_id = v_exam.id` — `question_bank` has
  **no `exam_code` column**.
- `FOUND` is unreliable inside `if/elsif` when no branch runs (it retains the prior
  statement's value), so the whitelist check uses an explicit
  `v_matched boolean := false` + `v_matched := found`.

All three stay `SECURITY DEFINER` with a pinned `search_path`; none ever returns
`pin` or `dob`.

### API Contracts (teacher web)
`web/src/lib/candidates.ts` (new):
- `listExamCandidates(supabase, examCode)` — ordered by class then code.
- `addExamCandidate(supabase, examCode, candidate)` — derives a `${class}_NN` code
  when omitted (collision-checked) and maps PG `23505` to a friendly Vietnamese
  message.
- `updateExamCandidate(supabase, id, updates)` — presence-checked with
  `!== undefined`, so an explicit `null` clears `dob`/`pin`.
- `deleteExamCandidate(supabase, id)` — refuses when an `exam_results` row exists
  for `(exam_code, student_code)`.

### Student SPA
- **View router:** top-level `switchView(viewName)` toggles `#view-exam` /
  `#view-tree` via inline `display`; `#view-tree` is `100vw / min-height:100vh` so
  it owns the viewport instead of nesting in the shell. `loadTreeActivity()` calls
  `switchView('tree')` first.
- **Identity:** `#student-code-input` and `#practiceStudentCode` removed;
  `readIdentity()`'s manual branch now matches the typed `(class, name)`
  case-insensitively against the already-fetched roster and returns the roster
  row's `student_code`, so `verify_and_acquire_session` (still code-based) keeps
  working. Practice fields are text inputs + `<datalist>` (not `<select>`s —
  the `.docx` path has no roster to populate a dropdown from).
- **Static-host fix:** `resolveWorkerBaseUrl()` addresses the Worker absolutely
  (`window.WORKER_API_URL` → `APP_CONFIG.practiceApiUrl` with the known path
  stripped → `http://localhost:8787` on localhost → `''`), because Cloudflare Pages
  cannot serve a relative `/api/...` route.

### Teacher web UI
- `ExamCandidatesManager.tsx` — searchable table + add/edit modal, mounted as a
  second tab in `ExamEditor`.
- `ExamShareModal.tsx` — exam code, direct student link
  (`${STUDENT_APP_URL}/?code=...`), copy buttons, rendered QR (`qrcode`, 1024px,
  EC level M) and `Tải ảnh mã QR (.PNG)`; wired into `ExamList` (row button) and
  `ExamEditor` (action bar).

## 3. Impacted Files
- `supabase/migrations/20261005140000_practice_roster_and_flexible_auth.sql`: three re-signatured RPCs.
- `supabase/schema.sql`: §C.7, §C.13, §C.15/C.16 mirror + §D revoke/grant updates.
- `web/src/lib/candidates.ts`: candidate CRUD helpers (new).
- `web/src/lib/types.ts`: `ExamCandidateRow`.
- `web/src/components/questions/ExamCandidatesManager.tsx`: candidate table + form (new).
- `web/src/components/ExamShareModal.tsx`: share/QR modal (new).
- `web/src/components/ExamList.tsx`: `Chia sẻ / QR` row action + modal mount.
- `web/src/components/questions/ExamEditor.tsx`: candidates tab + share button.
- `student/index.html`: `#view-exam`/`#view-tree` split; code inputs removed.
- `student/styles.css`: `.spa-view` + `#view-tree` viewport rules.
- `student/app.js`: `switchView`, worker URL resolution, roster-based identity,
  practice datalists.
- `tests/e2e_flow_verification.mjs`: Step 11 updated to the new signature; Step 32 added.

## 4. Verification & Testing
- **Migration idempotency:**
  `Get-Content -Raw -Encoding UTF8 <migration> | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1`
  applied **twice**, exit 0 both runs, `NOTICE: function … does not exist, skipping`
  on the re-run. `pg_proc` shows exactly ONE signature per function with
  `has_function_privilege('anon', oid, 'execute') = t`.
- **Builds:** `npm run build` in `v2/web` → exit 0, `/tree/[id]` registered.
  `node --check v2/student/app.js` → exit 0.
- **e2e:** `node v2/tests/e2e_flow_verification.mjs` → **502 passed, 0 failed**
  (baseline 458; **+44**). Step 32 contributes 43 assertions covering 32a signature
  discipline, 32b closed-exam practice roster, 32c flexible identity, 32d candidate
  CRUD (including the `exam_results` delete guard, which confirms the `id`-column
  assumption), and 32e the shipped SPA's markup/router/worker-URL invariants.
- **Rollback Strategy:** `git revert` the phase commit. The three `drop function`
  statements are idempotent, so re-applying the prior `schema.sql` restores the
  previous signatures. No table data is migrated or destroyed.
