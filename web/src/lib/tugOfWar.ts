import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TugOfWarParticipant,
  TugOfWarQuestionItem,
  TugOfWarSessionDetail,
  TugOfWarSessionRow,
  TugOfWarTeam,
} from './types';

export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export const TUG_OF_WAR_COLUMNS =
  'id, user_id, class_id, exam_id, session_code, title, status, blue_group_number, red_group_number, blue_team_name, red_team_name, question_count, duration_seconds, win_gap, freeze_seconds, questions_pool, blue_question_order, red_question_order, blue_current_idx, red_current_idx, blue_score, red_score, blue_frozen_until, red_frozen_until, joined_participants, winner, started_at, ends_at, created_at';

async function requireUserId(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new PersistenceError('Phiên đăng nhập đã hết hạn.');
  return user.id;
}

/**
 * Fisher-Yates array shuffle returning a new shuffled array.
 */
export function shuffleArray<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

/**
 * Generates two distinct permutations of 0..N-1 such that:
 * blue_order[0] !== red_order[0] when N > 1.
 */
export function generateDistinctQuestionOrders(count: number): {
  blueOrder: number[];
  redOrder: number[];
} {
  const indices = Array.from({ length: count }, (_, i) => i);
  if (count <= 1) {
    return { blueOrder: [...indices], redOrder: [...indices] };
  }

  const blueOrder = shuffleArray(indices);
  let redOrder = shuffleArray(indices);

  // Ensure first questions are distinct when count > 1
  if (redOrder[0] === blueOrder[0]) {
    // Swap redOrder[0] with any index j > 0
    const swapIdx = Math.floor(1 + Math.random() * (count - 1));
    const temp = redOrder[0];
    redOrder[0] = redOrder[swapIdx];
    redOrder[swapIdx] = temp;
  }

  return { blueOrder, redOrder };
}

export interface CreateTugOfWarParams {
  class_id: string;
  exam_id: string;
  title: string;
  blue_group_number: number;
  red_group_number: number;
  blue_team_name?: string;
  red_team_name?: string;
  question_count?: number;
  duration_seconds?: number;
  win_gap?: number;
  freeze_seconds?: number;
}

/**
 * Creates a new Tug of War session:
 * 1. Validates params (two different teams, valid count, duration).
 * 2. Fetches MCQ questions from exam's question_bank.
 * 3. Randomly samples question_count items.
 * 4. Generates non-overlapping initial question permutations for Blue and Red.
 * 5. Persists session in LOBBY state.
 */
export async function createTugOfWarSession(
  supabase: SupabaseClient,
  params: CreateTugOfWarParams,
): Promise<TugOfWarSessionRow> {
  const userId = await requireUserId(supabase);

  if (!params.class_id) throw new PersistenceError('Vui lòng chọn lớp học.');
  if (!params.exam_id) throw new PersistenceError('Vui lòng chọn đề thi.');
  if (params.blue_group_number === params.red_group_number) {
    throw new PersistenceError('Hai đội thi đấu phải thuộc hai tổ khác nhau.');
  }

  const title = (params.title || '').trim();
  if (!title) throw new PersistenceError('Vui lòng nhập tên trò chơi.');

  // Fetch MCQ questions for this exam
  const { data: rawQuestions, error: qError } = await supabase
    .from('question_bank')
    .select('id, question_text, question_type, options, correct_answer')
    .eq('exam_id', params.exam_id)
    .order('position', { ascending: true });

  if (qError) {
    throw new PersistenceError(`Không tải được câu hỏi: ${qError.message}`);
  }

  if (!rawQuestions || rawQuestions.length === 0) {
    throw new PersistenceError('Đề thi này chưa có câu hỏi nào.');
  }

  // Filter valid multiple choice questions with at least 2 options
  const eligibleQuestions = rawQuestions.filter((q) => {
    let opts = q.options;
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = [];
      }
    }
    return Array.isArray(opts) && opts.length >= 2;
  });

  if (eligibleQuestions.length === 0) {
    throw new PersistenceError('Đề thi không có câu hỏi trắc nghiệm hợp lệ để thi đấu.');
  }

  const targetCount = Math.min(
    Math.max(1, params.question_count ?? 10),
    eligibleQuestions.length,
  );

  // Sample questions randomly
  const sampled = shuffleArray(eligibleQuestions).slice(0, targetCount);

  // Normalize questions into clean pool
  const questionsPool: TugOfWarQuestionItem[] = sampled.map((q) => {
    let options: string[] = [];
    if (typeof q.options === 'string') {
      try {
        options = JSON.parse(q.options);
      } catch {
        options = [];
      }
    } else if (Array.isArray(q.options)) {
      options = (q.options as unknown[]).map(String);
    }

    let correctOption = 0;
    if (typeof q.correct_answer === 'number') {
      correctOption = q.correct_answer;
    } else if (typeof q.correct_answer === 'string') {
      const parsed = parseInt(q.correct_answer, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < options.length) {
        correctOption = parsed;
      } else {
        const letterIdx = ['A', 'B', 'C', 'D', 'E', 'F'].indexOf(
          q.correct_answer.trim().toUpperCase(),
        );
        if (letterIdx >= 0) correctOption = letterIdx;
      }
    }

    return {
      id: q.id,
      question_text: q.question_text,
      options,
      correct_option: correctOption,
    };
  });

  const { blueOrder, redOrder } = generateDistinctQuestionOrders(questionsPool.length);

  const durationSeconds = Math.max(30, params.duration_seconds ?? 120);
  const winGap = Math.max(0, params.win_gap ?? 3);
  const freezeSeconds = Math.max(0, params.freeze_seconds ?? 3);
  const blueTeamName = (params.blue_team_name || `Đội Xanh (Tổ ${params.blue_group_number})`).trim();
  const redTeamName = (params.red_team_name || `Đội Đỏ (Tổ ${params.red_group_number})`).trim();

  // Generate 6-char random PIN code
  const sessionCode = Math.random().toString(36).substring(2, 8).toUpperCase();

  const { data: session, error } = await supabase
    .from('tug_of_war_sessions')
    .insert({
      user_id: userId,
      class_id: params.class_id,
      exam_id: params.exam_id,
      session_code: sessionCode,
      title,
      status: 'LOBBY',
      blue_group_number: params.blue_group_number,
      red_group_number: params.red_group_number,
      blue_team_name: blueTeamName,
      red_team_name: redTeamName,
      question_count: questionsPool.length,
      duration_seconds: durationSeconds,
      win_gap: winGap,
      freeze_seconds: freezeSeconds,
      questions_pool: questionsPool,
      blue_question_order: blueOrder,
      red_question_order: redOrder,
      blue_current_idx: 0,
      red_current_idx: 0,
      blue_score: 0,
      red_score: 0,
      joined_participants: { blue: [], red: [] },
    })
    .select(TUG_OF_WAR_COLUMNS)
    .single<TugOfWarSessionRow>();

  if (error) {
    throw new PersistenceError(`Không thể tạo phiên Kéo Co: ${error.message}`);
  }

  return session;
}

