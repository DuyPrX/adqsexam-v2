/**
 * ADQS Exam v2 — exam navigation + theme/font preference logic (Phase 8.5)
 * =====================================================================
 * Dependency-free and DOM-free on purpose: the student SPA imports it for the
 * live UI, and `tests/e2e_flow_verification.mjs` imports the SAME module to
 * assert the behaviour headlessly (there is no jsdom in the toolchain). Mirrors
 * the `practice-order.js` precedent.
 *
 * Everything here is a pure function of its arguments — the persisted
 * preferences are read/written through an injected `storage` (the real
 * `localStorage` in the browser, a stub in tests) so nothing reaches for a
 * global.
 */

/** Theme cycle order for the "Giao diện" button. */
export const THEME_CYCLE = ['light', 'dark', 'sepia'];

/** Font-size ladder: base (16px) -> lg (18px) -> xl (20px). */
export const FONT_CYCLE = ['base', 'lg', 'xl'];

/**
 * The confirmation beat before the auto-advance jump.
 *
 * 280ms is the sweet spot for this action: long enough that the eye registers
 * the selection highlight as a direct result of the tap (below ~200ms it reads
 * as a flicker and students double-tap), yet short enough that a confident
 * student flowing through 40 questions never feels throttled.
 */
export const AUTO_ADVANCE_MS = 280;

/** `localStorage` key for the auto-advance preference. */
export const AUTO_ADVANCE_KEY = 'adqs_auto_advance';

/** `localStorage` key for the theme choice. */
export const THEME_KEY = 'adqs_student_theme';

/** `localStorage` key for the font-size choice. */
export const FONT_KEY = 'adqs_student_font';

/** Resolves the effective theme, falling back to the OS preference. */
export function normalizeTheme(theme, prefersDark) {
  if (theme === 'light' || theme === 'dark' || theme === 'sepia') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** Cycles to the next theme: light -> dark -> sepia -> light. */
export function nextTheme(current) {
  const start = THEME_CYCLE.includes(current) ? current : 'light';
  return THEME_CYCLE[(THEME_CYCLE.indexOf(start) + 1) % THEME_CYCLE.length];
}

/** Cycles to the next font step: base -> lg -> xl -> base. */
export function nextFontStep(current) {
  const start = FONT_CYCLE.includes(current) ? current : 'base';
  return FONT_CYCLE[(FONT_CYCLE.indexOf(start) + 1) % FONT_CYCLE.length];
}

/**
 * Clamps a question index into `[0, total - 1]`.
 *
 * A zero-question exam (or garbage input) collapses to 0 rather than a negative
 * or out-of-range index, so `goToQuestion()` can never blank the screen.
 */
export function clampQuestionIndex(index, total) {
  const last = Math.max(0, (Number(total) || 0) - 1);
  const n = Math.trunc(Number(index));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, n), last);
}

/**
 * Whether selecting an answer should schedule the auto-advance jump.
 *
 * - `enabled`    — the student's "Tự chuyển câu" preference.
 * - `currentIndex` / `total` — there must be somewhere to advance TO.
 * - `type`       — only discrete choices auto-advance. Text answers (ESSAY /
 *                  SHORT) never do: the student is mid-typing and a jump 280ms
 *                  after a keystroke would be hostile.
 * - `answer`     — a TRUE_FALSE question has several sub-statements; advancing
 *                  while some are blank would silently lose them, so it waits
 *                  for EVERY one.
 * - `changed`    — re-tapping the current choice must not move a student who was
 *                  re-reading the question.
 */
export function shouldAutoAdvance({ enabled, currentIndex, total, type, answer, changed = true }) {
  if (!enabled) return false;
  if (!changed) return false;
  if (currentIndex >= total - 1) return false;
  if (type === 'TRUE_FALSE') {
    const draft = answer && answer.draft;
    return Array.isArray(draft) && draft.length > 0 && draft.every((value) => value !== '');
  }
  return type === 'MCQ';
}

/**
 * Reads the auto-advance preference.
 *
 * Defaults to ON: the whole point of the feature is a student flowing through the
 * paper without touching "next", so a missing value must mean enabled — hence
 * `!== 'false'` rather than `=== 'true'`.
 */
export function readAutoAdvancePreference(storage) {
  try { return storage.getItem(AUTO_ADVANCE_KEY) !== 'false'; } catch { return true; }
}

/** Persists the auto-advance preference. */
export function writeAutoAdvancePreference(storage, enabled) {
  try { storage.setItem(AUTO_ADVANCE_KEY, enabled ? 'true' : 'false'); } catch { /* ignore */ }
}

/**
 * Builds the palette cell model — the data `renderPalette()` paints.
 *
 * Returned as plain descriptors (not DOM nodes) so the cell count, roles and
 * legend precedence are assertable without a browser.
 *
 * @param {object}   input
 * @param {number}   input.total         Number of questions (grid size).
 * @param {boolean[]} input.answered     Parallel to questions; true = answered.
 * @param {Iterable<number>} input.flags Flagged question indices.
 * @param {number}   input.currentIndex  The current question (focus ring).
 * @returns {{index:number,label:string,answered:boolean,flagged:boolean,current:boolean,answeredCount:number}[]}
 */
export function buildPaletteCells({ total, answered, flags, currentIndex }) {
  const count = Math.max(0, Number(total) || 0);
  const answeredList = Array.isArray(answered) ? answered : [];
  const flagSet = flags instanceof Set ? flags : new Set(flags || []);
  const cells = [];

  for (let index = 0; index < count; index += 1) {
    cells.push({
      index,
      label: String(index + 1),
      answered: answeredList[index] === true,
      flagged: flagSet.has(index),
      current: index === currentIndex,
    });
  }

  // The header count is the number ANSWERED, not the number of cells — an
  // answered+flagged cell is one question, not two.
  const answeredCount = cells.filter((cell) => cell.answered).length;
  return Object.assign(cells, { answeredCount });
}
