# Roadmap: Class Roster Management & Flexible PIN Authentication (Phase 6.1)

- **Created:** 2026-10-05
- **Last Updated:** 2026-10-05 (UTC+7)
- **Overall Status:** `COMPLETED` (`PLANNING` | `IN_PROGRESS` | `BLOCKED` | `COMPLETED`)

## 1. Objective
Introduce independent class roster management (`classes`, `class_members`) and
flexible PIN-based authentication for the student runtime with three modes —
`NONE`, `GLOBAL`, `INDIVIDUAL` (with a DDMM date-of-birth fallback) — plus an RPC
to import a class roster into an exam's `students` whitelist.

Completion criteria:
- `classes` + `class_members` exist with owner-scoped RLS.
- `exams.pin_mode` (CHECK NONE/GLOBAL/INDIVIDUAL, default INDIVIDUAL) + `exams.global_pin`.
- `students.dob` + `students.pin`.
- `import_class_to_exam(p_exam_code, p_class_ids uuid[])` returns the affected row count.
- `verify_and_acquire_session` gains `p_pin` and enforces the three modes,
  **without breaking the existing single-device lock / timer semantics**.
- Migration is idempotent; `schema.sql` mirrored; e2e Step 25 green; suite stays green.

---

## 2. Execution Phases

### Phase 1: DB — DDL, RLS, RPCs `[x]`
- [x] Tables `classes`, `class_members` (+ indexes, `anon` revoke).
- [x] `exams.pin_mode` / `exams.global_pin` + CHECK constraint.
- [x] `students.dob` / `students.pin`.
- [x] RLS for `classes` / `class_members`.
- [x] `import_class_to_exam` RPC + grants.
- [x] `verify_and_acquire_session` v2 with `p_pin` + PIN enforcement.
- [x] Mirror everything into `schema.sql` (§A, §B, §C.1, §C.14, §D).

### Phase 2: Apply & Prove Locally `[x]`
- [x] Applied to the local stack (clean `BEGIN … COMMIT`).
- [x] Re-applied: clean no-op (idempotent).
- [x] `schema.sql` applied end-to-end with `ON_ERROR_STOP=1` → exit 0, zero errors.

### Phase 3: e2e Step 25 `[x]`
- [x] Class + member CRUD with DOB and custom PIN.
- [x] `import_class_to_exam` populates `students`; re-import refreshes; refuses
      trashed / unknown exams.
- [x] PIN matrix: INDIVIDUAL custom / INDIVIDUAL DOB-fallback / GLOBAL / NONE,
      plus `INVALID_PIN` failures and the fail-closed GLOBAL case.
- [x] CHECK constraint rejects an invalid `pin_mode`.
- [x] Regression: omitting `p_pin` does not bypass the policy.

### Phase 4: Audit & Commit `[x]`
- [x] Full e2e run: **266 passed, 0 failed** (Steps 1–25).
- [x] Roadmap + change-reporter ledger/report.
- [x] `git add supabase/ tests/` and commit.

---

## 3. Chronological Progress Log
- **2026-10-05:** Roadmap initialized after reconnaissance. Local Supabase stack
  had to be started (Docker Desktop was down). Three spec defects were proven
  empirically before writing any DDL — see §4.
- **2026-10-05:** Migration written + applied + re-applied (idempotent).
- **2026-10-05:** `schema.sql` mirrored; applied end-to-end cleanly.
- **2026-10-05:** e2e Step 25 added (34 assertions); full suite 266/0.
- **2026-10-05:** Committed.

## 4. Blockers & Architectural Decisions

### D-A. `create or replace` with a new parameter CREATES AN OVERLOAD (security hole)
Proven locally: after `create function f(a varchar)` then
`create or replace function f(a varchar, b varchar default null)`, **both**
definitions survive (`pg_proc` shows two rows) and a call matching both becomes
ambiguous (`function f(unknown) is not unique`).

Consequence for this task: naively adding `p_pin` to `verify_and_acquire_session`
would leave the **old 6-arg, PIN-less function callable by `anon`** — a complete
PIN bypass. The migration therefore
`drop function if exists public.verify_and_acquire_session(<old args>);`
before creating the new signature, and `schema.sql` carries the same drop so it
stays self-healing. Step 25d asserts the bypass is closed.

