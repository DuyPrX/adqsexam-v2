# Change Report: Top-First Exam Code Entry, Progressive Roster Picker & Flexible Dual-Auth (Phase 8.8)

- **Date:** 2026-10-07
- **Scope:** Major Change
- **Author/Agent:** TraeCode agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Make the student login flow code-first (the exam code determines everything
  below it), surface the exam's identity before the student commits, and let the server
  authenticate a candidate from `(class_name, full_name)` when no student code is available —
  with Vietnamese-aware text normalization on both sides.
- **Root Cause / Motivation:** Phase 8.1 removed the visible student-code input but left
  `verify_and_acquire_session` matching on `student_code` only. The SPA therefore had to
  pre-resolve that code from a separately fetched roster, which made the roster RPC a **hard
  dependency of logging in**: if it failed, or the exam's roster was empty, a student typing
  their exact name and class could not sit the exam. The client also compared names with raw
  `toLowerCase()`, so a duplicated space — or a Vietnamese diacritic typed in decomposed form,
  which is common from a phone keyboard or a PDF paste — silently failed to match.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - **Server-side flexible lookup.** `verify_and_acquire_session` now resolves the candidate in
    two steps: by `student_code` when a usable one is supplied (the fast path, unchanged), else by
    the normalized `(class_name, full_name)` pair. Both the caller's input and the stored row are
    normalized in SQL (`lower(regexp_replace(trim(...), '\s+', ' ', 'g'))`), so the client's
    normalization is a convenience, not a correctness requirement.
  - **The code is a disambiguator, not a credential.** When a code is supplied, the function still
    asserts the typed name/class against that row — a correct code with the wrong name is rejected
    as `IDENTITY_MISMATCH`. This is what makes the fast path safe to keep.
  - **The resolved code keys the guards.** The `ALREADY_SUBMITTED` probe and the single-device
    `FOR UPDATE` lock are now keyed on `v_student.student_code` rather than the caller's input, so
    a candidate cannot dodge either by omitting the code and using the fallback.
  - **`normalizeText()` in the SPA** — NFC + trim + lower-case + collapse whitespace. Applied to
    both sides of every client-side comparison (`readIdentity`, `matchPracticeCandidate`).
  - **The manual branch no longer requires a roster.** It sends `null` when nothing matched and
    lets the server decide, which is the point of the change. The roster is still consulted to
    attach a code when it knows one, and to echo the canonical spelling.
  - **The SPA adopts the server's identity.** Every later call (heartbeat, submit, certificate) is
    keyed on `student_code`, so the login handler now backfills `state.studentCode/_name/_class`
    from the response. Without this the session would be live server-side while the client held an
    empty code.
- **Database Migrations:** `20261007120000_fix_student_auth_flexible_lookup.sql`
  - Rewrites `verify_and_acquire_session` steps 2–3 and keys steps 4–5 on the resolved code.
  - **Signature unchanged** — so there is no `drop function`, hence no ACL hazard, no overload
    ambiguity and no client change required.
  - Returns additive keys: `student_code`, `student_name`, `class_name`, `exam_title`,
    `duration_minutes`, `shuffle_questions`.
  - `get_exam_roster` gains `duration_minutes` (additive) for the banner.
- **API Contracts:**
  - `verify_and_acquire_session`: **no argument change**; `p_student_code` is now optional in
    practice (null/blank ⇒ fallback). New response keys are additive; existing callers read only
    `success` / `session_token` / `message`.
  - `get_exam_roster`: one additive response key. The candidate projection still carries only
    `student_code` / `full_name` / `class_name` — `pin` and `dob` remain server-side (re-asserted
    in Step 40h).

## 3. Impacted Files

- `supabase/migrations/20261007120000_fix_student_auth_flexible_lookup.sql` *(new)*
- `supabase/schema.sql` — mirror of both functions.
- `student/index.html` — exam code wrapped in `.input-with-button` with `#btnVerifyExamCode`;
  `#examMetaBanner`/`#examMetaTitle`/`#examMetaStatus`; `#labelStudentPin`/`#hintStudentPin`;
  practice panel reordered so the code precedes class/name.