/**
 * Loads a Tug of War session with its associated class and exam info.
 */
export async function getTugOfWarSession(
  supabase: SupabaseClient,
  sessionIdOrCode: string,
): Promise<TugOfWarSessionDetail> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('get_tug_of_war_session', {
    p_session_code: sessionIdOrCode,
  });

  if (rpcError) {
    throw new PersistenceError(`Không thể tải phiên thi đấu: ${rpcError.message}`);
  }

  if (!rpcData || !rpcData.success || !rpcData.session) {
    throw new PersistenceError(rpcData?.message || 'Phiên thi đấu không tồn tại.');
  }

  const session = rpcData.session as TugOfWarSessionRow;

  // Enrich with class and exam titles
  let className = '';
  let examTitle = '';

  const [classRes, examRes] = await Promise.all([
    supabase.from('classes').select('name').eq('id', session.class_id).maybeSingle(),
    supabase.from('exams').select('title').eq('id', session.exam_id).maybeSingle(),
  ]);

  if (classRes.data) className = classRes.data.name;
  if (examRes.data) examTitle = examRes.data.title;

  return {
    ...session,
    class_name: className,
    exam_title: examTitle,
  };
}

/**
 * Starts a Tug of War session (Transitions from LOBBY -> ACTIVE).
 */
export async function startTugOfWarSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<{ startedAt: string; endsAt: string }> {
  const { data, error } = await supabase.rpc('start_tug_of_war_session', {
    p_session_id: sessionId,
  });

  if (error) {
    throw new PersistenceError(`Không thể bắt đầu kéo co: ${error.message}`);
  }

  if (data?.success !== true) {
    throw new PersistenceError(data?.message || 'Không thể bắt đầu kéo co.');
  }

  return {
    startedAt: String(data.started_at ?? ''),
    endsAt: String(data.ends_at ?? ''),
  };
}

export interface SubmitTugOfWarAnswerParams {
  sessionCode: string;
  team: TugOfWarTeam;
  questionIdx: number;
  selectedOption: number;
  studentCode?: string;
}

export interface SubmitTugOfWarAnswerResult {
  success: boolean;
  code?: string;
  message?: string;
  is_correct?: boolean;
  team?: TugOfWarTeam;
  blue_score?: number;
  red_score?: number;
  blue_current_idx?: number;
  red_current_idx?: number;
  blue_frozen_until?: string | null;
  red_frozen_until?: string | null;
  remaining_ms?: number;
  status?: string;
  winner?: 'BLUE' | 'RED' | 'DRAW' | null;
}

/**
 * Submits an answer from a team member or projector touch/keyboard.
 */
export async function submitTugOfWarAnswer(
  supabase: SupabaseClient,
  params: SubmitTugOfWarAnswerParams,
): Promise<SubmitTugOfWarAnswerResult> {
  const { data, error } = await supabase.rpc('submit_tug_of_war_answer', {
    p_session_code: params.sessionCode,
    p_team: params.team,
    p_question_idx: params.questionIdx,
    p_selected_option: params.selectedOption,
    p_student_code: params.studentCode ?? 'BOARD',
  });

  if (error) {
    throw new PersistenceError(`Lỗi gửi đáp án: ${error.message}`);
  }

  return data as SubmitTugOfWarAnswerResult;
}

/**
 * Student joins Tug of War waiting room / lobby.
 */
export async function joinTugOfWarLobby(
  supabase: SupabaseClient,
  sessionCode: string,
  studentCode: string,
  preferredTeam?: TugOfWarTeam,
): Promise<{
  success: boolean;
  sessionId?: string;
  assignedTeam?: TugOfWarTeam;
  fullName?: string;
  title?: string;
  status?: string;
  message?: string;
}> {
  const { data, error } = await supabase.rpc('join_tug_of_war_lobby', {
    p_session_code: sessionCode,
    p_student_code: studentCode,
    p_preferred_team: preferredTeam ?? null,
  });

  if (error) {
    throw new PersistenceError(`Không thể vào phòng thi đấu: ${error.message}`);
  }

  if (data?.success !== true) {
    throw new PersistenceError(data?.message || 'Không thể tham gia phòng thi đấu.');
  }

  return {
    success: true,
    sessionId: data.session_id,
    assignedTeam: data.assigned_team as TugOfWarTeam,
    fullName: data.full_name,
    title: data.title,
    status: data.status,
    message: data.message,
  };
}