### D-B. `REVOKE ... ON FUNCTION` on a missing signature is a hard ERROR
Proven locally: `revoke all on function public.probe_missing(varchar, varchar)
from public;` → `ERROR: function ... does not exist`. Since the old signature is
dropped, `schema.sql` Section D **had** to move to the new 7-arg signature;
leaving the stale 6-arg line would have aborted the whole script.

### D-C. `revoke ... from public` does NOT strip `anon`'s explicit grant
Proven locally: after `revoke all on function f(...) from public`,
`has_function_privilege('anon', ...)` was still **true**, because Supabase's
database-level default privileges grant EXECUTE to `anon` *explicitly* and an
explicit grant survives a PUBLIC revoke. `import_class_to_exam` therefore also
does `revoke all ... from anon`. (Steps 1–24 pass regardless, because the body
rejects an anonymous caller via `auth.uid()`; the ACL revoke makes the privilege
table match the documented "teacher-only" intent.)
**Flagged for follow-up:** five PRE-EXISTING teacher-only RPCs
(`delete_exam`, `restore_exam`, `purge_expired_exams`, `recalculate_exam_scores`,
`update_exam_questions_safe`) still carry an `anon=X` grant from the same
default-privilege behaviour. They are protected only by their `auth.uid()` body
checks. Out of scope here, but worth a hardening pass.

### D-D. New tables inherit an `anon` grant from database default privileges
Proven locally: `pg_default_acl` for `public` tables is
`{postgres=…, anon=arwdDxtm, authenticated=arwdDxtm, service_role=…}`. Phase 1
explicitly `revoke all … from anon` on every student-facing table to honour the
"students hold ZERO table privileges" invariant; `classes` / `class_members` are
revoked the same way and verified (`anon_select = f`).

### D-E. `auth.uid()` is safe inside SECURITY DEFINER
Confirmed by reading `auth.uid()`: it reads
`current_setting('request.jwt.claim.sub')`, i.e. the JWT, not the SQL role. So
`import_class_to_exam` (SECURITY DEFINER, owned by `postgres`) can still scope to
the calling teacher.

### D-F. `pin_mode = INDIVIDUAL` default preserves backwards compatibility
Every pre-existing exam defaults to `INDIVIDUAL`, and every pre-existing
`students` row has `pin IS NULL` and `dob IS NULL`. The rule "both null → pass"
therefore keeps all existing exams and e2e Steps 1–24 working unchanged, without
the student SPA sending `p_pin` at all. This is why INDIVIDUAL — not NONE — is the
right default: it is the strict mode, yet it degrades to "pass" only for rosters
that carry no secret whatsoever.

### D-G. Null-safe PIN comparison (fail closed)
`trim(coalesce(p_pin,'')) is distinct from trim(v_exam.global_pin)` rather than
`=`. With plain `=`, a GLOBAL exam whose `global_pin` was never set compares
NULL, the enclosing `IF` falls through, and **every** candidate is admitted.
Step 25 asserts the unset-GLOBAL case refuses.

### D-H. PIN check placement in `verify_and_acquire_session`
Inserted after the identity match (step 3) and before the duplicate-submission
probe (step 4), so a wrong PIN never touches the session lock or the results
table.

### D-I. `import_class_to_exam` error signalling (deviation, kept per spec)
The spec has it `RETURNS INTEGER` and `RAISE EXCEPTION
'UNAUTHORIZED_OR_EXAM_NOT_FOUND'`, unlike every other RPC here which returns
`jsonb` with a code in `message`. Kept as specified because it is an explicit
contract in the task and all-or-nothing failure is the desired behaviour for a
teacher-side batch import. Tested via the error message.

### D-J. Not in scope: the student SPA PIN input
The task scoped this phase to the migration + tests (`git add supabase/ tests/`).
The SPA does not yet send `p_pin`, which is safe here (see D-F) but means a
teacher who enables `GLOBAL`/custom `INDIVIDUAL` PINs has no student-facing entry
path yet. Presumably a Phase 6.2 UI deliverable.
