import type { ExtractedQuestion } from './types';

/**
 * Client-side Fisher-Yates shuffle (D3: shuffle *logic* is retained in v2, only
 * the server-side DOCX/PDF *rendering* was decommissioned).
 *
 * The critical invariant: shuffling MCQ options must keep `correct_answer`
 * pointing at the same *content*. The key is an integer INDEX, so permuting the
 * option array without remapping the index would silently change the answer.
 */

/** Fisher-Yates (Durstenfeld) — unbiased, O(n), returns a new array. */
export function shuffleArray<T>(input: readonly T[]): T[] {
  const result = input.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Shuffles the ordering of the questions and renumbers `position` so the saved
 * 1-based sequence stays contiguous and matches the on-screen order.
 */
export function shuffleQuestions(
  questions: readonly ExtractedQuestion[],
): ExtractedQuestion[] {
  return shuffleArray(questions).map((question, index) => ({
    ...question,
    position: index + 1,
  }));
}

/**
 * Shuffles MCQ options while remapping `correct_answer` to the new index.
 *
 * Only MULTIPLE_CHOICE is touched:
 *   - TRUE_FALSE  : the four sub-items (a-d) are an ordered statement list; the
 *                   key array is positional, so reordering would corrupt it.
 *   - SHORT_ANSWER / ESSAY : option-less by definition.
 */
export function shuffleOptions(question: ExtractedQuestion): ExtractedQuestion {
  if (question.question_type !== 'MULTIPLE_CHOICE') return question;
  if (question.options.length < 2) return question;
  if (typeof question.correct_answer !== 'number') return question;

  const originalCorrect = question.correct_answer;
  // Build an index permutation, then apply the inverse map to the answer key.
  const order = shuffleArray(question.options.map((_, index) => index));

  const options = order.map((sourceIndex) => question.options[sourceIndex]!);
  const correct_answer = order.indexOf(originalCorrect);

  return { ...question, options, correct_answer };
}

/** Full exam shuffle: question order + option order, keys kept in sync. */
export function shuffleExam(
  questions: readonly ExtractedQuestion[],
): ExtractedQuestion[] {
  return shuffleQuestions(questions.map(shuffleOptions));
}
