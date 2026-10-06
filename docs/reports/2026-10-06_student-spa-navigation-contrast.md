# Change Report: Student SPA — Exam Navigation, Auto-Advance & Contrast Overhaul (Phase 8.5)

- **Date:** 2026-10-06
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Overhaul the Student SPA (`v2/student/`) across the exam-taking,
  practice, result and control surfaces: (1) a high-contrast top bar and a sticky
  bottom navigation bar with auto-advance; (2) three legible themes (Light Slate,
  Dark Zinc/Navy, Eye-Care Sepia) plus a font-size ladder; (3) a bottom-sheet
  question palette with answered / unanswered / current / flagged states.
- **Root Cause / Motivation:** Two concrete defects and one UX gap.
  - **Invisible controls.** The top bar used glyph-only `.icon-btn`s rendering
    `--text-muted` on `--surface`, i.e. roughly a **1.02 contrast ratio** against
    the light page — the theme and question-list buttons effectively vanished.
  - **No reachable navigation.** `prev/next` sat in an in-flow `.action-bar` at
    the end of a long scrolling question; on a phone a student had to scroll past
    the whole question to advance.
  - **A two-step answer flow.** MCQ selection required "chọn" then "Xác nhận",
    doubling the taps per question across a 40-question paper.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Canonical design tokens.** `styles.css` now declares `--bg-app`,
    `--surface-card`, `--surface-btn(-hover)`, `--text-main`, `--border-color`,
    `--border-focus`, `--primary(-light/-hover)`, `--success(-light)`,
    `--warning(-light)` and `--shadow-sm/md` as the source of truth; the previous
    `--bg/--surface/--accent/...` names are kept only as **aliases** so every
    pre-existing rule keeps working. Each theme's pairs are chosen to clear WCAG
    AA (e.g. dark `--text-main` on `--surface-card` ≈ 15:1; sepia ≈ 11:1).
  - **Explicit button surface.** The new `.top-nav-btn` / `.btn-nav-*` /
    `.palette-cell` all set an opaque `background: var(--surface-btn)` and
    `border: 1px solid var(--border-color)`, which is the structural fix for the
    invisible-button bug — a transparent fill can no longer regress it.
  - **Auto-advance.** Selecting an MCQ (or fully answering a TRUE_FALSE) paints
    the highlight, then after **280ms** advances. Text answers never auto-advance
    (the student is mid-typing). The timer is module-scoped and every manual
    navigation cancels it, so rapid tapping cannot queue jumps.
  - **Single navigation funnel.** All paths (bottom bar, palette, keyboard,
    auto-advance) go through `goToQuestion(index)`, which clamps via
    `clampQuestionIndex()`; button/legend state is recomputed in one place.
  - **Shared, DOM-free logic module.** The test toolchain has **no jsdom**, so the
    parts of the navigation the spec asks to be *verified behaviourally* live in
    `student/exam-nav.js` — a dependency-free module the SPA imports. The suite
    therefore EXECUTES the shipped policy rather than grepping for strings
    (mirrors the existing `practice-order.js` precedent).
- **Key decisions:**
  - **The draft/confirm ("Xác nhận") step was removed**, not merely hidden. With
    immediate selection + auto-advance, a `confirmed` latch has no meaning; the
    `answers[i]` slot is now just `{ draft }`, and `isDraftReady()` still drives
    the answered count. The `.locked-note`, `.action-bar`, `#navPanel` and
    `#actionBar` markup/CSS were deleted rather than left dead.
  - **Auto-advance defaults to ON** — read as `localStorage.getItem(…) !== 'false'`
    so an absent value means enabled; the feature only works if it is the default.
  - **Theme cycle includes sepia**: `light → dark → sepia → light`, and the
    `prefers-color-scheme` block was narrowed to
    `:not([data-theme="light"]):not([data-theme="sepia"])` so an explicit sepia
    choice survives a dark-mode OS.
  - **Font size is a `--reading-scale` multiplier on the reading text only**
    (`data-font="lg|xl"`), so enlarging the font cannot overflow the fixed chrome.
