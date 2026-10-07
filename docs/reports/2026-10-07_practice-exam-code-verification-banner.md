# Change Report: Practice Exam Code Verification & Meta Banner (Phase 8.10)

- **Date:** 2026-10-07
- **Scope:** Minor Change (student SPA only; no DB/RPC change)
- **Author/Agent:** TraeCode agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Give the practice panel (`#practicePanel`) the same "Kiểm tra đề"
  affordance the official form already has (Phase 8.8): an explicit trigger that
  verifies the practice exam code up-front and reveals the exam's identity — or the
  server's refusal — before the student commits.
- **Root Cause / Motivation:** `loadPracticeRoster` (Phase 8.1) was deliberately
  *silent* on failure: it swallowed every refusal because the roster was treated as a
  best-effort convenience layer. That was defensible while the code only drove the
  datalists, but it left a student who typed a closed-for-practice or mistyped code
  with **no feedback at all** — the datalists simply stayed empty and they discovered
  the problem only after filling in their identity and pressing start. The official
  form had already solved this with a verify button + identity banner; practice mode
  needed the same.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - **The verdict is now rendered, not swallowed.** `loadPracticeRoster` sets
    `state.practiceCodeStatus` to `null` / `'ok'` / `'error'` and drives three new
    renderers (`renderPracticeBanner`, `renderPracticeBannerError`,
    `clearPracticeBanner`). The submit path still re-checks server-side, so the banner
    is an **affordance, never the gate**.
  - **The shared start button is scoped to its source.** `#practiceStartBtn` is used
    by BOTH practice sources, so a bad *code* must not disable the personal-`.docx`
    flow (a Phase 8.9 feature). `updatePracticeStartState()` therefore disables it
    only while `state.practiceSource === 'code'` AND the verdict is `'error'`, and
    `selectPracticeSource` re-evaluates it on every switch. The old blanket
    `$('practiceStartBtn').disabled = false` in `handlePracticeSubmit`'s `finally`
    was replaced with a call to the same helper.
  - **Four triggers, one loader.** `change`, the `#btnVerifyPracticeCode` click,
    `Enter` (`keydown`, with `preventDefault()` — the input lives inside
    `#practiceForm`, so an un-intercepted Enter would submit and START practice), and
    `blur` all funnel into `loadPracticeRoster`. An `input` listener invalidates the
    previous verdict and hides the banner, so it can never describe a code the
    student has since edited.
  - **The blur handler is guarded.** Clicking "Bắt đầu ôn luyện" blurs the code field,
    and re-verifying then would RACE the submit: the loader clears
    `state.practiceRoster` *before* its `await`, so `handlePracticeSubmit` could lose
    the canonical `student_code` it resolves from that roster. The handler skips the
    reload when the code is unchanged and already carries a verdict.
  - **The request-id guard is preserved** — a slow earlier verification cannot
    overwrite a newer verdict (`requestId !== state.practiceRosterRequestId`).
  - **URL prefill runs on first practice-tab activation**, not in `boot()`: the panel
    is hidden by default, so verifying a code the student cannot see would fire an
    RPC for an unopened screen. `?practice_code=` is the unambiguous twin of the
    official `?code=` (both accepted); a latch (`state.practiceUrlPrefilled`) keeps
    re-opening the tab from re-firing the RPC.
  - **Code normalization** now upper-cases in the loader (matching
    `loadExamRoster`/`get_exam_roster`'s `upper(trim(...))`), so a lower-case URL or
    typed code still resolves.
- **Database Migrations:** None. `get_exam_roster(p_exam_code, p_for_practice)` already
  returned `title`, `allow_practice` and `candidates` (Phase 6.3 / 8.7 / 8.8); this
  phase only consumes them.
- **API Contracts:** Unchanged. No RPC added, removed, re-signatured or re-granted.

## 3. Impacted Files

- `student/index.html` — the practice code input wrapped in `.input-with-button` with
  `#btnVerifyPracticeCode`; new `#practiceMetaBanner` / `#practiceMetaTitle` /
  `#practiceMetaStatus` between the code row and the identity fields.
- `student/app.js` — `loadPracticeRoster` rewritten to render a verdict;
  `renderPracticeBanner` / `renderPracticeBannerError` / `clearPracticeBanner` /
  `updatePracticeStartState`; `applyPracticeCodeFromUrl`; four event bindings +
  the input-invalidation listener; `selectPracticeSource` and `handlePracticeSubmit`
  delegate re-enabling; two new `state` fields.
- `student/styles.css` — `.exam-meta-banner.is-success` / `.is-error` (tinted banner;
  the error status wraps instead of being clamped to one line).
- `tests/e2e_flow_verification.mjs` — Step 42 (28 assertions); plus the Step 2 / 32b
  insert sites and the teardown made idempotent (see Verification).

## 4. Verification & Testing

- **Test Commands Executed:**
  - `node --check student/app.js` → exit 0
  - `node --check tests/e2e_flow_verification.mjs` → exit 0
  - `node tests/e2e_flow_verification.mjs` → **867 passed, 0 failed** (run twice, to
    prove the new cleanup path leaves no residue)
- **Results:** Baseline 837 → **+30** net. Step 42 covers:
  - 42a: markup — the button sits in the same `.input-with-button` row as the input;
    the banner exists with both slots, starts `hidden`, and renders *between* the
    code row and `#practiceClassName`; the button is `type="button"` so it cannot
    submit the form.
  - 42b: wiring — the loader calls `get_exam_roster` with `p_for_practice: true`; the
    button, `Enter`, `blur` and `input` are all bound; the success branch writes
    `` `📚 ${title}` `` and `'Cho phép tự luyện'` and adds `is-success`; the failure
    branch adds `is-error` and disables the button; the disabled state is scoped to
    the by-code source; the request-id guard survives.
  - 42c: URL — `?practice_code=` / `?code=` are read, the prefill is invoked on tab
    activation and latched.
  - 42d: **live RPC round-trips** — a CLOSED but practice-enabled exam verifies and
    returns `title` / `allow_practice` / `candidates`; a practice-disabled exam is
    refused with `PRACTICE_NOT_ALLOWED` and the exact message the banner shows; an
    unknown code is refused with `EXAM_NOT_FOUND` and its message; and the SPA's local
    message map carries the Vietnamese fallback.
- **Test defects caught and fixed during this phase:**
  1. The first run failed 4 checks — all **pre-existing Phase 8.9 seeding**, not this
     phase's code: `STUDENT.className` and `CAN_CLASS` are *constant* class names, so
     the aborted run left rows behind and `classes_user_name_uniq` rejected the
     re-insert (which in turn cascaded into an RLS refusal for the member insert).
     Added a name-scoped `delete` before each insert and a name-scoped teardown, since
     a failed insert leaves the captured `id` undefined.
  2. While wiring the blur trigger I noticed it would race `handlePracticeSubmit` (the
     loader nulls `state.practiceRoster` before awaiting); added the unchanged-code
     guard described above rather than shipping a latent submit bug.
- **Rollback Strategy:**
  1. `git revert <this commit>` — the change is confined to three student SPA files
     plus tests; no data migration to unwind.
  2. There is **no server-side coupling**: the SPA still degrades to the pre-8.10
     behaviour (silent best-effort roster fetch) if the banner markup or renderers are
     reverted independently, because `loadPracticeRoster` remains the single loader.
