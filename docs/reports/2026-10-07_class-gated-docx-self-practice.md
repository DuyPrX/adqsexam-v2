# Change Report: Class-Gated DOCX Self-Practice With Teacher Permission Toggle (Phase 8.9)

- **Date:** 2026-10-07
- **Scope:** Major Change
- **Author/Agent:** TraeCode agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Gate the student SPA's personal-`.docx` self-practice flow on the teacher's
  **class roster** rather than the exam whitelist, and give the teacher a per-class switch
  (`classes.allow_practice`) to suspend it. Provide a public pick-list so a student can choose a
  class that is guaranteed to pass verification.
- **Root Cause / Motivation:** `verify_student_practice` (the `.docx` path) previously matched
  against `public.students` — the per-exam whitelist. That coupling is wrong for a personal file:
  the whitelist is scoped to one exam, so a student could only self-practise if they happened to be
  rostered on *some* exam, and the teacher had no way to disable the flow for a whole class. The
  class roster (`classes` + `class_members`, Phase 6.1) is the correct authority, and it already
  carries the teacher relationship needed for an owner-controlled toggle.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - **New column `classes.allow_practice`** — `boolean not null default true`, plus a btree index.
    `add column ... not null default` backfills in a single pass, so no NULL window exists and an
    existing class can never be left without a permission.
  - **`verify_student_practice` re-pointed.** Resolves the class by normalized name, then:
    1. no class ⇒ `CLASS_NOT_FOUND`;
    2. `allow_practice = false` ⇒ `CLASS_PRACTICE_DISABLED`;
    3. no matching `class_members` row ⇒ `STUDENT_NOT_FOUND`;
    4. otherwise `success: true` with `class_name` / `full_name` / `student_code`.
  - **Signature deliberately unchanged** (`varchar, varchar, varchar`) so no `DROP` is needed —
    a drop would only discard the ACL. `create or replace` on an identical signature is safe.
  - **Normalization split by layer.** The client sends NFC-composed, trimmed, lower-cased text
    (`normalizeText()`); SQL applies `lower(regexp_replace(trim(x), '\s+', ' ', 'g'))` to both the
    input and the stored value, so the match is case- and whitespace-insensitive even if a caller
    skips the client pass.
  - **Pick-list consistency.** `classes` is per-teacher, so two teachers may own the same class
    name. Because `get_public_practice_classes()` lists a name when **any** teacher enables it, the
    class lookup uses `order by c.allow_practice desc, c.id` — a listed name cannot resolve to a
    different tenant's *disabled* class and be refused with `CLASS_PRACTICE_DISABLED`.
  - **New `get_public_practice_classes()`** — returns `jsonb_agg(distinct name order by name asc)`
    over `allow_practice = true`, wrapped in `coalesce(..., '[]'::jsonb)` because `jsonb_agg` over
    zero rows is NULL and the client iterates unconditionally.
  - **Teacher web.** `ClassRow.allow_practice`; `CLASS_COLUMNS` includes it; `createClass` gains an
    `allowPractice = true` parameter; new `togglePracticePermission(supabase, classId, allow)`.
    `ClassRosterManager` renders a `role="switch"` toggle with an optimistic override map plus a
    green/gray `Tự luyện: Bật` / `Tự luyện: Tắt` badge, and the create modal gains a default-checked
    checkbox.
  - **Student SPA.** The class datalist is populated from `get_public_practice_classes()` (merged
    with any roster-supplied class names); `selectModeTab('practice')` triggers a one-shot fetch.
    `startPracticeByFile()` calls `verify_student_practice` **before** dispatching the file to the
    Worker, aborts with the returned Vietnamese message and clears the file input on failure, and
    adopts the server's canonical `full_name`.

- **Database Migrations:** `20261007140000_class_practice_permission_and_verification.sql`
  - `alter table public.classes add column if not exists allow_practice boolean not null default true;`
  - `create index if not exists idx_classes_allow_practice on public.classes (allow_practice);`
  - `create or replace function public.verify_student_practice(...)` (new contract).
  - `create or replace function public.get_public_practice_classes()`.
  - `revoke all ... from public` then `grant execute ... to anon, authenticated` on both.

- **API Contracts:**
  - `verify_student_practice(p_class_name, p_full_name, p_student_code)`: **arguments unchanged**.
    The response shape **changed** from `{authorized, student_name, ...}` to
    `{success, code, message}` / `{success: true, class_name, full_name, student_code}`.
  - `get_public_practice_classes()`: new anon-callable RPC returning `{success, classes: string[]}`.

- **Deliberate behaviour change:** authorisation no longer consults `public.students`, so a
  teacher-less identifier (no `classes` row) now yields `CLASS_NOT_FOUND` instead of a roster match.
  This is the spec's explicit intent and is documented in the migration header and `schema.sql`.

## 3. Impacted Files

