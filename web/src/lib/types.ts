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
  /**
   * Practice opt-in (Phase 5.8). When true, a rostered student may pull this
   * exam's questions WITH answer keys through `get_practice_exam_payload`
   * (self-practice by exam code). Defaults false so an official sitting leaks
   * nothing.
   */
  allow_practice: boolean;
  /**
   * Per-exam PIN policy (Phase 6.1/6.2). Defaults to 'INDIVIDUAL' server-side.
   * The CHECK constraint guarantees only these three values reach the client.
   */
  pin_mode: PinMode;
  /** Shared PIN, meaningful only when `pin_mode === 'GLOBAL'`. */
  global_pin: string | null;
  created_at: string;
}

/** Per-exam admission policy (Phase 6.1). */
export type PinMode = 'NONE' | 'GLOBAL' | 'INDIVIDUAL';

/** A teacher-owned class roster container (Phase 6.1). */
export interface ClassRow {
  id: string;
  user_id: string;
  name: string;
  academic_year: string;
  created_at: string;
  updated_at: string;
  /** Nested aggregate from `select('*, class_members(count)')`, when requested. */
  member_count?: number;
}

/** One student row inside a class roster (Phase 6.1). */
export interface ClassMemberRow {
  id: string;
  class_id: string;
  student_code: string;
  full_name: string;
  /** ISO `YYYY-MM-DD`, or null. Used as the DDMM PIN fallback. */
  dob: string | null;
  /** Explicit PIN; takes precedence over `dob`. Null = fall back to DOB. */
  pin: string | null;
  created_at: string;
}

/** A parsed roster row destined for `class_members` (Phase 6.2 CSV import). */
export interface ClassMemberInput {
  student_code: string;
  full_name: string;
  dob: string | null;
  pin: string | null;
}

/**
 * A row of `public.tree_sessions` — one "Cây tri thức" activity (Phase 7.1).
 *
 * `tree_seed` is the whole reason the tree needs no stored geometry: every
 * client feeds it to the Phase 7.2 engine and independently derives the exact
 * same tree.
 */
export interface TreeSessionRow {
  id: string;
  user_id: string;
  class_id: string;
  title: string;
  question_text: string;
  min_words: number;
  time_limit_minutes: number;
  max_similarity: number;
  tree_seed: number;
  is_active: boolean;
  created_at: string;
  ended_at: string | null;
}

/**
 * A row of `public.tree_submissions` — one student answer ("fruit").
 *
 * `submitted_at` is what the engine's vitality term averages over, and
 * `word_count` scales the fruit's radius, so all three of the engine's inputs
 * come straight off this row.
 */
export interface TreeSubmissionRow {
  id: string;
  session_id: string;
  student_code: string;
  student_name: string;
  answer_text: string;
  word_count: number;
  submitted_at: string;
  fruit_index: number;
}

/** A tree session plus the class context the projector needs (Phase 7.3). */
export interface TreeSessionDetail extends TreeSessionRow {
  class_name: string;
  /** Class size `N` — the participation denominator. */
  total_students: number;
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
