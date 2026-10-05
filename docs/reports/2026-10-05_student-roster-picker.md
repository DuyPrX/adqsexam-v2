# Change Report: Student SPA — URL Pre-fill, Roster Selector & PIN Authentication

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Let a student open the SPA from a link, pick their own name from
  the exam's roster instead of typing it, and enter the PIN configured in Phases
  6.1/6.2. Adds `get_exam_roster` so the picker has data to render.
- **Root Cause / Motivation:** Phases 6.1 and 6.2 delivered the whole PIN and
  class-roster feature set on the server and in the teacher web, but the student
  runtime still asked for a hand-typed student code, full name and class — and
  **never sent `p_pin` at all**. A teacher who set a GLOBAL PIN therefore
  created an exam that literally nobody could enter (the Phase 6.1 gate fails
  closed on a NULL PIN). This change closes that loop. Typing the identity by hand
  was also the weakest link in the identity check, since the server compares the
  submitted name/class byte-for-byte against the roster.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **`get_exam_roster(p_exam_code varchar) -> jsonb`** (new, SECURITY DEFINER,
    anon-executable). Validates the exam (exists / not trashed / `is_active` /
    inside the `starts_at`..`ends_at` window — the same ladder
    `verify_and_acquire_session` uses) and returns
    `{ success, exam_code, title, pin_mode, candidates[] }` where each candidate
    is **exactly** `{ student_code, full_name, class_name }`.
    The projection is written as three explicit keys — never `s.*` — because
    `pin` and `dob` are both exam credentials (`dob` is the DDMM fallback PIN).
    An empty roster is a **success with `[]`**, not an error: that is the signal
    the SPA uses to fall back to manual entry.
  - **URL pre-fill** (`?code=` canonical, `?c=` short link). Sets the exam-code
    input and immediately loads its roster, but deliberately does **not**
    auto-start: a URL must never be able to open a sitting on its own. It also
    runs only when the login screen is actually shown, so a resumed session
    skips a wasted RPC.
  - **Roster picker.** `#class-select` is populated with the distinct
    `class_name`s (a single class is preselected); selecting one rebuilds
    `#student-select` from that class's candidates, and selecting a student
    writes the code into `#student-code-hidden`. `readIdentity()` re-derives
    `full_name`/`class_name` **from the roster row**, so what is submitted is
    byte-identical to what the server compares against. An
    out-of-order-response guard (`state.rosterRequestId`) stops a slow earlier
    fetch from overwriting a newer one while the student retypes the code.
  - **Graceful degradation.** Every roster failure path (blank code, network
    error, empty roster) reverts to the Phase 5 manual inputs with a short status
    note; only a *definitive* server refusal (closed / trashed / not-yet-open /
    ended) is surfaced as an error, because retyping cannot help there.
  - **PIN.** `#student-pin` (type=password) is hidden when `pin_mode === 'NONE'`
    and left **visible in the manual fallback**, where `pin_mode` is unknown — a
    GLOBAL exam would otherwise be impossible to enter. The value is sent as
    `p_pin` (`null` when empty). `INVALID_PIN` is mapped to the Vietnamese copy
    `'Mã PIN hoặc ngày sinh không đúng. Vui lòng thử lại!'`, and the error
    handler now reads `payload.code || payload.message` because the RPC reports
    the code in different fields depending on the branch.
  - **Reload tolerance (F5).** The Phase 6.1 PIN gate runs *before* the session
    lock, so a resume without `p_pin` is refused as `INVALID_PIN` — and the
    follow-up attempt then sees the still-live session row and returns
    `SESSION_ACTIVE_ELSEWHERE`, locking the student out for 60s after a stray
    F5. F5 reload tolerance is an explicit architecture guarantee, so the PIN is
    persisted in the existing session blob and resent on resume.
- **Database Migrations:** `20261005110000_get_exam_roster_rpc.sql` — one new
  function plus its grants. Signature is unchanged from any prior run, so
  `create or replace` is safe and no `drop function` is needed (contrast Phase
  6.1, where adding `p_pin` would have created an overload). Mirrored in
  `schema.sql` as §C.15 with the §D `revoke`/`grant` pair.
- **API Contracts:** `get_exam_roster(varchar) -> jsonb` is the **one** anon RPC
  that answers before the caller proves roster membership — unavoidable, since
  the picker exists so the student can find their own name. Accepted trade-off,
  documented in the migration: anyone holding a live 6-digit code can enumerate
  that exam's names/codes/classes, but **no secret**. Mitigations: a 900k code
  space, out-of-band distribution, and hard refusal for trashed/closed/ended
  exams. `verify_and_acquire_session` is unchanged; it simply now receives the
  `p_pin` it has accepted since Phase 6.1.

