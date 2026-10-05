/**
 * ADQS Exam v2 — Tree of Knowledge answer normalisation (Phase 7.4)
 * =====================================================================
 * The student-side twin of `submit_tree_answer`'s word counting. Kept in its own
 * dependency-free module — the same pattern as `practice-order.js` — so the e2e
 * suite exercises the code the browser actually runs instead of a copy, and so a
 * drift from the RPC's rule shows up as a failing assertion rather than as a
 * student whose counter says "20 từ" while the server says 19.
 *
 * THE SERVER'S RULE (Phase 7.1, submit_tree_answer):
 *     v_clean_text := regexp_replace(trim(coalesce(p_answer_text, '')), '\s+', ' ', 'g');
 *     v_word_count := case when v_clean_text = '' then 0
 *                          else cardinality(string_to_array(v_clean_text, ' ')) end;
 *
 * i.e. collapse every whitespace run (spaces, tabs, newlines) to a single space,
 * trim the ends, then count space-separated tokens. An all-whitespace or empty
 * answer counts as 0 — not 1 — which is why the empty case is handled explicitly
 * rather than falling out of `split(' ')`.
 */

/**
 * Collapses whitespace and trims, matching the RPC's `regexp_replace(..., '\s+')`.
 *
 * The server also normalises the stored text this way, so returning it here lets
 * the client preview exactly what will be persisted.
 */
export function normalizeAnswerText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Counts words the way `submit_tree_answer` does.
 *
 * Empty/whitespace-only input is 0, not 1: `''.split(' ')` yields `['']`, which
 * would otherwise read as one "word" and let a blank answer pass a 1-word gate.
 */
export function countTreeWords(text) {
  const normalized = normalizeAnswerText(text);
  if (normalized === '') return 0;
  return normalized.split(' ').length;
}

/**
 * Builds the Vietnamese counter label, e.g. `12 / 20 từ (Cần thêm 8 từ)`.
 *
 * `words >= minWords` produces the met-state copy so the caller only has to check
 * one boolean for styling.
 */
export function treeWordCounterLabel(words, minWords) {
  const required = Math.max(1, Number(minWords) || 1);
  if (words >= required) return `${words} / ${required} từ ✓`;
  return `${words} / ${required} từ (Cần thêm ${required - words} từ)`;
}
