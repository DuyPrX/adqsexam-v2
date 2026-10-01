import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExamRow, ExtractedQuestion, RosterEntry } from './types';
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
      })
      .select('id, user_id, code, title, duration_minutes, is_active, created_at')
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
  const { title, durationMinutes, questions } = input;

  if (!title.trim()) throw new PersistenceError('Vui lòng nhập tên đề thi.');
  if (questions.length === 0) throw new PersistenceError('Đề thi chưa có câu hỏi nào.');

  const userId = await requireUserId(supabase);
  const exam = await insertExamWithFreshCode(supabase, userId, title.trim(), durationMinutes);

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

/** Fetches every exam owned by the current teacher, newest first. */
export async function listExams(supabase: SupabaseClient): Promise<ExamRow[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('id, user_id, code, title, duration_minutes, is_active, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new PersistenceError(`Không tải được danh sách đề: ${error.message}`);
  return data ?? [];
}

/** Submission counts per exam code, used by the dashboard table. */
export async function countResultsByExam(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('exam_results').select('exam_code');
  if (error) throw new PersistenceError(`Không tải được số bài nộp: ${error.message}`);

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const code = (row as { exam_code: string }).exam_code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}
