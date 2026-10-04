# Change Report: Practice Question Shuffle Toggle (Phase 5.9)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Let a student choose, per self-practice run, whether questions
  are presented in a shuffled order or kept in the original `position ASC` order.
  Applies to **both** practice sources: practice-by-code (Phase 5.8) and
  practice-by-DOCX (Phase 5.2).
- **Motivation:** Phase 5.8 mandated that practice *strictly* preserve the
  original order. That is right for reviewing "Câu 7" against the paper, but it
  makes repeated practice runs rote — the student memorises the sequence rather
  than the content. A user-controlled toggle restores re-testing value without
  touching the official-exam flow.

## 2. Technical Implementation Details

### Architecture / Core Logic

- **Shared permutation primitive.** The Fisher-Yates `shuffledOrder(n)` was
  previously a local function in `app.js`. It is now the single exported
  implementation in `student/practice-order.js`, imported by `app.js`. The
  Phase 5.8 official-exam shuffle (`applyDisplayShuffle`) now reuses it, so the
  two shuffles cannot drift apart.
- **New DOM-free ordering module.** `student/practice-order.js` exports:
  - `shuffledOrder(n)` — Durstenfeld permutation of `0..n-1`.
  - `orderPracticeQuestions(questions, shouldShuffle)` — returns a NEW array;
    when shuffling it permutes **by index** (so each element keeps its identity,
    and therefore its `correctAnswer`/`explanation`), and when not shuffling it
    sorts by `position` (so a scrambled input still yields the true source
    order). Handles `[]`, non-arrays, and single-item lists safely.
  - `readShuffleToggle(doc)` — reads `#practice-shuffle-toggle`, defaulting to
    `false` when the document or node is absent.
- **Toggle is read once, in `enterPractice()`.** Both practice source handlers
  (`startPracticeByCode`, `startPracticeByFile`) funnel into that single
  initializer, so the setting is honoured identically for both with one code path.
- **No key re-mapping is needed in practice.** Practice is graded entirely
  client-side in RAM; `gradePracticeQuestion` reads `correctAnswer` off the
  question object, so reordering the array cannot desync a key. `state.displayOrder`
  stays `null` because practice submits nothing to the server.
- **Official exam untouched.** The Phase 5.8 per-student shuffle still records
  `displayOrder` and re-maps answers onto `position ASC` on submit. Only the
  permutation primitive was de-duplicated.
- **`normalizePracticeQuestions` now emits `position`.** The mapper previously
  dropped the source ordinal, which would have made an `position`-based sort a
  no-op (all `undefined`). It now derives `position` from `raw.position ?? index + 1`,
  so the "original order" branch is meaningful for both sources.

### Database Migrations

None — Phase 5.9 is a client-only presentation change.

### API Contracts

None changed. Practice-by-code still calls `get_practice_exam_payload` exactly as
in Phase 5.8; no RPC payload or grant was touched.

## 3. Impacted Files

- `student/index.html`: Added the `#practice-shuffle-toggle` checkbox, wrapped in a
  `<label class="practice-option">` so the whole row is the click target.
- `student/styles.css`: Added `.practice-option` styles (theme-variable driven,
  `focus-within` ring, `flex: none` box) that stay aligned on desktop + mobile.
- `student/practice-order.js`: **New** — dependency-free `shuffledOrder`,
  `orderPracticeQuestions`, `readShuffleToggle`.
- `student/app.js`: Imports the shared helpers; removed the duplicate local
  `shuffledOrder`; added `state.practiceShuffle`; `enterPractice` reads the toggle
  and delegates to `orderPracticeQuestions`; `normalizePracticeQuestions` emits `position`.
- `tests/e2e_flow_verification.mjs`: Step 24 (24 assertions) importing the real module.

## 4. Verification & Testing

- **Test Commands Executed:**
  - `node --check student/app.js`
  - `node --check student/practice-order.js`
  - `node v2/tests/e2e_flow_verification.mjs`
- **Results:**
  - Both `node --check` runs report syntax OK.
  - e2e: **232 passed, 0 failed** (was 208; +24 in Step 24). Step 24 confirms:
    - OFF → exact source order, and a *scrambled* input is correctly re-sorted by `position`.
    - ON → count preserved, every question present exactly once, every
      `correctAnswer` and `explanation` still travels with its question, input not mutated.
    - ON across 60 runs → more than one distinct order (shuffle genuinely runs).
    - `shuffledOrder` is a true permutation for n ∈ {1,2,5,25}, and the n=0 / n=1 edge cases.
    - Toggle reader defaults to "no shuffle" for unchecked, missing node, and absent document.
    - Empty / non-array / single-question inputs are safe.
  - Regression: Steps 1–23 still pass, so the Phase 5.8 practice-by-code flow,
    the official payload's zero-key-leak guarantee, and the shuffled-submission
    re-mapping are all unaffected.
- **Rollback Strategy:** Revert the commit; the change is entirely client-side and
  additive. Removing `student/practice-order.js` requires restoring the local
  `shuffledOrder` in `app.js` (or reverting `app.js` wholesale). No data, schema,
  or RPC migration is involved, so rollback is risk-free for stored data.