- `supabase/migrations/20261007140000_class_practice_permission_and_verification.sql` *(new)*
- `supabase/schema.sql` — `classes.allow_practice` + idempotency alter + index + comment; the
  `verify_student_practice` rewrite; new §C.7b `get_public_practice_classes`; ACL revoke/grant pair.
- `web/src/lib/types.ts` — `ClassRow.allow_practice`.
- `web/src/lib/classes.ts` — `CLASS_COLUMNS`, `createClass(..., allowPractice)`,
  `togglePracticePermission`.
- `web/src/components/ClassRosterManager.tsx` — optimistic toggle + status badge + create-modal
  checkbox.
- `student/app.js` — `RPC_MESSAGES` entries; `loadPracticeClasses` / `renderPracticeClassOptions`;
  `clearPracticeDatalists` / `fillPracticeDatalists` split; `startPracticeByFile` re-pointed to the
  new contract and gated before the upload.
- `tests/e2e_flow_verification.mjs` — Step 41 (21 assertions); Steps 2 / 11 / 32a / 32b / 32c updated
  for the new contract and seeded with matching `classes` + `class_members` rows.

## 4. Verification & Testing

- **Test Commands Executed:**
  - `node --check student/app.js` and `node --check tests/e2e_flow_verification.mjs` → exit 0
  - `npx tsc --noEmit` in `v2/web` → exit 0
  - `npm run build` in `v2/web` → compiled successfully, 5/5 static pages
  - `node tests/e2e_flow_verification.mjs` → **837 passed, 0 failed**
  - Migration applied locally and **re-applied** (idempotent): only
    `NOTICE: column "allow_practice" of relation "classes" already exists, skipping` and
    `NOTICE: relation "idx_classes_allow_practice" already exists, skipping`.
  - `pg_proc` verification: exactly one signature per function, both `prosecdef = t`;
    `information_schema.columns` reports `allow_practice | boolean | true | NO`.
- **Results:** Baseline 807 → **+30** net. Step 41 covers:
  - 41a: the column is NOT NULL and defaults to `true`.
  - 41b: an insert **omitting** the column gets `true` from the DB default (the create-modal path);
    the member is authorised; a non-member returns `STUDENT_NOT_FOUND`.
  - 41c: the pick-list RPC succeeds, always returns an array, lists the enabled class, and is
    ordered by the **database's** collation (asserted against the same `ORDER BY`, not a JS sort).
  - 41d: disabling persists, `verify_student_practice` returns `CLASS_PRACTICE_DISABLED`, and the
    class drops out of the pick list.
  - 41e: an unknown class returns `CLASS_NOT_FOUND`.
  - 41f: the SPA calls the pick-list RPC, verifies **before** `extractPracticeDocx`, branches on
    `success`, clears the file input on refusal, and reads `full_name`.
- **Regression guard:** Steps 2 / 11 / 32b / 32c now seed `classes` + `class_members` rows, because
  the flipped contract would otherwise fail them with `CLASS_NOT_FOUND` (Step 11's `12E2E` fixture
  previously existed only on the exam whitelist).
- **Rollback Strategy:**
  1. `git revert <this commit>` and re-apply the previous function definitions from history — no
     table or column was dropped, so no data repair is needed (the `allow_practice` column may be
     left in place harmlessly).
  2. To roll back only the DB: restore the pre-Phase-8.9 `verify_student_practice` body and
     `drop function public.get_public_practice_classes()`; the column is additive.
  3. Web/SPA are version-coupled to the RPC contract, so a partial rollback should revert the
     client files too.

## 5. Deviations From The Task Spec (and why)

The spec's file names and one PL/pgSQL construct did not match this codebase. The intent was fully
implemented; the differences:

| Spec draft | Reality | Resolution |
|---|---|---|
| `web/src/lib/classes.ts` `updateClass` / `saveClass` | Neither exists; only `createClass` | Extended `createClass` with `allowPractice` and added `togglePracticePermission` |
| `ClassList.tsx` / `ClassEditor.tsx` | Do not exist | Toggled in the real UI, `ClassRosterManager.tsx` (+ its inline `CreateClassModal`) |
| `CreateClassInput` / `UpdateClassInput` | Do not exist | Not added — no such types in the codebase |
| `DROP FUNCTION` before recreate | Signature is unchanged | Omitted: a drop would only discard the ACL and risk an overload window |
| `IF v_member IS NULL THEN` on an unassigned `RECORD` | Raises `record "v_member" is not assigned yet` whenever `p_student_code` is NULL/blank | Replaced with an explicit `v_matched boolean := false` flag set from `FOUND` |
| `jsonb_agg(name ORDER BY name)` | NULL over zero rows | Wrapped in `coalesce(..., '[]'::jsonb)` |
| `ClassRow.allow_practice` non-optional | The teacher list is fetched with `listClasses` | Typed as required; `CLASS_COLUMNS` always selects it |
