import type { ExtractedQuestion, QuestionType } from './types';
import { generateExamCode } from './utils';

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
 * Shuffles question order, keeping every TRUE_FALSE item at the END.
 *
 * Phase 8.7. A plain Fisher-Yates scatter mixes TRUE_FALSE blocks into the MCQ
 * run, which is hostile to read: a TRUE_FALSE item is a block of four
 * sub-statements that needs more room and more time than one MCQ. Grouping them
 * at the tail gives the student one continuous "judgement" section instead of
 * interrupting the fast MCQ flow.
 *
 * The two partitions are shuffled INDEPENDENTLY (not "shuffle then stable
 * partition"), so the relative order inside each group is still random — a
 * stable partition would leak the authored order within the TRUE_FALSE block.
 */
export function shufflePartitioned<T extends { question_type: QuestionType }>(
  questions: readonly T[],
): T[] {
  const nonTrueFalse: T[] = [];
  const trueFalse: T[] = [];

  for (const question of questions) {
    if (question.question_type === 'TRUE_FALSE') trueFalse.push(question);
    else nonTrueFalse.push(question);
  }

  return [...shuffleArray(nonTrueFalse), ...shuffleArray(trueFalse)];
}

/**
 * Shuffles the ordering of the questions and renumbers `position` so the saved
 * 1-based sequence stays contiguous and matches the on-screen order.
 *
 * Phase 8.7 — TRUE_FALSE questions are grouped at the end (see
 * `shufflePartitioned`).
 */
export function shuffleQuestions(
  questions: readonly ExtractedQuestion[],
): ExtractedQuestion[] {
  return shufflePartitioned(questions).map((question, index) => ({
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

/* -------------------------------------------------------------------------- */
/* Multi-variant generation with sub-sampling                                 */
/* -------------------------------------------------------------------------- */

/** Deep-enough clone: the nested `options` and `correct_answer` arrays are copied. */
function cloneQuestion(question: ExtractedQuestion): ExtractedQuestion {
  return {
    ...question,
    options: [...question.options],
    correct_answer: Array.isArray(question.correct_answer)
      ? [...question.correct_answer]
      : question.correct_answer,
  };
}

export interface ExamVariant {
  /** Unique 6-digit code reserved for this variant. */
  code: string;
  /** 1-based ordinal of the variant within the batch. */
  index: number;
  questions: ExtractedQuestion[];
}

export interface GenerateVariantsOptions {
  /** Number of exams to produce (default 1). */
  variantCount?: number;
  /** K questions drawn from the N-question pool (default N). 1 <= K <= N. */
  questionCountPerExam?: number;
  /** Shuffle MCQ options (A/B/C/D) and re-sync `correct_answer`. */
  shuffleDistractors?: boolean;
}

/**
 * Produces `variantCount` independent exams, each drawing K of the N pool
 * questions (Phase 5.4). Every variant gets:
 *   - a different random sample of the pool and a different question order,
 *   - contiguous 1-based `position` values 1..K,
 *   - a unique 6-digit exam code.
 *
 * When `shuffleDistractors` is set, MCQ options are permuted with the answer key
 * remapped so the marked option keeps pointing at the same content.
 */
export function generateExamVariants(
  questions: readonly ExtractedQuestion[],
  options: GenerateVariantsOptions = {},
): ExamVariant[] {
  const poolSize = questions.length;
  if (poolSize === 0) return [];

  const variantCount = Math.max(1, Math.floor(options.variantCount ?? 1));
  const requested = Math.floor(options.questionCountPerExam ?? poolSize);
  const k = Math.min(poolSize, Math.max(1, requested));
  const shuffleDistractors = options.shuffleDistractors ?? false;

  const usedCodes = new Set<string>();
  const nextCode = (): string => {
    let code = generateExamCode();
    while (usedCodes.has(code)) code = generateExamCode();
    usedCodes.add(code);
    return code;
  };

  const variants: ExamVariant[] = [];
  for (let variantIndex = 0; variantIndex < variantCount; variantIndex++) {
    // Sample first, THEN partition the sample: every variant still draws a
    // random K of the pool, but the drawn set is presented with its TRUE_FALSE
    // items grouped at the end (Phase 8.7).
    const sampled = shuffleArray(questions).slice(0, k);

    const prepared = shufflePartitioned(sampled).map((question, index) => {
      const cloned = cloneQuestion(question);
      const positioned: ExtractedQuestion = { ...cloned, position: index + 1 };
      return shuffleDistractors ? shuffleOptions(positioned) : positioned;
    });

    variants.push({ code: nextCode(), index: variantIndex + 1, questions: prepared });
  }

  return variants;
}
