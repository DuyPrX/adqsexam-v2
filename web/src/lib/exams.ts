import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExamRow, ExtractedQuestion, QuestionBankRow, RosterEntry } from './types';
import { generateExamCode } from './utils';

/**
 * Supabase persistence for teacher-owned data.
 *
 * Every write relies on RLS (`auth.uid() = user_id`); the client never sends a
 * user_id, it is taken from the session by RLS `with check`. The only exception
 * is the explicit `user_id` we must pass on insert, because the column is NOT
 * NULL and RLS validates rather than fills it.
 */

const UNIQUE_VIOLATION = '23505';

/**
 * Canonical `exams` column list. Centralised because every `ExamRow` consumer
 * must agree on the shape — omitting a newer column (e.g. `deleted_at`) leaves
 * it `undefined` at runtime while TypeScript still believes it is `string | null`.
 */
export const EXAM_COLUMNS =
  'id, user_id, code, title, duration_minutes, is_active, starts_at, ends_at, deleted_at, allow_practice, created_at';

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/** Current authenticated teacher id, or throws when the session is gone. */
async function requireUserId(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new PersistenceError('Phiên đăng nhập đã hết hạn.');
  return user.id;
}

/**
 * Reserves a 6-digit exam code.
 *
 * `exams.code` is globally UNIQUE, but RLS only lets a teacher *see* their own
 * rows — so an existence check cannot prove global uniqueness. We therefore try
 * to insert and retry on a unique violation (23505) instead of pre-checking.
 */
async function insertExamWithFreshCode(
  supabase: SupabaseClient,
  userId: string,
  title: string,
  durationMinutes: number,
  allowPractice: boolean,
): Promise<ExamRow> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateExamCode();
    const { data, error } = await supabase
      .from('exams')
      .insert({
        user_id: userId,
        code,
        title,
        duration_minutes: durationMinutes,
        allow_practice: allowPractice,
      })
      .select(EXAM_COLUMNS)
      .single<ExamRow>();

    if (!error && data) return data;
    if (error?.code !== UNIQUE_VIOLATION) {
      throw new PersistenceError(`Không tạo được đề thi: ${error?.message ?? 'lỗi không xác định'}`);
    }
    // Collision — try another code.
  }
  throw new PersistenceError('Không sinh được mã đề duy nhất sau 10 lần thử.');
}

export interface SaveExamInput {
  title: string;
  durationMinutes: number;
  questions: ExtractedQuestion[];
  /** Phase 5.8: let students self-practice this exam (defaults to false). */
  allowPractice?: boolean;
}

export interface SaveExamResult {
  exam: ExamRow;
  savedQuestions: number;
}

/**
 * Persists an exam and its question bank.
 *
 * Ordering matters: `question_bank.exam_id` references `exams(id)`, so the exam
 * row must exist first. `position` is written 1-based (Phase 2 contract), which
 * `get_student_exam_payload` converts to the 0-based `questionIndex` the
 * student client submits.
 */
export async function saveExam(
  supabase: SupabaseClient,
  input: SaveExamInput,
): Promise<SaveExamResult> {
  const { title, durationMinutes, questions, allowPractice = false } = input;

  if (!title.trim()) throw new PersistenceError('Vui lòng nhập tên đề thi.');
  if (questions.length === 0) throw new PersistenceError('Đề thi chưa có câu hỏi nào.');

  const userId = await requireUserId(supabase);
  const exam = await insertExamWithFreshCode(
    supabase,
    userId,
    title.trim(),
    durationMinutes,
    allowPractice,
  );

  const rows = questions.map((question, index) => ({
    user_id: userId,
    exam_id: exam.id,
    question_text: question.question_text,
    question_type: question.question_type,
    options: question.options,
    correct_answer: question.correct_answer,
    explanation: question.explanation,
    position: index + 1,
  }));

  const { error } = await supabase.from('question_bank').insert(rows);

  if (error) {
    // Do not leave a half-created exam behind if the questions failed.
    await supabase.from('exams').delete().eq('id', exam.id);
    throw new PersistenceError(`Không lưu được câu hỏi: ${error.message}`);
  }

  return { exam, savedQuestions: rows.length };
}

export interface ExamVariantInput {
  /** Pre-reserved 6-digit code for this variant. */
  code: string;
  title: string;
  questions: ExtractedQuestion[];
}

