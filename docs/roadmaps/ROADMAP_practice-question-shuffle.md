# Roadmap: Practice Question Shuffle Toggle (Phase 5.9)

- **Created:** 2026-10-05
- **Last Updated:** 2026-10-05 (UTC+7)
- **Overall Status:** `COMPLETED` (`PLANNING` | `IN_PROGRESS` | `BLOCKED` | `COMPLETED`)

## 1. Objective
Let a student choose, per self-practice run, whether the questions are shown in a
shuffled order or in the original `position ASC` order. Applies to BOTH
practice-by-code and practice-by-DOCX. Grading/review stay client-side in RAM and
must keep working identically in either order.

Completion criteria:
- A checkbox in the practice panel controls the order.
- Shuffle ON  → display order differs from source order (Fisher-Yates), every
  question keeps its `correctAnswer` + `explanation`.
- Shuffle OFF → strict original source order.
- Works for both practice sources.
- `node --check v2/student/app.js` passes; e2e suite stays green with new checks.

---

## 2. Execution Phases

### Phase 1: Student UI + Styles `[x]`
- [x] Add the `#practice-shuffle-toggle` checkbox to `#practicePanel`.
- [x] Add `.practice-option` styling that aligns cleanly desktop + mobile.

### Phase 2: Testable Ordering Logic `[x]`
- [x] Extract the DOM-free ordering helpers into `student/practice-order.js`
      (`shuffledOrder`, `orderPracticeQuestions`, `readShuffleToggle`).
- [x] Reuse the shared `shuffledOrder` for the existing official-exam shuffle
      (removed the duplicate local definition in `app.js`).

### Phase 3: Wire the Toggle into the Practice Flow `[x]`
- [x] Read the toggle inside `enterPractice` (covers both sources via one path).
- [x] Preserve the source ordinal in `normalizePracticeQuestions` so the
      "original order" branch is meaningful.

### Phase 4: Verification & Audit `[x]`
- [x] Add e2e Step 24 (24 assertions) exercising the real ordering module.
- [x] Run `node --check` (both files) + the full e2e suite (232/232).
- [x] Trigger `change-reporter` to update the ledger/report.

---

## 3. Chronological Progress Log
- **2026-10-05:** Roadmap initialized. Reconnaissance found the spec's
  `#practice-panel` / `startPracticeSession` / `state.answers = {}` do not match
  the codebase; real artefacts are `#practicePanel`, `enterPractice()`, and an
  array-valued `state.answers`.
- **2026-10-05:** Phase 1 done — checkbox added to `#practicePanel`, `.practice-option`
  CSS added using theme variables.
- **2026-10-05:** Phase 2 done — `practice-order.js` created; `app.js` now imports
  `shuffledOrder` instead of defining it locally.
- **2026-10-05:** Phase 3 done — `enterPractice` reads the toggle and delegates to
  `orderPracticeQuestions`; `normalizePracticeQuestions` now emits `position`.
- **2026-10-05:** Phase 4 done — `node --check` OK on both files; e2e 232 passed /
  0 failed (24 new assertions in Step 24).

## 4. Blockers & Architectural Decisions
- **Decision:** The student SPA is a browser module (top-level `boot()` touches
  the DOM), so the ordering logic is extracted into a dependency-free
  `student/practice-order.js` and imported by both `app.js` and the e2e test.
  This tests the SHIPPED code rather than a copy of it.
- **Decision:** `state.answers` stays an array. The task text suggested `{}`, but
  `makeEmptyAnswer` + `state.answers[index]` indexing require an array. This is a
  pre-existing invariant unrelated to ordering, so it was left untouched.
- **Decision:** `normalizePracticeQuestions` keeps a derived `position`
  (source ordinal) so the non-shuffle branch can enforce original order.
- **Decision:** Shuffle does NOT renumber `position` and needs no key remap:
  practice grading reads `question.correctAnswer` off the object, so reordering
  the array cannot desync the key, and practice submits nothing to the server.
- **Decision:** The existing Phase 5.8 official-exam shuffle is unaffected — it
  still keeps `state.displayOrder` so answers re-map onto `position ASC` on
  submit. Only the permutation primitive was de-duplicated.