- **Accessibility:** flag toggle carries `aria-pressed`; the palette's current
  cell carries `aria-current`; Escape closes the drawer; the theme button exposes
  its state through `aria-label`.

## 3. Impacted Files
- `student/exam-nav.js`: **New.** Dependency-free navigation/theme/palette logic —
  `THEME_CYCLE`, `FONT_CYCLE`, `AUTO_ADVANCE_MS`, `AUTO_ADVANCE_KEY`,
  `normalizeTheme`, `nextTheme`, `nextFontStep`, `clampQuestionIndex`,
  `shouldAutoAdvance`, `readAutoAdvancePreference`, `writeAutoAdvancePreference`,
  `buildPaletteCells`.
- `student/app.js`: Three-theme + font-height controllers; auto-advance/`maybeAutoAdvance`;
  `goToQuestion` funnel; `selectMcq`/`selectTrueFalse` drop the confirm gate;
  concrete `renderPalette`/`openPalette`/`closePalette`/`isPaletteOpen`;
  `renderActionBar` rewritten for the bottom bar; keyboard/`Enter`/`Escape`
  rework; removed `confirmAnswer`/`openNavPanel`/legacy nav panel; boot rewired.
- `student/index.html`: High-contrast header buttons (`#btn-theme-toggle`,
  `#btn-font-toggle`, `#btn-open-palette`, timer badge); `#examBottomBar` footer
  (`prev`/`next`/`finish`/flag/auto-advance checkbox); palette drawer markup;
  removed the old nav panel + action bar.
- `student/styles.css`: Canonical tokens + legacy aliases; Dark/Sepia palettes;
  `data-font` ladder; `.top-nav-btn`, `.timer-badge`, `.exam-bottom-bar`,
  `.btn-nav-*`, `.btn-primary-finish`, `.palette-drawer`, `.palette-grid`,
  `.palette-cell` + states, `.option.is-flash`; removed dead `.nav-*`/`.action-bar`/
  `.locked-note` rules.
- `tests/e2e_flow_verification.mjs`: New **Step 36** (42 assertions) over the
  executed `exam-nav.js` surface plus static markup/contrast guards.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `node --check v2/student/app.js`, `node --check v2/student/exam-nav.js`,
    `node --check v2/tests/e2e_flow_verification.mjs`.
  - `node v2/tests/e2e_flow_verification.mjs`.
- **Results:**
  - `node --check`: all three clean.
  - Full suite: **630 passed, 0 failed** (previous baseline 588 → **+42**).
  - Step 36 covers: markup presence/absence of the retired controls; the 280ms
    beat; MCQ advance / last-question refusal / toggle-off refusal /
    unchanged-selection refusal / ESSAY never / incomplete TRUE_FALSE never /
    complete TRUE_FALSE advances; preference round-trip + safe ON default + a
    throwing storage; `clampQuestionIndex` bounds; both cycles; `normalizeTheme`;
    the palette cell model (N cells, answered/flagged/current roles, co-existence,
    answered count); and the contrast tokens (`--surface-btn` in all three themes,
    explicit `background`+`border` on `.top-nav-btn`, sepia palette, `data-font`).
- **Note:** the spec's phrase "verify all buttons have explicit non-transparent
  background colors and valid CSS variables" is checked **structurally** (explicit
  `background: var(--surface-btn)` + `border: 1px solid var(--border-color)` present,
  and the tokens defined) — there is no CSS engine or jsdom in the toolchain to
  compute a rendered ratio, and this is stated rather than implied.
- **Rollback Strategy:** revert the commit; `exam-nav.js` is additive, and the
  removed markup/CSS existed only to serve the deleted confirm flow. No database
  or API surface changed, so rollback carries no data risk.