- `student/app.js` — `normalizeText()`, `applyPinLabels()`, `renderExamBanner()`,
  `clearExamBanner()`; `loadExamRoster` renders/labels; `readIdentity` relaxed; submit sends
  `null`; server identity adopted; `matchPracticeCandidate` normalized; verify button wired.
- `student/styles.css` — `.input-with-button` (+ narrow-screen wrap), `.exam-meta-banner*`.
- `tests/e2e_flow_verification.mjs` — Step 40 (49 assertions).

## 4. Verification & Testing

- **Test Commands Executed:**
  - `node --check student/app.js` → exit 0
  - `node --check tests/e2e_flow_verification.mjs` → exit 0
  - `npm run build` in `v2/web` → compiled successfully, 5/5 static pages
  - `node tests/e2e_flow_verification.mjs` → **807 passed, 0 failed**
  - Migration applied locally and **re-applied** (idempotent); `pg_proc` shows exactly **one**
    `verify_and_acquire_session` signature, `prosecdef = true`, and `anon`/`authenticated` retain
    EXECUTE.
- **Results:** Baseline 758 → **+49**. Step 40 covers:
  - 40a/40b: DOM order asserted by raw string index in both `#loginForm` and `#practicePanel`.
  - 40c: `readIdentity` no longer hard-blocks on an empty roster.
  - 40d: `normalizeText` **executed**, not inspected — including a derived NFD fixture.
  - 40e/40f: the SQL normalizes both sides, and **all five pre-existing security guards** are
    re-asserted (dup guard, `FOR UPDATE` lock, three fail-closed `is distinct from` PIN
    comparisons, F5 token resume, 60s takeover).
  - 40g/40h: **live DB round-trips** — a NULL code authenticates a candidate whose stored name
    contains doubled spaces and whose class is upper-cased, while a wrong name, wrong class, or an
    unknown identity is refused.
- **One test-authoring defect caught and fixed:** my first NFC fixture hand-wrote the decomposed
  form with a combining *acute*; ễ is **e + circumflex + tilde**. The implementation was correct —
  the fixture was wrong. Replaced with `composed.normalize('NFD')` and added a guard asserting the
  two forms genuinely differ, so the check cannot be vacuous.
- **Rollback Strategy:**
  1. `git revert <this commit>` — the migration is a `create or replace` of two functions, so no
     data repair is needed.
  2. To roll back only the DB, re-apply the previous definition of both functions from this
     repository's history; no table or column was added or dropped.
  3. The SPA changes are backward-compatible with the old RPC (it still sends the code when it has
     one), so a client/server version skew degrades to the old behaviour rather than breaking.

## 5. Deviations From The Task Spec (and why)

The spec's SQL draft targeted a schema this project does not have. Applied verbatim it **would
have broken every student login**. The intent was implemented instead; the differences:

| Spec draft assumes | Reality | Resolution |
|---|---|---|
| `active_sessions.id/.status/.started_at/.client_session_id/.last_heartbeat_at` | PK `(student_code, exam_code)`; `last_heartbeat`; no `id`/`status` | Used the real columns |
| `pin_mode ∈ {INDIVIDUAL_PIN, DOB_ONLY}` | CHECK allows only `NONE`, `GLOBAL`, `INDIVIDUAL` | Kept the real modes; the dynamic PIN label maps them |
| `exams.max_ip_switches` | column absent | Not referenced |
| returns `session_id`; drops the dup guard, device lock, 60s takeover, F5 resume | live returns `session_token` and has all four | All preserved |
| args `p_dob, p_pin, p_client_session_id` | args `p_device_info, p_existing_token, p_pin` | Signature kept — the SPA already sends these |
| `drop function` then recreate | unchanged signature needs no drop | No drop ⇒ no ACL hazard |

Also already present before this phase, so **not** re-done: the exam code was already the first
field of `#loginForm`, and `get_practice_exam_payload` already fell back to
`(class_name, full_name)`.