export interface SaveExamVariantsInput {
  durationMinutes: number;
  variants: ExamVariantInput[];
  /** Phase 5.8: applies to every generated variant (school-wide opt-in). */
  allowPractice?: boolean;
}

export interface SaveExamVariantsResult {
  codes: string[];
  exams: ExamRow[];
  savedQuestions: number;
}

/**
 * Batch-saves several generated variants (Phase 5.4).
 *
 * Each variant carries its own pre-generated code, so unlike `saveExam` there is
 * no code-collision retry loop — a collision surfaces as an error and the whole
 * batch is rolled back by deleting whatever was inserted, so a partially
 * successful multi-variant save can never be left behind.
 */
export async function saveExamVariants(
  supabase: SupabaseClient,
  input: SaveExamVariantsInput,
): Promise<SaveExamVariantsResult> {
  const { durationMinutes, variants, allowPractice = false } = input;

  if (variants.length === 0) throw new PersistenceError('Chưa có mã đề nào để lưu.');
  for (const variant of variants) {
    if (!variant.title.trim()) throw new PersistenceError('Vui lòng nhập tên đề thi.');
    if (variant.questions.length === 0) {
      throw new PersistenceError(`Mã đề ${variant.code} chưa có câu hỏi nào.`);
    }
  }

  const userId = await requireUserId(supabase);

  const examRows = variants.map((variant) => ({
    user_id: userId,
    code: variant.code,
    title: variant.title.trim(),
    duration_minutes: durationMinutes,
    allow_practice: allowPractice,
  }));

  const examsInsert = await supabase
    .from('exams')
    .insert(examRows)
    .select(EXAM_COLUMNS);

  if (examsInsert.error || !examsInsert.data) {
    throw new PersistenceError(
      `Không tạo được các mã đề: ${examsInsert.error?.message ?? 'lỗi không xác định'}`,
    );
  }

  const exams = examsInsert.data as ExamRow[];
  const examIdByCode = new Map(exams.map((exam) => [exam.code, exam.id]));

  const questionRows = variants.flatMap((variant) =>
    variant.questions.map((question, index) => ({
      user_id: userId,
      exam_id: examIdByCode.get(variant.code) ?? null,
      question_text: question.question_text,
      question_type: question.question_type,
      options: question.options,
      correct_answer: question.correct_answer,
      explanation: question.explanation,
      position: index + 1,
    })),
  );

  const { error } = await supabase.from('question_bank').insert(questionRows);

  if (error) {
    // Roll the batch back so no orphan exam rows survive a failed question insert.
    await supabase.from('exams').delete().in('code', variants.map((variant) => variant.code));
    throw new PersistenceError(`Không lưu được câu hỏi: ${error.message}`);
  }

  return {
    codes: variants.map((variant) => variant.code),
    exams,
    savedQuestions: questionRows.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                     */
/* -------------------------------------------------------------------------- */

export interface RosterInsertSummary {
  inserted: number;
  skipped: number;
}

/**
 * Batch-inserts a roster against an exam code.
 *
 * `students` has UNIQUE(student_code, exam_code); re-uploading a roster is a
 * normal teacher action, so duplicates are updated rather than rejected.
 */
export async function saveRoster(
  supabase: SupabaseClient,
  examCode: string,
  entries: RosterEntry[],
): Promise<RosterInsertSummary> {
  if (entries.length === 0) throw new PersistenceError('Danh sách học sinh trống.');

  await requireUserId(supabase);

  const rows = entries.map((entry) => ({
    student_code: entry.student_code,
    full_name: entry.full_name,
    class_name: entry.class_name || '—',
    exam_code: examCode,
  }));

  const { error } = await supabase
    .from('students')
    .upsert(rows, { onConflict: 'student_code,exam_code', ignoreDuplicates: false });

  if (error) throw new PersistenceError(`Không lưu được danh sách: ${error.message}`);

  return { inserted: rows.length, skipped: entries.length - rows.length };
}

/**
 * Fetches every LIVE exam owned by the current teacher, newest first.
 *
 * Wrapped in React `cache` (Phase 5.3 §3): the dashboard renders in one request
 * pass, and server components may legitimately ask for the same list more than
 * once. Without this, each call is a fresh Supabase round-trip.
 *
 * `.is('deleted_at', null)` excludes Trash items (Phase 5.5). A trashed exam is
 * still the owner's row, so RLS returns it — the filter is what keeps it out of
 * the active list.
 */
export const listExams = cache(async (supabase: SupabaseClient): Promise<ExamRow[]> => {
  const { data, error } = await supabase
    .from('exams')
    .select(EXAM_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new PersistenceError(`Không tải được danh sách đề: ${error.message}`);
  return data ?? [];
});

/** Fetches the teacher's trashed exams, most recently deleted first (Phase 5.5). */
export const listTrashedExams = cache(async (supabase: SupabaseClient): Promise<ExamRow[]> => {
  const { data, error } = await supabase
    .from('exams')
    .select(EXAM_COLUMNS)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false });

  if (error) throw new PersistenceError(`Không tải được thùng rác: ${error.message}`);
  return data ?? [];
});

/** Loads a single owned exam by code (RLS scopes the row to its owner). */
export const loadExamByCode = cache(
  async (supabase: SupabaseClient, code: string): Promise<ExamRow | null> => {
    const { data, error } = await supabase
      .from('exams')
      .select(EXAM_COLUMNS)
      .eq('code', code)
      .is('deleted_at', null)
      .maybeSingle<ExamRow>();

    if (error) throw new PersistenceError(`Không tải được đề thi: ${error.message}`);
    return data;
  },
);

/** Loads one exam's question bank, ordered by `position`. */
export const loadExamQuestions = cache(
  async (supabase: SupabaseClient, examId: string): Promise<QuestionBankRow[]> => {
    const { data, error } = await supabase
      .from('question_bank')
      .select('*')
      .eq('exam_id', examId)
      .order('position', { ascending: true });

    if (error) throw new PersistenceError(`Không tải được câu hỏi: ${error.message}`);
    return (data ?? []) as QuestionBankRow[];
  },
);

export interface ExamMetadataPatch {
  title?: string;
  durationMinutes?: number;
  isActive?: boolean;
  /** ISO string, or null to clear the bound. */
  startsAt?: string | null;
  endsAt?: string | null;
  /** Phase 5.8 practice opt-in. */
  allowPractice?: boolean;
}

/** Updates exam metadata (Phase 5.4 edit route general-info form). */
export async function updateExamMetadata(
  supabase: SupabaseClient,
  examCode: string,
  patch: ExamMetadataPatch,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new PersistenceError('Vui lòng nhập tên đề thi.');
    row.title = patch.title.trim();
  }
  if (patch.durationMinutes !== undefined) {
    if (!Number.isFinite(patch.durationMinutes) || patch.durationMinutes < 1) {
      throw new PersistenceError('Thời gian làm bài phải lớn hơn 0 phút.');
    }
    row.duration_minutes = Math.floor(patch.durationMinutes);
  }
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  if (patch.startsAt !== undefined) row.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) row.ends_at = patch.endsAt;
  if (patch.allowPractice !== undefined) row.allow_practice = patch.allowPractice;

  if (Object.keys(row).length === 0) return;

  const { data, error } = await supabase
    .from('exams')
    .update(row)
    .eq('code', examCode)
    .select('code')
    .maybeSingle<{ code: string }>();

  if (error) throw new PersistenceError(`Không lưu được thông tin đề thi: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy đề thi để cập nhật.');
}

export interface UpdateQuestionsResult {
  message: string;
  updated?: number;
  inserted?: number;
}

/**
 * Rewrites an exam's question bank through `update_exam_questions_safe`
 * (Phase 5.4). The RPC enforces the submissions guard server-side, so a
 * structural change on an exam that already has submissions is rejected here
 * with `STRUCTURAL_CHANGE_BLOCKED` rather than silently applied.
 */
export async function updateExamQuestionsSafe(
  supabase: SupabaseClient,
  examCode: string,
  questions: ExtractedQuestion[],
): Promise<UpdateQuestionsResult> {
  const { data, error } = await supabase.rpc('update_exam_questions_safe', {
    p_exam_code: examCode,
    p_questions: questions,
  });

  if (error) throw new PersistenceError(`Không lưu được câu hỏi: ${error.message}`);

  const result = data as { success: boolean; message: string; detail?: string; updated?: number; inserted?: number };
  if (!result?.success) {
    throw new PersistenceError(result?.detail ?? `Không lưu được câu hỏi (${result?.message ?? 'UNKNOWN'}).`);
  }

  return { message: result.message, updated: result.updated, inserted: result.inserted };
}

/**
 * Flips `exams.is_active` for one owned exam (Phase 5.4 quick toggle).
 *
 * Deliberately a thin update: RLS already scopes the row to its owner, and the
 * caller drives the optimistic UI, so no RPC round-trip is needed.
 * `.select('is_active')` confirms a row actually matched (a zero-row update is
 * not an error from PostgREST).
 */
export async function setExamActive(
  supabase: SupabaseClient,
  examCode: string,
  isActive: boolean,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('exams')
    .update({ is_active: isActive })
    .eq('code', examCode)
    .select('is_active')
    .maybeSingle<{ is_active: boolean }>();

  if (error) throw new PersistenceError(`Không cập nhật được trạng thái: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy đề thi để cập nhật.');
  return data.is_active;
}

