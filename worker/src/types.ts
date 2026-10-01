/**
 * Shared contract types for the ADQS Exam v2 DOCX extractor.
 *
 * The output shape is NOT free-form: it is dictated by the Phase 1 Supabase
 * schema (v2/supabase/schema.sql) and by ARCHITECTURE_FREEZE.md (F3/D1).
 */

/** Classification vocabulary — must match the frozen Phase 2 decision. */
export type QuestionType = 'MULTIPLE_CHOICE' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'ESSAY';

/**
 * A question as persisted into `public.question_bank`.
 *
 * Column mapping (v2/supabase/schema.sql):
 *   question_text  <- question_text
 *   question_type  <- question_type
 *   options        <- options          (JSONB array of strings)
 *   correct_answer <- correct_answer   (JSONB)
 *   explanation    <- explanation
 *   position       <- position         (1-based integer)
 *
 * `correct_answer` shapes (frozen in Phase 1, Section A.2):
 *   MULTIPLE_CHOICE : integer 0-3        e.g. 2        (index into options)
 *   TRUE_FALSE      : ["Đ"|"S", x4]      e.g. ["Đ","S","Đ","S"]
 *                     options holds the four sub-item STATEMENTS.
 *   SHORT_ANSWER    : string             e.g. "3" or null when the key is absent
 *   ESSAY           : null               (never auto-graded)
 */
export interface ExtractedQuestion {
  /** 1-based ordinal within the document. */
  position: number;
  question_type: QuestionType;
  question_text: string;
  /** Option texts. For TRUE_FALSE these are the four sub-item statements. */
  options: string[];
  correct_answer: number | string[] | string | null;
  explanation: string | null;
}

/** Extraction metadata returned alongside the questions. */
export interface ExtractionMeta {
  success: boolean;
  question_count: number;
  has_answers: boolean;
}

export interface ExtractionResult extends ExtractionMeta {
  data: ExtractedQuestion[];
}

/** Engine selection. */
export type ExtractionMode = 'rule' | 'ai' | 'auto';
export type EngineUsed = 'rule' | 'ai';
