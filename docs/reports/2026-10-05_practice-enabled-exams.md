# Change Report: Practice-Enabled Exams & Practice-by-Code Student Flow (Phase 5.8)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Let a teacher explicitly open an exam for self-practice, let a
  rostered student pull that exam's questions **with answer keys** by exam code,
  and give official exams a per-student client-side question shuffle whose
  answers are re-mapped to the original positions on submission.
- **Root Cause / Motivation:** Until now the architecture deliberately kept
  `question_bank.correct_answer` away from the student runtime (freeze F1/F3,
  D1). Self-practice therefore only worked by uploading a personal `.docx`.
  This change opens a **narrow, teacher-controlled** door through that wall and
  adds the missing dual-mode behaviour:
  - `allow_practice = false` (default) → nothing leaks; the exam behaves exactly
    as before.
  - `allow_practice = true` → a rostered student may fetch the key for practice.
  - Practice mode NEVER certifies, even at 100%.
  - Official exams now shuffle per candidate without breaking server grading.

## 2. Technical Implementation Details

### Architecture / Core Logic

- **Official-exam per-student shuffle (student SPA).** `state.questions` becomes
  the *display* array; `state.displayOrder` maps `displayIndex -> originalPosition`
  (Fisher-Yates). `buildAnswersPayload()` resolves each answer's `questionIndex`
  through that map before `submit_exam_result`. The server grades against
  `position ASC`, so the mapping is load-bearing: the e2e control case (a client
  that forgets to re-map) is asserted to score *below* full marks.
- **Practice mode is order-preserving and key-bearing.** `enterPractice()` forces
  `state.displayOrder = null` and never shuffles. `loadPracticeFromExamCode()`
  additionally sorts by `index` defensively.
- **Anti-cheat is fully disabled in practice.** `bindAntiCheat()` already
  no-ops when `state.mode === 'practice'` — no fullscreen lock, no blur tracking,
  no context-menu/copy/cut/paste/selection blocking. No change was needed there,
  which is why practice stays guard-free.
- **Certificate guard.** The gate was extracted into
  `checkAndShowCertificateOption(outcome)`, which returns early when
  `state.isPractice` (a flag that survives the `mode -> 'result'` flip) or
  `state.mode === 'practice'` or `outcome.practice === true`. Practice writes no
  Supabase row, so `resultId` is always null and no certificate is mintable.
- **Practice-by-code source toggle.** The "Tự ôn luyện" tab gained a segmented
  control ("Luyện tập theo Mã đề" vs "Tải file đề cá nhân (.docx)"). Both share
  the identity fields; only the question source differs.

### Database Migrations

`supabase/migrations/20261005000000_add_allow_practice_and_payload_rpc.sql`
(idempotent, mirrored into `supabase/schema.sql` as §A.1 column + §C.13 RPC +
§D grants):

- `ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS allow_practice boolean NOT NULL DEFAULT false;`
  The `NOT NULL DEFAULT false` is load-bearing: pre-existing exams must stay
  locked down rather than silently becoming practiceable.
- New `SECURITY DEFINER` RPC `get_practice_exam_payload(p_exam_code, p_student_code, p_class_name)`
  returning `{ success, exam, questions[] }` with questions in original
  `position ASC` order **including** `correct_answer` + `explanation`.
  Refusal codes: `PRACTICE_NOT_ALLOWED`, `STUDENT_NOT_WHITELISTED`,
  `PRACTICE_EMPTY`, `EXAM_NOT_FOUND`.
  - Deliberately **not** gated on `is_active`/scheduling (a teacher may close an
    exam for the sitting yet still want it practiceable); trashed exams **are**
    refused, consistent with Phase 5.5 ("Trash is invisible to students").
  - The caller must be **on that exam's roster**, so both code parameters are
    meaningful and guessing a 6-digit code cannot harvest keys.
- `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO anon, authenticated;`

### API Contracts

- No changes to existing RPC request/response shapes. One new RPC added (above).
- `EXAM_COLUMNS` gained `allow_practice`, so every `ExamRow` consumer now
  receives the flag (prevents the "undefined column" class of bug the constant
  exists to avoid).
- `saveExam` / `saveExamVariants` / `updateExamMetadata` gained an optional
  `allowPractice` field (defaults false), covering both creation paths and the
  edit route.

## 3. Impacted Files

- `supabase/migrations/20261005000000_add_allow_practice_and_payload_rpc.sql`: New migration — column, RPC, grants.
- `supabase/schema.sql`: Mirrored `allow_practice` (A.1) + C.13 RPC + Section D revoke/grant lines.
- `web/src/lib/types.ts`: `ExamRow.allow_practice`.
- `web/src/lib/exams.ts`: `EXAM_COLUMNS` + `allowPractice` on insert/save/update paths.
- `web/src/components/questions/ExamPreviewEditor.tsx`: "Cho phép dùng để luyện tập" checkbox, persisted on save.
- `web/src/components/questions/ExamEditor.tsx`: Practice opt-in toggle in general settings, included in the update payload.
- `web/src/components/ExamList.tsx`: Green `📚 Luyện tập` badge when enabled.
- `student/index.html`: Practice-source segmented control + `#practice-exam-code` input; `.docx` kept as the alternative.
- `student/app.js`: Fisher-Yates display shuffle + `displayOrder` re-map on submit; practice-by-code RPC flow; `checkAndShowCertificateOption` guard; practice order preservation.
- `tests/e2e_flow_verification.mjs`: Step 23 (30 new assertions).

## 4. Verification & Testing

- **Test Commands Executed:**
  - `Get-Content -Raw <migration> | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1` (applied + re-applied for idempotency)
  - `npm run build` in `v2/web/`
  - `node --check v2/student/app.js`
  - `node v2/tests/e2e_flow_verification.mjs`
- **Results:**
  - Migration applied cleanly (`BEGIN/ALTER TABLE/COMMENT/CREATE FUNCTION/REVOKE/GRANT/COMMIT`); a second run is a clean no-op.
  - Web build: TypeScript + static generation succeed.
  - `app.js`: syntax OK.
  - e2e: **208 passed, 0 failed** — including all Step 23 checks:
    - `allow_practice=false` → `PRACTICE_NOT_ALLOWED`, no questions leaked
    - off-roster caller rejected while closed **and** while enabled
    - unknown / trashed exam → `EXAM_NOT_FOUND`
    - `allow_practice=true` → success, exactly 3 questions in `[0,1,2]` order, keys + explanation present
    - practice writes no `exam_results` / `active_sessions` row and exposes no `result_id` to certify
    - shuffled submission with re-map → full score `3`
    - **control** without re-map → strictly below full score (proves the map matters)
  - Regression: Steps 1–22 all still pass (official payload still leaks no keys).
- **Rollback Strategy:** `DROP FUNCTION public.get_practice_exam_payload(varchar, varchar, varchar);`
  and `ALTER TABLE public.exams DROP COLUMN allow_practice;`, then revert the
  web/student/test commits. Dropping the column is safe because the flag is
  additive and every consumer treats it as optional/false-defaulted.
