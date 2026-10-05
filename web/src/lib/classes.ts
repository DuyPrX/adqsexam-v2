import type { SupabaseClient } from '@supabase/supabase-js';
import { PersistenceError } from './exams';
import type { ClassMemberInput, ClassMemberRow, ClassRow } from './types';

/**
 * Class roster persistence (Phase 6.2) for `public.classes` /
 * `public.class_members` (created in Phase 6.1).
 *
 * Every write relies on RLS: `classes_owner_all` scopes a class to
 * `auth.uid() = user_id`, and `class_members_owner_all` scopes a member through
 * its parent class. The client therefore never sends `user_id` for members and
 * only sends it on a class insert (the column is NOT NULL and RLS validates
 * rather than fills it).
 */

/** Columns read for a class row. */
const CLASS_COLUMNS = 'id, user_id, name, academic_year, created_at, updated_at';
const MEMBER_COLUMNS = 'id, class_id, student_code, full_name, dob, pin, team_number, created_at';

/** Shape of the nested aggregate `class_members(count)`. */
interface ClassRowWithCount extends ClassRow {
  class_members?: Array<{ count: number }>;
}

async function requireUserId(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new PersistenceError('Phiên đăng nhập đã hết hạn.');
  return user.id;
}

/**
 * Lists the teacher's classes, newest first, with a member count.
 *
 * `class_members(count)` is a PostgREST nested aggregate: it returns
 * `[{ count: n }]` in the SAME round-trip, avoiding a per-class count query
 * (which would be N+1 against the number of classes).
 */
export async function listClasses(supabase: SupabaseClient): Promise<ClassRow[]> {
  const { data, error } = await supabase
    .from('classes')
    .select(`${CLASS_COLUMNS}, class_members(count)`)
    .order('created_at', { ascending: false });

  if (error) throw new PersistenceError(`Không tải được danh sách lớp: ${error.message}`);

  return ((data ?? []) as ClassRowWithCount[]).map((row) => {
    const { class_members: members, ...rest } = row;
    return { ...rest, member_count: members?.[0]?.count ?? 0 };
  });
}

/** Creates a class. `(user_id, name)` is unique, so a duplicate is reported clearly. */
export async function createClass(
  supabase: SupabaseClient,
  name: string,
  academicYear: string,
): Promise<ClassRow> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new PersistenceError('Vui lòng nhập tên lớp.');

  const userId = await requireUserId(supabase);
  const { data, error } = await supabase
    .from('classes')
    .insert({
      user_id: userId,
      name: trimmedName,
      academic_year: academicYear.trim() || '2026-2027',
    })
    .select(CLASS_COLUMNS)
    .single<ClassRow>();

  if (error) {
    // 23505 = unique_violation on classes_user_name_uniq.
    if (error.code === '23505') {
      throw new PersistenceError(`Lớp "${trimmedName}" đã tồn tại.`);
    }
    throw new PersistenceError(`Không tạo được lớp: ${error.message}`);
  }
  return data;
}

/** Deletes a class; `class_members.class_id` cascades. */
export async function deleteClass(supabase: SupabaseClient, classId: string): Promise<void> {
  const { data, error } = await supabase
    .from('classes')
    .delete()
    .eq('id', classId)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw new PersistenceError(`Không xóa được lớp: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy lớp để xóa.');
}

/** Loads one class's members, ordered by student code. */
export async function listClassMembers(
  supabase: SupabaseClient,
  classId: string,
): Promise<ClassMemberRow[]> {
  const { data, error } = await supabase
    .from('class_members')
    .select(MEMBER_COLUMNS)
    .eq('class_id', classId)
    .order('student_code', { ascending: true });

  if (error) throw new PersistenceError(`Không tải được danh sách học sinh: ${error.message}`);
  return (data ?? []) as ClassMemberRow[];
}

export interface SaveClassMembersSummary {
  saved: number;
}

/**
 * Upserts roster rows into a class.
 *
 * `(class_id, student_code)` is unique, and re-importing a corrected file is a
 * normal teacher action, so duplicates UPDATE rather than fail.
 */
export async function saveClassMembers(
  supabase: SupabaseClient,
  classId: string,
  members: ClassMemberInput[],
): Promise<SaveClassMembersSummary> {
  if (members.length === 0) throw new PersistenceError('Danh sách học sinh trống.');

  const rows = members.map((member) => ({
    class_id: classId,
    student_code: member.student_code,
    full_name: member.full_name,
    dob: member.dob,
    pin: member.pin,
    // Phase 8.4 — the parser always assigns a team (explicit or round-robin).
    team_number: member.team_number,
  }));

  const { error } = await supabase
    .from('class_members')
    .upsert(rows, { onConflict: 'class_id,student_code', ignoreDuplicates: false });

  if (error) throw new PersistenceError(`Không lưu được danh sách học sinh: ${error.message}`);
  return { saved: rows.length };
}

/** Removes one member from a class. */
export async function deleteClassMember(
  supabase: SupabaseClient,
  memberId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('class_members')
    .delete()
    .eq('id', memberId)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw new PersistenceError(`Không xóa được học sinh: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy học sinh để xóa.');
}

/**
 * Copies class rosters into an exam's whitelist via the Phase 6.1 RPC.
 *
 * The RPC is SECURITY DEFINER and re-checks exam ownership server-side; it
 * RAISES (rather than returning a code) on an unauthorized/unknown exam, so the
 * error is surfaced verbatim. Returns the number of rows inserted/updated.
 */
export async function importClassToExam(
  supabase: SupabaseClient,
  examCode: string,
  classIds: string[],
): Promise<number> {
  if (classIds.length === 0) return 0;

  const { data, error } = await supabase.rpc('import_class_to_exam', {
    p_exam_code: examCode,
    p_class_ids: classIds,
  });

  if (error) {
    // The RPC's own RAISE message is far more useful than the PostgREST wrapper.
    if (error.message.includes('UNAUTHORIZED_OR_EXAM_NOT_FOUND')) {
      throw new PersistenceError('Không tìm thấy đề thi hoặc bạn không có quyền truy cập.');
    }
    throw new PersistenceError(`Không nạp được danh sách lớp: ${error.message}`);
  }

  return Number(data) || 0;
}
