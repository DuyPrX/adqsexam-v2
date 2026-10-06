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
 * item shown at that slot. Shared by:
 *   - the official exam's display permutation (`applyDisplayShuffle`), which
 *     needs the mapping to re-map answers back onto `position ASC`;
 *   - `partitionAndShuffleOrder`, which shuffles each type-partition with it.
 *
 * Phase 8.7 — the Phase 5.9 `orderPracticeQuestions()` helper was RETIRED here.
 * `partitionAndShuffleQuestions()` below is a strict superset (same shuffle-off
 * sort, same "returns a new array" contract) plus the TRUE_FALSE partition, so
 * keeping both would have left the SPA shipping one and the suite asserting the
 * other.
 */
export function shuffledOrder(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Reads the practice order toggle from the DOM, defaulting to "no shuffle". */
export function readShuffleToggle(doc) {
  const node = doc ? doc.getElementById('practice-shuffle-toggle') : null;
  return node ? node.checked === true : false;
}

/** The question-type key differs between the SPA payloads (`type`) and the
 *  teacher DB rows (`question_type`), so both are consulted. */
function questionTypeOf(question) {
  return String((question && (question.question_type || question.type)) || '').toUpperCase();
}

/**
 * Builds the display PERMUTATION for a list of question types.
 *
 * `result[displayIndex]` is the ORIGINAL index of the question shown at that
 * slot — the same convention as `shuffledOrder`, so the official sitting can
 * hand it straight to `state.displayOrder` and re-map answers back onto the
 * authored `position ASC` order the server grades against.
 *
 * This is the single source of the TRUE_FALSE-at-the-end policy: both the
 * question-reordering path and the official-exam index path go through it, so
 * the two can never drift apart.
 */
export function partitionAndShuffleOrder(types, shouldShuffle) {
  const list = Array.isArray(types) ? types : [];
  const total = list.length;
  if (total === 0) return [];
  if (!shouldShuffle) return Array.from({ length: total }, (_, index) => index);

  const standard = [];
  const trueFalse = [];
  list.forEach((type, index) => {
    if (String(type || '').toUpperCase() === 'TRUE_FALSE') trueFalse.push(index);
    else standard.push(index);
  });

  // The two partitions are shuffled INDEPENDENTLY rather than "shuffle then
  // stable partition": a stable split would preserve the authored order inside
  // the TRUE_FALSE block, leaking it to the student.
  return [
    ...shuffledOrder(standard.length).map((i) => standard[i]),
    ...shuffledOrder(trueFalse.length).map((i) => trueFalse[i]),
  ];
}

/**
 * Orders a question list for display, keeping every TRUE_FALSE at the END.
 *
 * Phase 8.7. Used for the practice path and for the official sitting when the
 * teacher left `shuffle_questions` on.
 *
 * @param {ReadonlyArray<object>} questions  Source questions, each optionally
 *        carrying a `position` (the 1-based source ordinal).
 * @param {boolean} shouldShuffle            Whether to reorder at all.
 * @returns {object[]} A NEW array — the caller's input is never mutated.
 *
 * `displayOrdinal` is stamped 1-based on the result so the palette and the
 * "Câu N" labels agree with what is on screen. The non-shuffle branch sorts by
 * `position`, so a caller handing over questions in the wrong order still gets
 * the authored sequence.
 */
export function partitionAndShuffleQuestions(questions, shouldShuffle) {
  const source = Array.isArray(questions) ? questions : [];
  if (source.length === 0) return [];

  const ordered = shouldShuffle
    ? source
    : source.slice().sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));

  return partitionAndShuffleOrder(ordered.map(questionTypeOf), shouldShuffle).map(
    (originalIndex, index) => ({ ...ordered[originalIndex], displayOrdinal: index + 1 }),
  );
}
