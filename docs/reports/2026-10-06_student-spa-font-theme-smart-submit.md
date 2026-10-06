# Change Report: Student SPA — Font Resize Fix, Global Theme Switcher & Smart Submit Modal (Phase 8.6)

- **Date:** 2026-10-06
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Three Student SPA (`v2/student/`) fixes on top of the Phase 8.5
  overhaul: (1) make the `🔤` font control actually enlarge the reading text;
  (2) make the theme switcher reachable from the login/roster screen, not only
  during a sitting; (3) replace the blind "Nộp bài?" confirmation with a **smart**
  dialog that warns about unanswered questions and jumps straight to the first one.
- **Root Cause / Motivation:**
  - **The font button was a no-op on desktop.** `@media (min-width: 1024px)`
    contained `.q-text { font-size: 21px; }`, a hard-coded size that **outranked**
    `calc(19px * var(--reading-scale))` by cascade order. The base font variable
    grew, but the rendered question text did not — so `data-font="lg"/"xl"` looked
    like it did nothing on wide screens. The `1 / 1.125 / 1.25` ladder was also too
    subtle to notice even when it worked.
  - **Theme control was trapped inside the exam header.** `#examHeader` is hidden
    until a sitting starts, so a student sensitive to glare could not pick their
    lighting on the login/roster screen where they actually spend time reading.
  - **A destructive action with a blind prompt.** The old overlay reported only an
    answered/total count. A student who clicked "Nộp bài" with 7 blanks left had to
    cancel and then hunt the paper for them; nothing told them *which*.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Reading scale.** `--reading-scale` is now `1 / 1.18 / 1.36` under
    `:root[data-font="lg"|"xl"]`, and the offending desktop media-query override is
    deleted (`styles.css`). `.q-text`, `.option` and `.tf-item__text` all consume
    it, so title, body and options enlarge together.
  - **Shared font ladder.** `exam-nav.js` owns `FONT_CYCLE = ['', 'lg', 'xl']` and
    `FONT_LABELS = { '': 'Chuẩn', lg: 'Lớn', xl: 'Rất lớn' }`. The normal step is the
    **empty string**, i.e. the absence of the `data-font` attribute, so the `:root`
    defaults apply untouched and a stale attribute can never pin a student to a
    value the CSS no longer defines. `app.js` renders
    `🔤 Cỡ chữ: ${FONT_LABELS[step]}` so the current size is named, not implied.
  - **Global theme switcher.** A new `.app-global-header#globalHeader` sits in
    `#view-exam` **outside** `#examHeader` (so it exists while the login screen is
    up) at `z-index: 40 < 55`, i.e. behind the sticky exam header mid-exam rather
    than doubling the controls. Both buttons are painted by one `paintThemeButton()`
    helper, so `#btn-theme-toggle` and `#btn-global-theme-toggle` can never
    disagree. The login card/fields already read the canonical tokens, so all three
    themes (light/dark/sepia) apply immediately.
  - **Smart submit.** New pure export
    `getUnansweredQuestions(questions, answers)` returns
    `{ index, ordinal }[]` in paper order, reusing the same answered semantics as
    the SPA's `isDraftReady()` (MCQ `draft !== null`; TRUE_FALSE any non-empty
    sub-statement; otherwise trimmed text non-empty). `openSubmitConfirm()` renders
    two variants into the single `#submitModal`:
    - complete → "Hoàn thành bài thi! 🎉" with "Xem lại" / "Xác nhận nộp";
    - incomplete → "Chưa hoàn thành bài thi ⚠️", the count, one `.unanswered-tag`
      per "Câu N", and "Tiếp tục làm bài" which closes the modal and calls
      `goToQuestion(unanswered[0].index)` — the **smallest** unanswered index.
    The "continue" click handler is rebound on every open, so its per-mode
    semantics (practice vs official) cannot go stale.
- **Database Migrations:** None. The smart decision is derived client-side from
  `state.questions` + `state.answers`; no worker/RPC contract changed — as the task
  explicitly required.
- **API Contracts:** Unchanged. `submit_exam_result` is still invoked by
  `submitExam(false)` from the modal's confirm button.

## 3. Impacted Files
- `v2/student/exam-nav.js`: `FONT_CYCLE` → `['', 'lg', 'xl']`; added `FONT_LABELS`;
  added `getUnansweredQuestions()` (+ private `normalizeQuestionType` /`isAnswerFilled`);
  `nextFontStep()` keyed off `''`.
- `v2/student/app.js`: adopted the shared `FONT_LABELS`; `currentFontStep()`/
  `initFontSize()`/`cycleFontSize()` use the `''` convention; added
  `paintThemeButton()` driving both theme buttons; rewrote `openSubmitConfirm()` as
  the smart modal; rewired boot (`#btn-global-theme-toggle`, `#btn-modal-confirm-submit`)
  and repointed the remaining `confirmOverlay` hide/guard calls at `#submitModal`.
- `v2/student/styles.css`: `--reading-scale` 1/1.18/1.36; removed the
  `min-width:1024px` `.q-text` override; scaled `.option` and `.tf-item__text`;
  added `.app-global-header`, `.modal-backdrop`, `.submit-modal-card`,
  `.unanswered-tag-list`, `.unanswered-tag`; reserved login top padding; dropped the
  dead `.action-bar` rules.
- `v2/student/index.html`: added `.app-global-header#globalHeader` with
  `#btn-global-theme-toggle`; replaced `#confirmOverlay` with `#submitModal`.
- `v2/tests/e2e_flow_verification.mjs`: corrected the now-stale Step 36d font
  assertions to the `''`-based ladder and added **Step 37** (24 assertions).

## 4. Verification & Testing
- **Test Commands Executed:**
  - `node --check student/exam-nav.js` → exit 0
  - `node --check student/app.js` → exit 0
  - `node tests/e2e_flow_verification.mjs`
- **Results:**
  - **655 passed, 0 failed** (baseline before this phase was 632; **+23 net**).
  - Step 37a executes `getUnansweredQuestions()` against a mixed paper (MCQ / TRUE_FALSE /
    SHORT / ESSAY), pinning the ordinal mapping, the paper-order guarantee that makes
    `unanswered[0].index` the smallest, and the "MCQ choice index 0 is answered"
    falsy-trap. Step 37b–37d assert the scale ladder, the label map, the global header
    placement, and the modal copy/wiring.
  - Two assertions failed on the first run and both were fixed at the source of the
    *test*, not by weakening the code: (a) the partially-answered TRUE_FALSE case —
    the implementation deliberately mirrors `isDraftReady()` so the modal count can
    never disagree with the palette's answered count, so the assertion was corrected
    to match the contract; (b) the media-query guard matched the *comment* describing
    the removed override, so the check now strips CSS comments before matching.
- **Rollback Strategy:** `git revert <commit>` — the phase is additive to
  `exam-nav.js` and swaps one self-contained modal (`#confirmOverlay` →
  `#submitModal`) in the other three files. No migration or data change is involved,
  so reverting restores the previous submission flow with no state cleanup.
