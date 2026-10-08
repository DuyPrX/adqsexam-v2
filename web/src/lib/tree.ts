import type { SupabaseClient } from '@supabase/supabase-js';
import { PersistenceError } from './exams';
import { clampTeamNumber } from './tree-engine.js';
import { EMPTY_PARTICIPANT_CONFIG } from './types';
import type {
  ParticipantConfig,
  TeamCounts,
  TeamNumber,
  TreeGameMode,
  TreeSessionDetail,
  TreeSessionRow,
  TreeSubmissionRow,
} from './types';

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
 * Phase 8.4 — re-exported so callers can obtain a team's deterministic seed from
 * this module (`@/lib/tree`) alongside the rest of the tree persistence API. The
 * implementation lives in the engine, which is the single source of truth shared
 * with the student SPA.
 */
export { getTeamSeed, clampTeamNumber, TEAM_NUMBERS } from './tree-engine.js';

/** Canonical `tree_sessions` column list.
 *
 * Centralised for the same reason as `EXAM_COLUMNS`: `select('*')` would make a
 * future column appear at runtime while TypeScript still believes the row has
 * the old shape, and the projector's countdown/seed both key off these fields.
 */
export const TREE_SESSION_COLUMNS =
  'id, user_id, class_id, title, question_text, min_words, time_limit_minutes, max_similarity, tree_seed, is_active, created_at, ended_at, status, session_code, game_mode, exam_id, target_score, participant_config, started_at, ends_at';

/**
 * Canonical `tree_submissions` column list (the renderer consumes every field).
 *
 * `team_number` (Phase 8.4) is what lets the projector split one session's
 * answers into four per-team trees.
 */
export const TREE_SUBMISSION_COLUMNS =
  'id, session_id, student_code, student_name, answer_text, word_count, submitted_at, fruit_index, team_number';

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
  /** Phase 9.1 — activity type; defaults to BRAINSTORM. */
  game_mode?: TreeGameMode;
  /** Phase 9.1 — source exam for SPEED_QUIZ. */
  exam_id?: string | null;
  /** Phase 9.1 — points to win in SPEED_QUIZ; defaults to 20. */
  target_score?: number;
  /** Phase 9.1 — pre-flight roster (absent list + team overrides). */
  participant_config?: ParticipantConfig;
}

/**
 * Creates a tree session.
 *
 * `tree_seed` is deliberately NOT sent: the column default
 * (`floor(random() * 1000000)`) mints it server-side, which guarantees a unique
 * seed per session even across two sessions created in the same millisecond —
 * a client-generated seed could collide and make two trees look identical.
 *
 * Phase 9.1 — a new session is created in `status = 'LOBBY'` (the column default)
 * with `is_active = false` FORCED, so the two gates agree and students cannot
 * submit before the teacher presses start. `session_code` is likewise left to the
 * server default (a random 6-char code) — a client-chosen PIN could collide.
 */
export async function createTreeSession(
  supabase: SupabaseClient,
  params: CreateTreeSessionParams,
): Promise<TreeSessionRow> {
  const title = params.title.trim();
  const question = params.question_text.trim();
  const gameMode: TreeGameMode = params.game_mode ?? 'BRAINSTORM';

  if (!params.class_id) throw new PersistenceError('Vui lòng chọn lớp học.');
  if (!title) throw new PersistenceError('Vui lòng nhập tiêu đề hoạt động.');
  // A SPEED_QUIZ runs off a stored exam's questions, so it needs one; BRAINSTORM
  // needs a free-text prompt instead.
  if (gameMode === 'BRAINSTORM' && !question) {
    throw new PersistenceError('Vui lòng nhập câu hỏi thảo luận.');
  }
  if (gameMode === 'SPEED_QUIZ' && !params.exam_id) {
    throw new PersistenceError('Vui lòng chọn đề thi cho chế độ đua tốc độ.');
  }
  if (gameMode === 'SPEED_QUIZ' && !question) {
    throw new PersistenceError('Vui lòng nhập câu hỏi hiển thị trên máy chiếu.');
  }

  const minWords = Math.max(1, Math.trunc(params.min_words));
  const timeLimit = Math.max(1, Math.trunc(params.time_limit_minutes));
  const targetScore = Math.max(1, Math.trunc(params.target_score ?? 20));
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
      // Phase 9.1 — explicit, not left to the column default: `is_active` must be
      // false while in the lobby or a student could submit before the start.
      status: 'LOBBY',
      is_active: false,
      game_mode: gameMode,
      exam_id: gameMode === 'SPEED_QUIZ' ? params.exam_id ?? null : null,
      target_score: targetScore,
      participant_config: params.participant_config ?? EMPTY_PARTICIPANT_CONFIG,
    })
    .select(TREE_SESSION_COLUMNS)
    .single<TreeSessionRow>();

  if (error) {
    // 23503 = foreign_key_violation: the class (or exam) was deleted / belongs to
    // another teacher and RLS hid it, between opening the modal and submitting.
    if (error.code === '23503') {
      throw new PersistenceError('Lớp học hoặc đề thi không còn tồn tại. Vui lòng chọn lại.');
    }
    throw new PersistenceError(`Không tạo được hoạt động: ${error.message}`);
  }
  return data;
}

