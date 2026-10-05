import type { SupabaseClient } from '@supabase/supabase-js';
import { PersistenceError } from './exams';
import type { ExamCandidateRow } from './types';

/**
 * Per-exam candidate ("thí sinh dự thi") management (Phase 8.1) for
 * `public.students` — the whitelist `verify_and_acquire_session` checks against.
 *
 * Every statement relies on RLS (`students_teacher_all`), which scopes a row
 * through the exam it belongs to (`exams.user_id = auth.uid()`); no explicit
 * ownership filter is sent from the client.
 */

/**
 * Canonical column list. Centralised so a future column cannot silently arrive
 * `undefined` while TypeScript still believes the old row shape.
 */
export const CANDIDATE_COLUMNS =
  'id, student_code, full_name, class_name, exam_code, dob, pin, created_at';

/** Fields a teacher may edit. `student_code`/`exam_code` are identity, not metadata. */
export interface CandidateUpdate {
  full_name?: string;
  class_name?: string;
  dob?: string | null;
  pin?: string | null;
}

/** Fields accepted when adding a candidate manually. */
export interface CandidateInput {
  full_name: string;
  class_name: string;
  dob?: string | null;
  pin?: string | null;
  /** Omit to auto-generate from the class name + roster ordinal. */
  student_code?: string | null;
}

/** Loads an exam's candidates, ordered by class then code (matches the picker). */
export async function listExamCandidates(
  supabase: SupabaseClient,
  examCode: string,
): Promise<ExamCandidateRow[]> {
  const { data, error } = await supabase
    .from('students')
    .select(CANDIDATE_COLUMNS)
    .eq('exam_code', examCode)
    .order('class_name', { ascending: true })
    .order('student_code', { ascending: true });

  if (error) throw new PersistenceError(`Không tải được danh sách thí sinh: ${error.message}`);
  return (data ?? []) as ExamCandidateRow[];
}

/**
 * Generates a student code for a manually added candidate.
 *
 * Mirrors the roster-import rule from Phase 6.2 (`${className}_${ordinal}`) and
 * appends a timestamp suffix when that is already taken: `(student_code,
 * exam_code)` is UNIQUE, so a collision would otherwise surface as an opaque
 * constraint error instead of a usable code.
 */
function generateStudentCode(className: string, taken: Set<string>): string {
  const base = `${className}_${String(taken.size + 1).padStart(2, '0')}`;
  if (!taken.has(base)) return base;
  // Fallback for a class whose members were imported with gaps: a short random
  // suffix keeps the code human-readable and practically collision-free.
  let candidate = `${base}_${Math.random().toString(36).slice(2, 6)}`;
  while (taken.has(candidate)) {
    candidate = `${className}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return candidate;
}

/**
 * Adds one candidate to an exam's whitelist.
 *
 * When `student_code` is omitted the code is derived from the class name and the
 * current roster size. The existing codes are read first so the generated value
 * cannot collide with an already-imported row.
 */
export async function addExamCandidate(
  supabase: SupabaseClient,
  examCode: string,
  candidate: CandidateInput,
): Promise<ExamCandidateRow> {
  const fullName = candidate.full_name.trim();
  const className = candidate.class_name.trim();
  if (!fullName) throw new PersistenceError('Vui lòng nhập họ tên học sinh.');
  if (!className) throw new PersistenceError('Vui lòng nhập lớp của học sinh.');

  let studentCode = (candidate.student_code ?? '').trim();
  if (!studentCode) {
    const { data: existing, error: existingError } = await supabase
      .from('students')
      .select('student_code')
      .eq('exam_code', examCode);

    if (existingError) {
      throw new PersistenceError(`Không đọc được danh sách hiện có: ${existingError.message}`);
    }
    const taken = new Set((existing ?? []).map((row) => String(row.student_code)));
    studentCode = generateStudentCode(className, taken);
  }

  const { data, error } = await supabase
    .from('students')
    .insert({
      exam_code: examCode,
      student_code: studentCode,
      full_name: fullName,
      class_name: className,
      dob: candidate.dob ?? null,
      pin: candidate.pin ?? null,
    })
    .select(CANDIDATE_COLUMNS)
    .single<ExamCandidateRow>();

  if (error) {
    // 23505 = unique_violation on (student_code, exam_code).
    if (error.code === '23505') {
      throw new PersistenceError(`Mã học sinh "${studentCode}" đã tồn tại trong đề thi này.`);
    }
    throw new PersistenceError(`Không thêm được học sinh: ${error.message}`);
  }
  return data;
}

/** Updates one candidate's editable fields. */
export async function updateExamCandidate(
  supabase: SupabaseClient,
  id: string,
  updates: CandidateUpdate,
): Promise<ExamCandidateRow> {
  const patch: Record<string, unknown> = {};

  if (updates.full_name !== undefined) {
    const fullName = updates.full_name.trim();
    if (!fullName) throw new PersistenceError('Họ tên học sinh không được để trống.');
    patch.full_name = fullName;
  }
  if (updates.class_name !== undefined) {
    const className = updates.class_name.trim();
    if (!className) throw new PersistenceError('Lớp của học sinh không được để trống.');
    patch.class_name = className;
  }
  // `dob`/`pin` are cleared with an explicit null, so presence is checked with
  // `!== undefined` rather than truthiness.
  if (updates.dob !== undefined) patch.dob = updates.dob;
  if (updates.pin !== undefined) patch.pin = updates.pin;

  if (Object.keys(patch).length === 0) {
    throw new PersistenceError('Không có thay đổi nào để lưu.');
  }

  const { data, error } = await supabase
    .from('students')
    .update(patch)
    .eq('id', id)
    .select(CANDIDATE_COLUMNS)
    .maybeSingle<ExamCandidateRow>();

  if (error) throw new PersistenceError(`Không cập nhật được học sinh: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy học sinh để cập nhật.');
  return data;
}

/**
 * Removes one candidate from an exam's whitelist.
 *
 * Refuses once the student has a submitted result: `exam_results` rows are the
 * permanent record of a sitting, and deleting the roster row they reference
 * would orphan the result and break the results view's identity lookup.
 */
export async function deleteExamCandidate(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { data: row, error: readError } = await supabase
    .from('students')
    .select('student_code, exam_code')
    .eq('id', id)
    .maybeSingle<{ student_code: string; exam_code: string }>();

  if (readError) throw new PersistenceError(`Không đọc được học sinh: ${readError.message}`);
  if (!row) throw new PersistenceError('Không tìm thấy học sinh để xóa.');

  const { data: result, error: resultError } = await supabase
    .from('exam_results')
    .select('id')
    .eq('exam_code', row.exam_code)
    .eq('student_code', row.student_code)
    .maybeSingle<{ id: string }>();

  if (resultError) {
    throw new PersistenceError(`Không kiểm tra được bài nộp: ${resultError.message}`);
  }
  if (result) {
    throw new PersistenceError(
      'Học sinh này đã nộp bài nên không thể xóa khỏi danh sách dự thi.',
    );
  }

  const { data, error } = await supabase
    .from('students')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw new PersistenceError(`Không xóa được học sinh: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy học sinh để xóa.');
}