/** Submission counts per exam code, used by the dashboard table. */
export const countResultsByExam = cache(
  async (supabase: SupabaseClient): Promise<Map<string, number>> => {
    const { data, error } = await supabase.from('exam_results').select('exam_code');
    if (error) throw new PersistenceError(`Không tải được số bài nộp: ${error.message}`);

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const code = (row as { exam_code: string }).exam_code;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  },
);

/* -------------------------------------------------------------------------- */
/* Lifecycle: delete / restore / purge / re-grade (Phase 5.5)                  */
/* -------------------------------------------------------------------------- */

export interface DeleteExamResult {
  action: 'hard_deleted' | 'soft_deleted' | 'already_deleted';
  message: string;
  /** Set only for `soft_deleted`: when the Trash window closes. */
  purgeAt?: string | null;
}

/**
 * Two-tier delete (Phase 5.5).
 *
 * The tier is decided server-side from the submission count, so the UI never has
 * to guess: 0 submissions wipes the exam, otherwise it moves to the 7-day Trash.
 */
export async function deleteExam(
  supabase: SupabaseClient,
  examCode: string,
): Promise<DeleteExamResult> {
  const { data, error } = await supabase.rpc('delete_exam', { p_exam_code: examCode });
  if (error) throw new PersistenceError(`Không xóa được đề thi: ${error.message}`);

  const result = data as { success: boolean; action: DeleteExamResult['action']; message: string; purge_at?: string | null };
  if (!result?.success) {
    throw new PersistenceError(result?.message ?? 'Không xóa được đề thi.');
  }

  return { action: result.action, message: result.message, purgeAt: result.purge_at ?? null };
}

