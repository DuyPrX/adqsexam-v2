# Change Report: Class Roster Management & Flexible PIN Authentication (Phase 6.1)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Add independent class roster management (`classes`,
  `class_members`) so a teacher maintains a class once and imports it into any
  number of exams, and add a per-exam PIN policy with three modes — `NONE`,
  `GLOBAL`, `INDIVIDUAL` (with a DDMM date-of-birth fallback).
- **Motivation:** Rosters previously existed only per-exam (`students`), so the
  same class had to be re-entered for every exam, and the only admission control
  was the (student_code, full_name, class_name) triple — all three of which a
  classmate can know. A PIN (or DOB) adds an actual secret, while `NONE` keeps an
  open sitting possible.

## 2. Technical Implementation Details

### Architecture / Core Logic

- **Class rosters live outside any exam.** `classes` (owner-scoped, unique on
  `user_id` + `name`) and `class_members` (unique on `class_id` + `student_code`)
  mirror the existing tenant model: RLS restricts a teacher to their own rows,
  membership scoped through the parent class. `import_class_to_exam()` copies a
  roster into an exam's `students` whitelist and **refreshes** on conflict, so a
  corrected class roster can simply be re-imported.
- **PIN gate is step 3.b of `verify_and_acquire_session`** — after identity
  verification, before the duplicate-submission probe. A wrong PIN therefore
  touches neither the session lock nor `exam_results`.
  - `NONE` → skipped.
  - `GLOBAL` → compares against `exams.global_pin`.
  - `INDIVIDUAL` → `students.pin` if set, else `to_char(students.dob,'DDMM')`,
    else no PIN required.
- **The comparison is null-safe and fails closed.** It uses
  `is distinct from` rather than `=`; with plain `=` an unset `global_pin`
  compares NULL and the enclosing `IF` falls through, silently admitting every
  candidate.
- **The old 6-argument function is DROPPED.** `create or replace` matches on the
  signature, so merely adding `p_pin` would have left the PIN-less overload in
  place as a complete bypass (and produced an "is not unique" ambiguity). This
  was proven locally before writing the DDL.

### Database Migrations

`supabase/migrations/20261005100000_classes_and_pin_auth.sql` — idempotent
(`create table/… if not exists`, `drop … if exists`, `create or replace`),
wrapped in a single transaction. Mirrored into `supabase/schema.sql` as §A.1
(pin columns), §A.3 (students dob/pin), §A.7/A.8 (new tables), §A.7 indexes, §B
(RLS), §C.1 (RPC v2), §C.14 (new RPC) and §D (grants).

- `classes`, `class_members` + indexes; `revoke all … from anon`.
- `exams.pin_mode varchar(20) not null default 'INDIVIDUAL'`,
  `exams.global_pin varchar(50)`, `chk_pin_mode` CHECK (drop-then-add for
  idempotency).
- `students.dob date`, `students.pin varchar(50)`.
- RLS policies `classes_owner_all`, `class_members_owner_all`.
- `import_class_to_exam(varchar, uuid[]) returns integer`, SECURITY DEFINER,
  `RAISE EXCEPTION 'UNAUTHORIZED_OR_EXAM_NOT_FOUND'`.
- `verify_and_acquire_session(…, p_pin varchar default null)` with the PIN gate.

### API Contracts

- `verify_and_acquire_session` gains a trailing optional `p_pin`; all existing
  callers keep working because PostgREST resolves the 7-arg function via its
  defaults. New failure shape: `{ success: false, code: 'INVALID_PIN', message:
  'Mã PIN hoặc ngày sinh (DDMM) không chính xác.' }`.
- New: `import_class_to_exam(p_exam_code varchar, p_class_ids uuid[]) → integer`
  (raises on unauthorized/unknown exam) — teacher-only.
- `EXAM_COLUMNS` was **not** changed: `pin_mode` / `global_pin` are not yet needed
  by the teacher web (no UI in this phase). Mirrored columns are additive.

## 3. Impacted Files

- `supabase/migrations/20261005100000_classes_and_pin_auth.sql`: **New** — full Phase 6.1 DDL + RPCs + grants.
- `supabase/schema.sql`: Mirrored §A.1, §A.3, §A.7/A.8, §A.7 indexes, §B RLS (+ anon revokes), §C.1 rewrite (with the DROP), §C.14, §D grants.
- `tests/e2e_flow_verification.mjs`: Step 25 (34 assertions) + constants + teardown.

## 4. Verification & Testing

- **Test Commands Executed:**
  - `Get-Content -Raw <migration> | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1` (apply, then re-apply for idempotency)
  - `Get-Content -Raw supabase/schema.sql | docker exec -i … psql … -v ON_ERROR_STOP=1` (full-script apply)
  - `node v2/tests/e2e_flow_verification.mjs`
- **Results:**
  - Migration applies cleanly; a second run is a pure no-op (`… already exists,
    skipping` ×9, then `COMMIT`).
  - `schema.sql` applies end-to-end with **zero errors** (exit 0).
  - Post-state verified by direct SQL: exactly **one** 7-arg
    `verify_and_acquire_session`; `anon` cannot execute `import_class_to_exam`
    (`f`) while `authenticated` can (`t`); `anon` has no SELECT on the new tables;
    RLS enabled with one policy each; `to_char('2008-09-05','DDMM') = '0509'`.
  - e2e: **266 passed, 0 failed** (was 232; +34 in Step 25). Step 25 covers:
    - class + member CRUD, including a member with neither PIN nor DOB, and the
      `(class_id, student_code)` uniqueness guard;
    - `import_class_to_exam` inserting 3 roster rows with class name / dob / pin,
      re-import refreshing without duplication, and refusing trashed + unknown exams;
    - the full PIN matrix — INDIVIDUAL custom PIN (accept/reject + `code` +
      Vietnamese message), INDIVIDUAL DDMM fallback (`0509`), custom PIN winning
      over DOB, INDIVIDUAL with no secret passing, GLOBAL (reject/accept, and an
      individual PIN *not* satisfying a shared policy), GLOBAL fail-closed when
      `global_pin` is unset, NONE accepting empty and arbitrary values;
    - `chk_pin_mode` rejecting an invalid mode;
    - the regression guard that omitting `p_pin` does **not** bypass the policy.
  - Regression: Steps 1–24 all still pass — the default `INDIVIDUAL` mode plus
    the "both NULL → pass" rule leaves every prior flow untouched.
- **Rollback Strategy:** `drop function if exists
  public.import_class_to_exam(varchar, uuid[]);`, recreate the 6-arg
  `verify_and_acquire_session`, and drop the added columns/tables
  (`classes`, `class_members` cascade; `exams.pin_mode`, `exams.global_pin`,
  `students.dob`, `students.pin`). Reverting `verify_and_acquire_session` requires
  restoring the previous body from git, since the file is `create or replace`.
