# Change Report: Tree of Knowledge — Student Interactive View (Phase 7.4)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Close the Tree of Knowledge loop from the student side: open a
  session from a link, check in by picking a name from the class roster, watch the
  class tree grow live, and submit (or revise) an answer with a live Vietnamese word
  counter.
- **Root Cause / Motivation:** Phases 7.1–7.3 delivered the schema/RPC, the renderer
  and the teacher projector, but students had no way to join — `tree_sessions` and
  `class_members` are both unreadable to `anon` (Section B revokes every table
  privilege), so the check-in data had no path to the browser. This phase supplies
  that one SECURITY DEFINER read plus the entire participation UI.

## 2. Technical Implementation Details
- **Database:**
  - `get_public_tree_session(uuid)` returns the check-in payload — question,
    `min_words`, `tree_seed`, `time_limit_minutes`, `created_at`, `class_name`,
    `total_students` and a **sanitised** candidate list. It is `SECURITY DEFINER`
    with a pinned `search_path` because `anon` cannot read either table.
  - The candidate projection is **two explicit keys** (`student_code`, `full_name`) —
    never `cm.*` — so `pin`/`dob` (both credentials; dob is the Phase 6.1 DDMM
    fallback PIN) cannot leak. Step 31c asserts on the **serialised** payload and on
    the literal fixture values, so a re-keying such as `student_pin` cannot slip past.
  - `total_students` is `greatest(..., 1)`: the client divides participation by it.
  - Window checks (inactive / expired) mirror `submit_tree_answer`, so check-in can
    never accept a student the write path would then refuse.
- **Student SPA:**
  - `student/tree-words.js` is a new dependency-free module (the `practice-order.js`
    pattern) holding `normalizeAnswerText` / `countTreeWords` / `treeWordCounterLabel`.
    It is the client twin of the RPC's
    `regexp_replace(trim(...), '\s+', ' ', 'g')` + `string_to_array` rule, so the
    button that enables submit and the server that validates use the SAME counting —
    and the e2e suite asserts the shipped module, not a copy.
  - `index.html` splits `#treeScreen` into two mutually exclusive states:
    `#treeCheckinForm` (question + `#treeStudentSelect` + `#btnEnterTree`) and
    `#treeWorkspace` (canvas, `#treeProgressBadge`/`#treeVitalityBadge`,
    `#treeAnswerInput`, `#treeWordCounter`, `#btnSubmitTreeAnswer`,
    `#treeStatusMessage`).
  - `app.js` adds `loadTreeFromUrl` (`?session=` or `?tree=`), `loadTreeActivity`
    (RPC → populate → pre-fetch submissions → subscribe → render), a Realtime
    subscription filtered on `session_id=eq.${id}` with client-side re-checking,
    `enterTreeWorkspace`, `updateTreeWordCounter` and `submitTreeAnswer`.
  - Ordering in `boot()`: the tree link is checked BEFORE `tryResumeSession()`, so an
    explicit join link is never overridden by a resumable exam. The stored exam
    session is left untouched, so dropping the query string resumes it.
  - The canvas is only measurable once the workspace is visible
    (`clientWidth/clientHeight` is 0 while `display:none`), so `enterTreeWorkspace`
    re-renders after `setTreeView('workspace')`.

## 3. Impacted Files
- `supabase/migrations/20261005130000_get_public_tree_session_rpc.sql`: **New.**
- `supabase/schema.sql`: §C.17 function + §D revoke/grant mirror.
- `student/tree-words.js`: **New.** Word normalisation + counting + counter label.
- `student/index.html`: Two-state tree screen with check-in and workspace.
- `student/styles.css`: `.tree-checkin*`, `.tree-workspace*`, `.tree-badge*`,
  `.tree-answer*`, `.tree-word-counter*` (sticky canvas ≥720px, 35vh on mobile).
- `student/app.js`: RPC messages, tree state fields, the whole Phase 7.4 controller,
  `bindTreeControls()` wiring, and the `boot()` URL branch.
- `tests/e2e_flow_verification.mjs`: Step 31 (32 assertions) + header entry.

## 4. Verification & Testing
- **Test Commands Executed:**
  - Migration applied twice locally (`psql -v ON_ERROR_STOP=1`) — both runs exit 0,
    proving idempotency; `has_function_privilege('anon', ...)` = `t`.
  - `node --check student/app.js`, `student/tree-words.js`, `student/tree-engine.js`
    — all exit 0.
  - `node tests/e2e_flow_verification.mjs` against the local Supabase stack.
- **Results:** `RESULT: 458 passed, 0 failed` (up from 426 at the end of Phase 7.3;
  **+32** Step 31 assertions). Step 31 covers:
  - **31b** the payload carries title/question/`min_words`/`tree_seed`/
    `time_limit_minutes`/`created_at`/`class_name`/`total_students`; candidates list
    all 3 members ordered by `student_code`, each exposing **exactly**
    `student_code` + `full_name`.
  - **31c** no literal `"pin"`/`"dob"` key and no stored PIN/DOB **value** anywhere in
    the serialised payload (fixtures deliberately carry both).
  - **31d** `SESSION_NOT_FOUND` on a random UUID, `SESSION_INACTIVE` on a closed
    session, `SESSION_EXPIRED` past the time limit.
  - **31e** the client counter matches the RPC rule across 7 cases (padding, tabs,
    newlines, empty, whitespace-only, null); whitespace collapse matches; the label
    guides toward the threshold; and a live submission proves the RPC's reported
    `word_count` equals the client's count.
  - **31f** load → pick → near-duplicate refused with a numeric
    `similarity_percent` → rewrite accepted → both fruits visible on the anon read
    path → engine anchors both → re-submission updates the same fruit row.
  - **31g** the SPA's uuid URL guard accepts a real id and rejects malformed input.
- **Rollback Strategy:** Revert the migration + `schema.sql` §C.17/§D lines, delete
  `student/tree-words.js`, and undo the `index.html` / `styles.css` / `app.js` /
  Step 31 changes. No data migration is involved beyond the new function.