/** Restores a trashed exam (Phase 5.5). The exam is left closed; re-open it explicitly. */
export async function restoreExam(supabase: SupabaseClient, examCode: string): Promise<string> {
  const { data, error } = await supabase.rpc('restore_exam', { p_exam_code: examCode });
  if (error) throw new PersistenceError(`Không khôi phục được đề thi: ${error.message}`);

  const result = data as { success: boolean; message: string };
  if (!result?.success) {
    throw new PersistenceError(result?.message ?? 'Không khôi phục được đề thi.');
  }
  return result.message;
}

/** Permanently deletes one trashed exam by purging it (Phase 5.5 "Xóa vĩnh viễn"). */
export async function purgeExamNow(supabase: SupabaseClient, examCode: string): Promise<void> {
  const { data, error } = await supabase
    .from('exams')
    .delete()
    .eq('code', examCode)
    .select('code')
    .maybeSingle<{ code: string }>();

  if (error) throw new PersistenceError(`Không xóa vĩnh viễn được: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy đề thi để xóa.');
}

/** Runs the global 7-day Trash sweep (Phase 5.5). Returns how many exams were purged. */
export async function purgeExpiredExams(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('purge_expired_exams');
  if (error) throw new PersistenceError(`Không dọn được thùng rác: ${error.message}`);
  return (data as { purged_count?: number } | null)?.purged_count ?? 0;
}

/**
 * Re-grades every submission against the current answer keys (Phase 5.5).
 * Returns how many results were rewritten.
 */
export async function recalculateExamScores(
  supabase: SupabaseClient,
  examCode: string,
): Promise<{ updatedCount: number; message: string }> {
  const { data, error } = await supabase.rpc('recalculate_exam_scores', { p_exam_code: examCode });
  if (error) throw new PersistenceError(`Không chấm lại được: ${error.message}`);

  const result = data as { success: boolean; updated_count: number; message: string };
  if (!result?.success) {
    throw new PersistenceError(result?.message ?? 'Không chấm lại được.');
  }
  return { updatedCount: result.updated_count, message: result.message };
}