/**
 * Phase 9.1 — LOBBY -> ACTIVE.
 *
 * The RPC re-checks ownership and the LOBBY precondition server-side, so a double
 * click cannot start a bout twice and a foreign session id is refused rather than
 * silently no-op'd.
 */
export async function startTreeSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<{ startedAt: string; endsAt: string }> {
  const { data, error } = await supabase.rpc('start_tree_session', {
    p_session_id: sessionId,
  });

  if (error) throw new PersistenceError(`Không bắt đầu được trận đấu: ${error.message}`);
  if (data?.success !== true) {
    throw new PersistenceError(data?.message || 'Không bắt đầu được trận đấu.');
  }

  return {
    startedAt: String(data.started_at ?? ''),
    endsAt: String(data.ends_at ?? ''),
  };
}

/** Shape of the PostgREST-embedded class aggregate. */
interface TreeSessionWithClass extends TreeSessionRow {
  classes?: {
    name: string;
    class_members?: Array<{
      id: string;
      full_name: string;
      student_code: string;
      team_number: number | null;
    }>;
  } | null;
}

/** Tallies per-team class sizes into the `{ 1: n, 2: n, 3: n, 4: n }` shape. */
function tallyTeamCounts(members: Array<{ team_number: number | null }>): TeamCounts {
  const counts: TeamCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const member of members) {
    const team = clampTeamNumber(member.team_number) as TeamNumber;
    counts[team] += 1;
  }
  return counts;
}

/**
 * Loads one session with the class context the projector needs.
 *
 * `classes!inner(...)` fetches the class name, the per-team roster split and —
 * critically — `N`, the class size, in the SAME round-trip. `N` is the
 * participation denominator, so a second query would make the projector paint an
 * incomplete tree on first load. Phase 8.4's arena additionally needs each team's
 * own size, which is tallied from the same nested rows.
 */
export async function getTreeSession(
  supabase: SupabaseClient,
  id: string,
): Promise<TreeSessionDetail | null> {
  const { data, error } = await supabase
    .from('tree_sessions')
    .select(
      `${TREE_SESSION_COLUMNS}, classes!inner(name, class_members(id, full_name, student_code, team_number))`,
    )
    .eq('id', id)
    .maybeSingle<TreeSessionWithClass>();

  if (error) throw new PersistenceError(`Không tải được hoạt động: ${error.message}`);
  if (!data) return null;

  const { classes, ...session } = data;
  const members = classes?.class_members ?? [];
  return {
    ...session,
    class_name: classes?.name ?? '',
    // Floor at 1: the engine divides by N, and an empty roster would otherwise
    // yield Infinity/NaN for the participation ratio.
    total_students: Math.max(members.length, 1),
    team_counts: tallyTeamCounts(members),
    // Phase 9.1 — the lobby's four team cards list the actual names, so the
    // roster rides along with the session (already fetched for the tally) rather
    // than costing the projector a second round-trip on open.
    roster: members.map((member) => ({
      id: member.id,
      full_name: member.full_name,
      student_code: member.student_code,
      team_number: clampTeamNumber(member.team_number) as TeamNumber,
    })),
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
 * Closes a session early.
 *
 * `ended_at` is stamped client-side rather than left to a trigger so the
 * projector's "kết thúc lúc" display has a value immediately; `is_active` is the
 * authoritative switch `submit_tree_answer` reads.
 *
 * Phase 9.1 — `status` is set to FINISHED in the SAME statement. The two are
 * separate columns, and a partial write would leave the projector reading
 * `status` while submissions were still gated on `is_active` (or vice versa).
 */
export async function endTreeSession(
  supabase: SupabaseClient,
  id: string,
): Promise<TreeSessionRow> {
  const { data, error } = await supabase
    .from('tree_sessions')
    .update({ is_active: false, status: 'FINISHED', ended_at: new Date().toISOString() })
    .eq('id', id)
    .select(TREE_SESSION_COLUMNS)
    .maybeSingle<TreeSessionRow>();

  if (error) throw new PersistenceError(`Không kết thúc được hoạt động: ${error.message}`);
  if (!data) throw new PersistenceError('Không tìm thấy hoạt động để kết thúc.');
  return data;
}
