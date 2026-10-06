# Change Report: Exam Shuffle Toggle & TRUE_FALSE-at-the-End Partitioning (Phase 8.7)

- **Date:** 2026-10-06
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Two related controls over the ORDER a student sees questions in:
  (1) a per-exam `shuffle_questions` toggle the teacher owns, honoured by both the
  official sitting and self-practice; (2) when shuffling IS on, every TRUE_FALSE
  question is grouped and placed strictly at the END of the paper.
- **Root Cause / Motivation:**
  - **No way to say "keep my order".** The official sitting ALWAYS shuffled
    client-side (Phase 5.8). That is wrong for a paper whose numbering carries
    meaning — a sequenced derivation, or a passage a question refers back to as
    "the text above". The teacher had no switch to turn it off.
  - **TRUE_FALSE blocks scattered through the MCQ run.** A TRUE_FALSE item is a
    block of four sub-statements that needs more room and more reading time than
    one MCQ. Interleaving them breaks the student's rhythm and makes the paper
    longer in practice than it needs to be.
  - **A latent data-loss bug on the write path.** `saveExam` and
    `saveExamVariants` selected an explicit `EXAM_COLUMNS` list; any column added
    server-side but not added to that list stays `undefined` at runtime while
    TypeScript still believes it is present. The new column had to be threaded
    through the constant, not just the table.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Schema.** `exams.shuffle_questions BOOLEAN NOT NULL DEFAULT true`. The
    `NOT NULL DEFAULT` is load-bearing: it backfills existing rows in a single
    pass (no window in which a row reads NULL) and preserves the behaviour every
    exam shipped with. The client treats only an explicit `false` as "do not
    shuffle", so even a hypothetical NULL would fail safe (shuffle).
  - **Three RPCs expose the flag.** `get_exam_roster` (picker), and — critically —
    **`get_student_exam_payload`**, which is the ONLY source of `state.exam` for
    an official sitting: without it the SPA physically cannot honour the toggle.
    `get_practice_exam_payload` exposes it as context.
  - **Partitioned shuffle, one implementation per runtime.**
    - Teacher web: `shufflePartitioned()` in `shuffle.ts`; `shuffleQuestions()`
      and `generateExamVariants()` both route through it.
    - Student SPA: `partitionAndShuffleOrder()` builds the *index permutation*
      (so the official sitting can hand it to `state.displayOrder` and re-map
      answers onto the authored `position ASC` the server grades against) and
      `partitionAndShuffleQuestions()` wraps it for the array-reordering paths.
  - **Independent partition shuffling, not stable partition.** Both runtimes
    shuffle the two partitions SEPARATELY. A "shuffle then stable partition" would
    preserve the authored order *inside* the TRUE_FALSE block, leaking it — the
    Step 38g assertion exists specifically to catch that regression.
  - **The toggle is honoured, not merely stored.** `applyDisplayShuffle()` returns
    early (leaving `displayOrder` null, an identity mapping) when
    `exam.shuffle_questions === false`; the server already returned `position ASC`.
- **Database Migrations:** `supabase/migrations/20261006020000_exam_shuffle_toggle.sql`
  — `alter table … add column if not exists` plus `drop function if exists` +
  `create or replace` for the three RPCs (the drop discards the ACL, so each
  revoke/grant pair is restated). Mirrored in `schema.sql` (§ table definition,
  § idempotency block, § C.3 / § C.13 / § C.15).
- **API Contracts:** three read RPCs gained one key each; **no signature changed**
  and **no question-data projection was altered** (the sanitisation contract on
  `get_student_exam_payload` — no `correct_answer`, no `explanation`, no
  sub-question keys — is untouched and re-asserted in Step 38e).

## 3. Impacted Files
- `v2/supabase/migrations/20261006020000_exam_shuffle_toggle.sql` (**new**): the column + the three RPC bodies.
- `v2/supabase/schema.sql`: mirrored the column, the idempotency `alter`, and the three RPC returns.
- `v2/web/src/lib/types.ts`: `ExamRow.shuffle_questions`.
- `v2/web/src/lib/exams.ts`: `EXAM_COLUMNS` + `SaveExamInput` / `SaveExamVariantsInput` / `ExamMetadataPatch` + all three write paths.
- `v2/web/src/lib/shuffle.ts`: `shufflePartitioned()`; `shuffleQuestions()` and `generateExamVariants()` now partition.
- `v2/web/src/components/questions/ExamPreviewEditor.tsx`: toggle (default ON) forwarded to both save paths.
- `v2/web/src/components/questions/ExamEditor.tsx`: toggle seeded from the row and persisted via `updateExamMetadata`.
- `v2/student/practice-order.js`: `partitionAndShuffleOrder()` + `partitionAndShuffleQuestions()`; superseded `orderPracticeQuestions()` retired.
- `v2/student/app.js`: `applyDisplayShuffle()` honours the flag; practice routes through the partitioner.
- `v2/tests/e2e_flow_verification.mjs`: Step 24 repointed at the shipped functions; **Step 38** added (33 assertions).

## 4. Verification & Testing
- **Test Commands Executed:**
  - Migration applied locally, then re-run to prove idempotency
    (`Get-Content -Raw … | docker exec -i supabase_db_v2 psql …`).
  - `node --check student/practice-order.js` / `student/app.js` / `tests/e2e_flow_verification.mjs` → all exit 0.
  - `cd web && npm run build` (Next.js 16.3.8 + TypeScript) → compiled, TypeScript clean.
  - `node tests/e2e_flow_verification.mjs`
- **Results:**
  - **687 passed, 0 failed** (baseline before this phase was 655; **+32 net**).
  - Step 38 covers: column list, `saveExam` default-ON, `updateExamMetadata`
    round-trip + partial-patch safety, the roster flag following the stored value
    (not hard-coded), both payload RPCs, `generateExamVariants` over 100 variant
    runs, and 60 executed runs of the SPA partitioner — asserting
    `min(TF index) > max(non-TF index)` in every single run, plus randomness of
    the partition (random shuffling is the failure mode most likely to be missed).
  - **A real regression was caught and fixed during this phase.** My first draft of
    the migration re-created `get_practice_exam_payload` and silently dropped
    `total_questions` and `student_name` from its return. Existing **Step 32c**
    failed (`it echoes the roster full name as student_name`) — the assertion did
    its job. The migration was corrected and a **Step 38e** guard added so a future
    rewrite of that function cannot drop a return field unnoticed.
  - The suite's `shuffle_question` DB-level checks run against local Supabase; the
    stack (`supabase_db_v2` et al.) was healthy at run time.
- **Rollback Strategy:** `git revert <commit>` reverses the code. The column is
  additive (`NOT NULL DEFAULT true`, so old clients that never send it keep
  working); to drop it, `alter table public.exams drop column shuffle_questions`
  and re-apply the pre-Phase-8.7 definitions of the three RPCs from `schema.sql`
  at the previous commit. No data migration or backfill is involved.
