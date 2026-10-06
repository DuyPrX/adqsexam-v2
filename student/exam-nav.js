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

/**
 * Font-size ladder. The first step is the EMPTY STRING, not a named `base`:
 * "normal" is expressed by the ABSENCE of the `data-font` attribute so the
 * `:root` defaults apply untouched (and a stale attribute can never pin a
 * student to a value the CSS no longer defines).
 *
 * Phase 8.6 — the reading scale is 1 / 1.18 / 1.36, so the three steps are
 * visually distinct enough to be worth offering (the old 1/1.125/1.25 ladder was
 * subtle enough that students could not tell `lg` from `xl`).
 */
export const FONT_CYCLE = ['', 'lg', 'xl'];

/** Button labels for each font step, keyed by the `data-font` value. */
export const FONT_LABELS = {
  '': 'Chuẩn',
  lg: 'Lớn',
  xl: 'Rất lớn',
};

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

/** Cycles to the next font step: normal ('') -> lg -> xl -> normal. */
export function nextFontStep(current) {
  const start = FONT_CYCLE.includes(current) ? current : '';
  return FONT_CYCLE[(FONT_CYCLE.indexOf(start) + 1) % FONT_CYCLE.length];
}

/** Normalises a raw question type exactly like the SPA's `normalizeType()`. */
function normalizeQuestionType(raw) {
  const value = String(raw || '').toUpperCase();
  if (value === 'TRUE_FALSE') return 'TRUE_FALSE';
  if (value === 'SHORT_ANSWER') return 'SHORT_ANSWER';
  if (value === 'ESSAY') return 'ESSAY';
  return 'MCQ';
}

/**
 * Whether one answer slot holds a real answer.
 *
 * Mirrors the SPA's `isDraftReady()` one-for-one so the "you still have N
 * unanswered questions" warning can never disagree with the palette's answered
 * count (both would otherwise drift and one of them would be a lie).
 */
function isAnswerFilled(type, answer) {
  if (!answer || typeof answer !== 'object') return false;
  if (type === 'MCQ') return answer.draft !== null && answer.draft !== undefined;
  if (type === 'TRUE_FALSE') {
    // A partly-answered sub-statement set is NOT answered: the student would
    // lose the rest of their choices by moving on.
    return Array.isArray(answer.draft) && answer.draft.some((value) => value !== '');
  }
  return String(answer.draft == null ? '' : answer.draft).trim() !== '';
}

/**
 * Lists the questions the student has not answered yet, in paper order.
 *
 * Phase 8.6 — drives the smart submit modal: the warning lists these ordinals,
 * and "Tiếp tục làm bài" jumps to `result[0].index` (the SMALLEST unanswered
 * question), which is why the order of this array is part of the contract.
 *
 * @param {object[]} questions The paper, in display order.
 * @param {object[]} answers   Parallel answer slots (`{ draft }` each).
 * @returns {{index:number, ordinal:number}[]} `index` is 0-based, `ordinal` is
 *   the 1-based number shown to the student ("Câu 3").
 */
export function getUnansweredQuestions(questions, answers) {
  const paper = Array.isArray(questions) ? questions : [];
  const slots = Array.isArray(answers) ? answers : [];
  const unanswered = [];

  for (let index = 0; index < paper.length; index += 1) {
    const question = paper[index] || {};
    if (!isAnswerFilled(normalizeQuestionType(question.type), slots[index])) {
      unanswered.push({ index, ordinal: index + 1 });
    }
  }

  return unanswered;
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
