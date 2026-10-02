/**
 * Domain types for the ADQS Exam v2 teacher web (Phase 3).
 *
 * The extractor shape mirrors v2/worker/src/types.ts verbatim — it is dictated by
 * the Phase 1 Supabase schema (v2/supabase/schema.sql) and ARCHITECTURE_FREEZE.md.
 */

/** Classification vocabulary — frozen in Phase 2, must match the Worker exactly. */
export type QuestionType = 'MULTIPLE_CHOICE' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'ESSAY';

/** Engine selection understood by the Worker (`?mode=`). */
export type ExtractionMode = 'rule' | 'ai' | 'auto';

/** Engine that actually produced the payload. */
export type EngineUsed = 'rule' | 'ai' | 'ai_fallback';

/**
 * A question returned by the Worker and persisted into `public.question_bank`.
 *
 * `correct_answer` shapes (v2/supabase/schema.sql §A.2):
 *   MULTIPLE_CHOICE : integer 0-3       e.g. 2
 *   TRUE_FALSE      : ["Đ"|"S", x4]     e.g. ["Đ","S","Đ","S"]  (keys only)
 *                     `options` holds the four sub-item STATEMENTS.
 *   SHORT_ANSWER    : string            e.g. "3"  (null when the key was absent)
 *   ESSAY           : null              (never auto-graded)
 */
export interface ExtractedQuestion {
  /** 1-based ordinal within the document. */
  position: number;
  question_type: QuestionType;
  question_text: string;
  options: string[];
  correct_answer: number | string[] | string | null;
  explanation: string | null;
}

/** Worker response envelope (`POST /api/v1/extract`). */
export interface ExtractionResponse {
  success: boolean;
  engine_used: EngineUsed | null;
  count: number;
  data: ExtractedQuestion[];
  meta?: {
    filename: string;
    mode: ExtractionMode;
    correct_spans_detected: number;
    has_answers: boolean;
    fallback_reason: string | null;
    /** Effective AI model, or null when the rule engine produced the payload. */
    model_used?: string | null;
    /**
     * Phase 5.6: the document declares a True/False section but none was parsed.
     * Set even in `mode=rule`, where no AI fallback runs, so the UI can prompt
     * the teacher to retry with the AI engine.
     */
    missed_true_false?: boolean;
  };
  error?: { code: string; message: string };
}

/* -------------------------------------------------------------------------- */
/* Database row shapes (only the columns this app reads/writes).              */
/* -------------------------------------------------------------------------- */

export interface ExamRow {
  id: string;
  user_id: string;
  code: string;
  title: string;
  duration_minutes: number;
  is_active: boolean;
  /** Scheduling window (Phase 5.4). ISO timestamp, or null when unbounded. */
  starts_at: string | null;
  ends_at: string | null;
  /** Trash marker (Phase 5.5). ISO timestamp, or null when the exam is live. */
  deleted_at: string | null;
  created_at: string;
}

export interface QuestionBankRow {
  id: string;
  user_id: string;
  exam_id: string | null;
  question_text: string;
  question_type: string;
  options: string[];
  correct_answer: number | string[] | string | null;
  explanation: string | null;
  position: number;
  created_at: string;
}

export interface ExamResultRow {
  id: string;
  exam_code: string;
  student_code: string;
  student_name: string;
  class_name: string;
  score: number;
  total_questions: number;
  answers_json: CorrectedAnswer[];
  blur_count: number;
  fullscreen_exit_count: number;
  elapsed_seconds: number;
  needs_grading: boolean;
  submitted_at: string;
}

/**
 * One entry of `exam_results.answers_json`, as produced by `submit_exam_result`.
 * The shape varies by `type` — this union documents every branch the RPC emits.
 */
export type CorrectedAnswer =
  | { questionIndex: number; type: 'MCQ'; selectedIndex: number | null; correctIndex: number | null; isCorrect: boolean }
  | { questionIndex: number; type: 'TRUE_FALSE'; selectedAnswers: string[]; correctAnswers: string[]; isCorrect: boolean }
  | { questionIndex: number; type: 'SHORT_ANSWER'; selectedAnswerText: string; correctAnswer: string; isCorrect: boolean }
  | { questionIndex: number; type: 'ESSAY'; selectedAnswerText: string; isCorrect: boolean };

/** A roster row parsed from a teacher-supplied spreadsheet. */
export interface RosterEntry {
  student_code: string;
  full_name: string;
  class_name: string;
}

/**
 * A row of `public.active_sessions` — the live proctoring feed (Phase 5).
 *
 * One row per candidate/exam (PK is `student_code` + `exam_code`), upserted by
 * the 20s heartbeat RPC. Holds no names: the live monitor joins these against
 * `students` to display identity.
 */
export interface ActiveSessionRow {
  student_code: string;
  exam_code: string;
  session_token: string;
  last_heartbeat: string;
  current_question: number;
  answered_count: number;
  blur_count: number;
  fullscreen_exit_count: number;
  device_info: string | null;
}

/** A roster row used by the live monitor to resolve student identity. */
export interface StudentRow {
  student_code: string;
  exam_code: string;
  full_name: string;
  class_name: string;
}
