/**
 * ADQS Exam v2 — practice question ordering (Phase 5.9)
 * =====================================================================
 * Dependency-free by design: the student SPA (`app.js`) is a browser module
 * whose top-level `boot()` touches the DOM, so it cannot be imported by a test
 * runner. Extracting the ordering logic here means the e2e suite exercises the
 * SHIPPED code rather than a copy of it.
 *
 * No DOM, no network, no state — pure functions only.
 */

/**
 * Fisher-Yates (Durstenfeld) permutation of 0..n-1.
 *
 * Returns `order` where `order[displayIndex]` is the ORIGINAL position of the
 * item shown at that slot. Shared by two callers:
 *   - the official exam's per-student display shuffle (app.js `applyDisplayShuffle`),
 *     which needs the mapping to re-map answers back onto `position ASC`;
 *   - self-practice, where the mapping is only used to reorder the questions.
 */
export function shuffledOrder(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Orders a practice question list for display.
 *
 * @param {ReadonlyArray<object>} questions  Source questions, each optionally
 *        carrying a `position` (the 1-based source ordinal).
 * @param {boolean} shouldShuffle            Student's toggle choice.
 * @returns {object[]} A NEW array — the caller's input is never mutated.
 *
 * The non-shuffle branch sorts by `position` so a caller that hands over
 * questions in the wrong order still gets the true original sequence (the
 * `?? 0` keeps questions without a position stable at the front). Shuffling the
 * ARRAY is safe for grading: `gradePracticeQuestion` reads `correctAnswer` off
 * the question object, so the key travels with its question and cannot desync.
 */
export function orderPracticeQuestions(questions, shouldShuffle) {
  const source = Array.isArray(questions) ? questions : [];
  if (source.length === 0) return [];

  if (shouldShuffle) {
    // Permute by index so elements keep their identity (and their keys).
    return shuffledOrder(source.length).map((originalIndex) => source[originalIndex]);
  }

  return source
    .slice()
    .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
}

/** Reads the practice order toggle from the DOM, defaulting to "no shuffle". */
export function readShuffleToggle(doc) {
  const node = doc ? doc.getElementById('practice-shuffle-toggle') : null;
  return node ? node.checked === true : false;
}