## 3. Impacted Files
- `supabase/migrations/20261005110000_get_exam_roster_rpc.sql` (**new**): the RPC.
- `supabase/schema.sql`: §C.15 function + §D revoke/grant mirror.
- `student/index.html`: exam-code renamed to `#exam-code`; new `#rosterFields`
  (class/student selects), `#manualFields` (fallback inputs), `#student-code-hidden`,
  `#pin-field-group` / `#student-pin`, `#rosterStatus`.
- `student/styles.css`: `.field select.form-control`, `.hint-text`,
  `.roster-status` (the `<select>` needs its own rule — it is not covered by the
  `.field input` selector).
- `student/app.js`: `loadExamRoster`, `populateClassSelect`,
  `populateStudentSelect`, `onStudentSelected`, `readIdentity`, `setRosterMode`,
  `applyPinVisibility`, `bindRosterControls`, rewritten `prefillFromUrl`,
  `p_pin` in both login and resume, `INVALID_PIN` copy, PIN persisted in
  `writeSession`.
- `tests/e2e_flow_verification.mjs`: Step 27 (30 assertions) + teardown.

## 4. Verification & Testing
- **Test Commands Executed:**
  - Migration applied twice against the local Supabase stack
    (`docker exec -i supabase_db_v2 psql …`) — exit 0 both times, and a `pg_proc`
    probe confirmed **exactly one** `get_exam_roster` overload with
    `anon`/`authenticated` EXECUTE.
  - `schema.sql` applied end-to-end to the live `postgres` database — exit 0.
  - `node --check v2/student/app.js` — exit 0.
  - `node v2/tests/e2e_flow_verification.mjs` — full suite.
- **Results:** `RESULT: 332 passed, 0 failed` (was 307; **+30** from Step 27).
  Step 27 covers: the happy-path payload shape (exactly three keys per
  candidate, ordered by class then code, `pin_mode` reported); the rejection
  matrix (trashed → `EXAM_NOT_FOUND` indistinguishable from missing, closed →
  `EXAM_INACTIVE`, before `starts_at` → `EXAM_NOT_STARTED`, past `ends_at` →
  `EXAM_EXPIRED`, unknown → `EXAM_NOT_FOUND`, blank → refused without a scan,
  lowercase/whitespace still resolves); an empty roster → `success:true` with
  `[]`; **credential-leak assertions on the serialised payload** (no `"pin"` or
  `"dob"` key *and* neither the literal `SECRET1` nor any DOB value present, so a
  future re-keying such as `student_pin` cannot slip past a key-name check); the
  picked identity + PIN passing `verify_and_acquire_session`; and the reload
  path both failing without the PIN and resuming with it.
- **Rollback Strategy:** Revert the commit. Drop the function
  (`drop function public.get_exam_roster(varchar);`) if the DB must be reverted
  independently — nothing depends on it. The SPA degrades to manual entry
  automatically if the RPC is absent (the `!result.ok` branch), so a rolled-back
  database does not brick the student runtime.

## 5. Notable Deviations
1. **`EXAM_ENDED` → `EXAM_EXPIRED`.** The spec's error code for the past-`ends_at`
   case was `EXAM_ENDED`, but this codebase already uses `EXAM_EXPIRED` for that
   exact condition in `verify_and_acquire_session`. Using the spec's name would
   have split the vocabulary and left the SPA's `RPC_MESSAGES` map with an
   unreachable entry, so the existing code was kept and the SPA reuses it.
2. **Real DOM ids, not the spec's.** The spec proposed `#exam-code`,
   `#class-select`, `#student-select`, `#student-pin`, etc. against an assumed
   `#exam-form`/`#exam-panel` structure. The actual form is `#loginForm` with
   `#examCode`/`#studentCode`/`#fullName`/`#className`. The spec's ids were
   adopted for the **new** nodes, and the pre-existing identity inputs were
   renamed (`#exam-code`, `#student-code-input`, `#student-name-input`,
   `#class-name-input`) rather than duplicating them, so there is one source of
   truth per field.
3. **Two separate field blocks, not one with `display:none` toggles.** The picker
   and the manual fallback are fully separate element sets, so a hidden stale
   half of the form can never be read. `required` is kept in sync with visibility
   for assistive-tech correctness (the form is `novalidate`, so `readIdentity()`
   is what actually enforces the choice).
4. **The PIN is persisted in `localStorage`.** Not in the spec, but required for
   F5 tolerance (§2). The blob already holds the bearer `session_token`, so it
   already grants exam access to anyone who can read it; the PIN adds no new
   exposure and is cleared by `clearSession()` on submit, eviction and restart.
5. **`p_pin` is omitted-as-null rather than always sent.** `state.pin` is `null`
   for `pin_mode = NONE`, which the RPC treats as "no credential" — correct for
   NONE and fail-closed for GLOBAL/INDIVIDUAL, as Step 27e asserts.
