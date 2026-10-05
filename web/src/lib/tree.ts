import type { SupabaseClient } from '@supabase/supabase-js';
import { PersistenceError } from './exams';
import type { TreeSessionDetail, TreeSessionRow, TreeSubmissionRow } from './types';

/**
 * Tree of Knowledge persistence (Phase 7.3) for `public.tree_sessions` /
 * `public.tree_submissions` (schema created in Phase 7.1).
 *
 * Every statement relies on RLS rather than an explicit ownership filter:
 * `tree_sessions_owner_all` scopes a session to `auth.uid() = user_id`, and
 * `tree_submissions_teacher_read` scopes submissions to the session owner. The
 * client therefore sends `user_id` only on insert (the column is NOT NULL and
 * RLS validates rather than fills it), exactly like `classes.ts`.
 */

/**
 * Canonical `tree_sessions` column list.
 *
 * Centralised for the same reason as `EXAM_COLUMNS`: `select('*')` would make a
 * future column appear at runtime while TypeScript still believes the row has
 * the old shape, and the projector's countdown/seed both key off these fields.
 */
export const TREE_SESSION_COLUMNS =
  'id, user_id, class_id, title, question_text, min_words, time_limit_minutes, max_similarity, tree_seed, is_active, created_at, ended_at';

/** Canonical `tree_submissions` column list (the renderer consumes every field). */
export const TREE_SUBMISSION_COLUMNS =
  'id, session_id, student_code, student_name, answer_text, word_count, submitted_at, fruit_index';

/** Defaults surfaced by the creation modal, mirrored here so both agree. */
export const TREE_SESSION_DEFAULTS = {
  minWords: 20,
  timeLimitMinutes: 45,
  maxSimilarity: 0.6,
} as const;

/** Inclusive slider bounds for `max_similarity` (the modal shows 30%–80%). */
export const TREE_SIMILARITY_MIN = 0.3;
export const TREE_SIMILARITY_MAX = 0.8;

async function requireUserId(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new PersistenceError('Phiên đăng nhập đã hết hạn.');
  return user.id;
}

export interface CreateTreeSessionParams {
  class_id: string;
  title: string;
  question_text: string;
  min_words: number;
  time_limit_minutes: number;
  max_similarity: number;
}

/**
 * Creates a tree session.
 *
 * `tree_seed` is deliberately NOT sent: the column default
 * (`floor(random() * 1000000)`) mints it server-side, which guarantees a unique
 * seed per session even across two sessions created in the same millisecond —
 * a client-generated seed could collide and make two trees look identical.
 */
export async function createTreeSession(
  supabase: SupabaseClient,
  params: CreateTreeSessionParams,
): Promise<TreeSessionRow> {
  const title = params.title.trim();
  const question = params.question_text.trim();

  if (!params.class_id) throw new PersistenceError('Vui lòng chọn lớp học.');
  if (!title) throw new PersistenceError('Vui lòng nhập tiêu đề hoạt động.');
  if (!question) throw new PersistenceError('Vui lòng nhập câu hỏi thảo luận.');

  const minWords = Math.max(1, Math.trunc(params.min_words));
  const timeLimit = Math.max(1, Math.trunc(params.time_limit_minutes));
  // Guard here as well as in the modal: Phase 7.1's CHECK rejects <= 0 or > 1,
  // and a rejection would surface as an opaque constraint error rather than a
  // message the teacher can act on.
  if (!(params.max_similarity > 0 && params.max_similarity <= 1)) {
    throw new PersistenceError('Ngưỡng trùng lặp phải nằm trong khoảng 0%–100%.');
  }

  const userId = await requireUserId(supabase);
  const { data, error } = await supabase
    .from('tree_sessions')
    .insert({
      user_id: userId,
      class_id: params.class_id,
      title,
      question_text: question,
      min_words: minWords,
      time_limit_minutes: timeLimit,
      max_similarity: params.max_similarity,
    })
    .select(TREE_SESSION_COLUMNS)
    .single<TreeSessionRow>();

  if (error) {
    // 23503 = foreign_key_violation: the class was deleted (or belongs to
    // another teacher and RLS hid it) between opening the modal and submitting.
    if (error.code === '23503') {
      throw new PersistenceError('Lớp học không còn tồn tại. Vui lòng chọn lớp khác.');
    }
    throw new PersistenceError(`Không tạo được hoạt động: ${error.message}`);
  }
  return data;
}

/** Shape of the PostgREST-embedded class aggregate. */
interface TreeSessionWithClass extends TreeSessionRow {
  classes?: { name: string; class_members?: Array<{ count: number }> } | null;
}

/**
 * Loads one session with the class context the projector needs.
 *
 * `classes!inner(...)` fetches the class name and — critically — `N`, the class
 * size, in the SAME round-trip. `N` is the participation denominator, so a
 * second query would make the projector paint an incomplete tree on first load.
 */
export async function getTreeSession(
  supabase: SupabaseClient,
  id: string,
): Promise<TreeSessionDetail | null> {
  const { data, error } = await supabase
    .from('tree_sessions')
    .select(`${TREE_SESSION_COLUMNS}, classes!inner(name, class_members(count))`)
    .eq('id', id)
    .maybeSingle<TreeSessionWithClass>();

  if (error) throw new PersistenceError(`Không tải được hoạt động: ${error.message}`);
  if (!data) return null;

  const { classes, ...session } = data;
  return {
    ...session,
    class_name: classes?.name ?? '',
    // Floor at 1: the engine divides by N, and an empty roster would otherwise
    // yield Infinity/NaN for the participation ratio.
    total_students: Math.max(classes?.class_members?.[0]?.count ?? 0, 1),
  };
}

/** Loads every submission for a session, ordered by fruit ordinal. */
export async function getTreeSubmissions(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<TreeSubmissionRow[]> {
  const { data, error } = await supabase
    .from('tree_submissions')
    .select(TREE_SUBMISSION_COLUMNS)
    .eq('session_id', sessionId)
    .order('fruit_index', { ascending: true });

  if (error) throw new PersistenceError(`Không tải được câu trả lời: ${error.message}`);
  return (data ?? []) as TreeSubmissionRow[];
}

/**
 * Closes a session early (sets `is_active = false`).
 *
 * `ended_at` is stamped client-side rather than left to a trigger so the
 * projector's "kết thúc lúc" display has a value immediately; `is_active` is the
 * authoritative switch `submit_tree_answer` reads.
 */
export async function endTreeSession(
  supabase: SupabaseClient,
  id: string,
): Promise<TreeSessionRow> {
  const { data, error } = await supabase
    .from('tree_sessions')
    .update({ is_active: false, ended_at: new Date().toISOString() })
    .eq('id', id)
    .select(TREE_SESSION_COLUMNS)
    .maybeSingle<TreeSessionRow>();

  if (error) throw new PersistenceError(`Không kết thúc được hoạt động: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy hoạt động để kết thúc.');
  return data;
}
