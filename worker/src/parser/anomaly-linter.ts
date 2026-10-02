/**
 * Phase 5.6 §2 — Smart-fallback anomaly linter.
 *
 * `mode=auto` used to fall back to Engine 2 only when the rule engine produced
 * zero questions or no answer keys at all. That misses the far more common
 * failure: the rule engine returns a *plausible-looking* set that is subtly
 * wrong — a True/False section silently swallowed as MCQ, or an answer block
 * that leaked into the question text.
 *
 * This linter inspects the rule output and the raw text together and decides
 * whether Engine 2 should be given a chance. It is deliberately conservative:
 * a false positive costs one AI call, whereas a false negative ships corrupted
 * questions to a teacher who may not notice.
 */

import type { ExtractedQuestion } from '../types';

/** Minimal contract the linter needs from an engine run. */
export interface ParseResult {
  questions: ExtractedQuestion[];
}

export interface AnomalyVerdict {
  shouldFallback: boolean;
  reason?: string;
}

/**
 * Detection threshold for "too few answers".
 *
 * Ministry papers routinely leave a handful of questions unkeyed, so requiring
 * 100% would trigger a needless AI call on almost every real upload. Below
 * 65%, however, the document is more likely mis-parsed than genuinely unkeyed.
 */
const MIN_ANSWER_RATIO = 0.65;

/** Document hint patterns. */
const TRUE_FALSE_HINT = /(?:đúng\s*[-/]?\s*sai|phần\s*(?:ii|2)[\s.:])/i;

/**
 * True when the document plainly declares a True/False section.
 *
 * Matches both the subject-matter phrasing ("đúng sai", "đúng/sai") and the
 * section numbering ("PHẦN II", "PHẦN 2"), so a document that names Part II but
 * yields no TRUE_FALSE question is caught regardless of spelling.
 *
 * Exported so the Worker can report the same finding in its response meta; that
 * lets the teacher UI warn about a missed section even in `mode=rule`, where no
 * fallback runs and the linter itself never gets to act.
 */
export function documentDeclaresTrueFalse(rawText: string): boolean {
  return TRUE_FALSE_HINT.test(rawText);
}

/** A raw answer marker that survived into student-visible text. */
const ANSWER_LEAK = /đáp\s*án\s*[:;]/i;

/**
 * Inspect a rule-engine run and report whether Engine 2 should take over.
 *
 * @param rawText marked-up preprocessor output (same text the rule engine saw)
 * @param ruleResult the rule engine's parsed questions
 */
export function detectParsingAnomalies(rawText: string, ruleResult: ParseResult): AnomalyVerdict {
  // 1. Zero questions extracted.
  if (!ruleResult.questions || ruleResult.questions.length === 0) {
    return { shouldFallback: true, reason: 'NO_QUESTIONS_FOUND' };
  }

  // 2. Low answer density.
  const answered = ruleResult.questions.filter(
    (question) => question.correct_answer !== null && question.correct_answer !== undefined,
  );
  if (answered.length / ruleResult.questions.length < MIN_ANSWER_RATIO) {
    return { shouldFallback: true, reason: 'LOW_ANSWER_RATIO' };
  }

  // 3. Structural type mismatch: a True/False section was declared but nothing
  //    was classified as TRUE_FALSE.
  const hasTfKeyword = TRUE_FALSE_HINT.test(rawText);
  const tfCount = ruleResult.questions.filter(
    (question) => question.question_type === 'TRUE_FALSE',
  ).length;
  if (hasTfKeyword && tfCount === 0) {
    return { shouldFallback: true, reason: 'MISSED_TRUE_FALSE_SECTION' };
  }

  // 4. Leaked answer block: an "đáp án:" marker survived into the payload.
  const hasAnswerLeak = ruleResult.questions.some(
    (question) =>
      ANSWER_LEAK.test(question.question_text) ||
      question.options.some((option) => ANSWER_LEAK.test(option)),
  );
  if (hasAnswerLeak) {
    return { shouldFallback: true, reason: 'ANSWER_TEXT_LEAK' };
  }

  return { shouldFallback: false };
}
