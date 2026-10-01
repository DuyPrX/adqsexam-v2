import type { QuestionType } from './types';

/**
 * Shared presentation helpers.
 */

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** Vietnamese labels + colour tokens for the four frozen classification types. */
export const QUESTION_TYPE_META: Record<
  QuestionType,
  { label: string; short: string; badge: string }
> = {
  MULTIPLE_CHOICE: {
    label: 'Trắc nghiệm',
    short: 'MCQ',
    badge: 'bg-blue-100 text-blue-700 ring-blue-200',
  },
  TRUE_FALSE: {
    label: 'Đúng / Sai',
    short: 'Đ/S',
    badge: 'bg-amber-100 text-amber-700 ring-amber-200',
  },
  SHORT_ANSWER: {
    label: 'Trả lời ngắn',
    short: 'TLN',
    badge: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  },
  ESSAY: {
    label: 'Tự luận',
    short: 'TL',
    badge: 'bg-purple-100 text-purple-700 ring-purple-200',
  },
};

export function isQuestionType(value: unknown): value is QuestionType {
  return (
    value === 'MULTIPLE_CHOICE' ||
    value === 'TRUE_FALSE' ||
    value === 'SHORT_ANSWER' ||
    value === 'ESSAY'
  );
}

/**
 * A question is "answered" when an auto-gradable key is present.
 * ESSAY is intentionally excluded: `submit_exam_result` never auto-grades it.
 */
export function hasResolvedAnswer(question: {
  question_type: QuestionType;
  correct_answer: unknown;
}): boolean {
  if (question.question_type === 'ESSAY') return true;
  const answer = question.correct_answer;
  if (answer === null || answer === undefined) return false;
  if (typeof answer === 'string') return answer.trim() !== '';
  if (Array.isArray(answer)) return answer.length > 0;
  return true;
}

/** 6-digit exam code, matching v1 ExamCodeService (100000-999999). */
export function generateExamCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** True when the value looks like an HTTP(S) URL (Supabase env sanity check). */
export function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
