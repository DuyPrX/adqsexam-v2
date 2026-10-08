'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import { listClassMembers } from '@/lib/classes';
import { listExams } from '@/lib/exams';
import {
  brainstormTargetScore,
  buildInitialAssignments,
  countActiveMembersPerTeam,
  createTreeSession,
  TREE_SESSION_DEFAULTS,
  TREE_SIMILARITY_MAX,
  TREE_SIMILARITY_MIN,
} from '@/lib/tree';
import type {
  ClassMemberRow,
  ClassRow,
  ExamRow,
  ParticipantConfig,
  TreeGameMode,
} from '@/lib/types';
import { EMPTY_PARTICIPANT_CONFIG } from '@/lib/types';
import { TreeRosterPlanner } from './TreeRosterPlanner';

interface CreateTreeSessionModalProps {
  klass: ClassRow;
  onClose: () => void;
}

/**
 * "🌱 Bắt đầu Cây Tri Thức" launcher (Phase 7.3, extended in Phase 9.1).
 *
 * Submits then redirects straight to the projector: the teacher's next action
 * after creating a live activity is always to display it, so an intermediate
 * "created successfully" screen would only be a step to click through.
 *
 * Phase 9.1 adds the pre-flight vertical: a game-mode picker, a target score, an
 * exam selector for SPEED_QUIZ, and the roster planner that produces the
 * session's `participant_config`. The session is always created in LOBBY, so none
 * of this is committed to students until the teacher presses start on the
 * projector.
 */
export function CreateTreeSessionModal({ klass, onClose }: CreateTreeSessionModalProps) {
  const router = useRouter();
  const [title, setTitle] = useState(`Cây Tri Thức — ${klass.name}`);
  const [gameMode, setGameMode] = useState<TreeGameMode>('BRAINSTORM');
  const [question, setQuestion] = useState('');
  const [minWords, setMinWords] = useState<number>(TREE_SESSION_DEFAULTS.minWords);
  const [timeLimit, setTimeLimit] = useState<number>(TREE_SESSION_DEFAULTS.timeLimitMinutes);
  const [targetScore, setTargetScore] = useState<number>(20);
  const [examId, setExamId] = useState<string>('');
  // The slider works in whole percent; the DB stores a 0-1 numeric.
  const [similarityPercent, setSimilarityPercent] = useState(
    Math.round(TREE_SESSION_DEFAULTS.maxSimilarity * 100),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Phase 9.1 pre-flight roster ---------------------------------------
  const [members, setMembers] = useState<ClassMemberRow[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [config, setConfig] = useState<ParticipantConfig>(EMPTY_PARTICIPANT_CONFIG);
  const [exams, setExams] = useState<ExamRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await listClassMembers(createClient(), klass.id);
        if (cancelled) return;
        setMembers(loaded);
        // Phase 9.2 — seed the session's assignments from each member's NATURAL
        // team, NOT a modulo-4 split. The modal must open showing the class's
        // standing layout; re-partitioning here would silently override a split
        // the teacher already arranged. Distribution is opt-in via the planner's
        // "⚖️ Chia đều 4 cây" button.
        setConfig((current) => ({
          ...current,
          assignments: buildInitialAssignments(loaded),
        }));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof PersistenceError ? err.message : 'Không tải được danh sách học sinh.');
        }
      } finally {
        if (!cancelled) setIsLoadingMembers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [klass.id]);

  // The exam list is only needed for SPEED_QUIZ, so it is fetched lazily on the
  // first switch to that mode rather than on every modal open.
  useEffect(() => {
    if (gameMode !== 'SPEED_QUIZ' || exams.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await listExams(createClient());
        if (!cancelled) setExams(loaded);
      } catch {
        if (!cancelled) setExams([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameMode, exams.length]);

  const isSpeedQuiz = gameMode === 'SPEED_QUIZ';

  /**
   * Phase 9.2 — how many PRESENT students sit on each Cây, recomputed on every
   * absentee toggle or reassignment. Unlike `getTreeSession`'s raw `team_counts`,
   * this excludes absentees and honours the session's team overrides, which is
   * what makes a team's 100% reachable in the arena.
   */
  const activeTeamCounts = useMemo(() => {
    const roster = members.map((member) => ({
      id: member.id,
      team_number: member.team_number,
    }));
    const assignments = config.assignments;
    return countActiveMembersPerTeam(roster, { absent_ids: config.absent_ids, assignments });
  }, [members, config.absent_ids, config.assignments]);

  /**
   * Phase 9.2 — in BRAINSTORM a bout is won when the LARGEST team has had every
   * present member answer, so the target tracks `max(activeTeamCounts)`. It is
   * derived, never typed: a stale manual number would leave a team unable to
   * reach 100% (or finishing too early).
   */
  const brainstormAutoTarget = useMemo(
    () => brainstormTargetScore(activeTeamCounts),
    [activeTeamCounts],
  );

  // Phase 9.2 — keep `target_score` bound to the derived value in BRAINSTORM. The
  // effect (rather than a read-time fallback) means the value the teacher sees is
  // the value submitted, and it re-runs on every absentee/reassignment change.
  useEffect(() => {
    if (gameMode === 'BRAINSTORM') setTargetScore(brainstormAutoTarget);
  }, [gameMode, brainstormAutoTarget]);

  const canSubmit =
    !!title.trim()
    && !!question.trim()
    && (!isSpeedQuiz || !!examId)
    && !isSaving;

  const handleSubmit = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const created = await createTreeSession(createClient(), {
        class_id: klass.id,
        title,
        question_text: question,
        min_words: minWords,
        time_limit_minutes: timeLimit,
        max_similarity: similarityPercent / 100,
        game_mode: gameMode,
        exam_id: isSpeedQuiz ? examId : null,
        target_score: targetScore,
        participant_config: config,
      });
      router.push(`/tree/${created.id}`);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không tạo được hoạt động.');
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="w-full max-w-4xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">🌱 Bắt đầu Cây Tri Thức</h2>
            <p className="text-xs text-slate-500">
              Lớp {klass.name} — {klass.member_count ?? members.length} học sinh
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          {/* Phase 9.1 — game mode */}
          <div className="space-y-1">
            <span className="text-sm font-semibold text-slate-700">Chế độ thi đấu</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setGameMode('BRAINSTORM')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                  gameMode === 'BRAINSTORM'
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="block font-semibold">💡 Bão não từ khóa</span>
                <span className="text-xs text-slate-500">
                  Học sinh nhập câu trả lời tự do, cây lớn dần theo ý tưởng.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setGameMode('SPEED_QUIZ')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                  gameMode === 'SPEED_QUIZ'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-900'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="block font-semibold">⚡ Đua tốc độ trắc nghiệm</span>
                <span className="text-xs text-slate-500">
                  Trả lời nhanh các câu trắc nghiệm từ một đề có sẵn.
                </span>
              </button>
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Tiêu đề</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          {isSpeedQuiz && (
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Đề thi nguồn</span>
              <select
                value={examId}
                onChange={(event) => setExamId(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              >
                <option value="">-- Chọn đề thi --</option>
                {exams.map((exam) => (
                  <option key={exam.id} value={exam.id}>
                    {exam.title} ({exam.code})
                  </option>
                ))}
              </select>
              <span className="block text-xs text-slate-500">
                Bộ câu hỏi sẽ được lấy từ đề này khi trận đấu bắt đầu.
              </span>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">
              {isSpeedQuiz ? 'Câu hỏi hiển thị trên máy chiếu' : 'Câu hỏi thảo luận'}
            </span>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              placeholder="VD: Theo em, tri thức là gì và nó được hình thành như thế nào?"
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Số từ tối thiểu</span>
              <input
                type="number"
                min={1}
                value={minWords}
                onChange={(event) => setMinWords(Number(event.target.value))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Thời gian (phút)</span>
              <input
                type="number"
                min={1}
                value={timeLimit}
                onChange={(event) => setTimeLimit(Number(event.target.value))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>

            {/* Phase 9.1 — how many points a team must reach to win. Phase 9.2 —
                in BRAINSTORM it is DERIVED from the roster (the largest Tổ's
                present headcount) and shown read-only, because a free-text bout
                is won by everyone on a team answering exactly once. */}
            <div className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Điểm mục tiêu hoàn thành (100%)</span>
              {isSpeedQuiz ? (
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={targetScore}
                  onChange={(event) => setTargetScore(Math.max(1, parseInt(event.target.value, 10) || 20))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
                  placeholder="Ví dụ: 20"
                />
              ) : (
                <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <span>
                    Tự động theo sĩ số tổ: <strong>{brainstormAutoTarget} điểm</strong>
                  </span>
                  <span className="rounded border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-600">
                    🎯 1 câu/học sinh
                  </span>
                </div>
              )}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>Ngưỡng trùng lặp</span>
              <span className="font-mono text-slate-900">{similarityPercent}%</span>
            </span>
            <input
              type="range"
              min={Math.round(TREE_SIMILARITY_MIN * 100)}
              max={Math.round(TREE_SIMILARITY_MAX * 100)}
              step={5}
              value={similarityPercent}
              onChange={(event) => setSimilarityPercent(Number(event.target.value))}
              className="w-full accent-slate-900"
            />
            <span className="block text-xs text-slate-500">
              Câu trả lời giống hơn mức này sẽ bị coi là trùng lặp và từ chối.
            </span>
          </label>

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <TreeRosterPlanner
              members={members}
              isLoading={isLoadingMembers}
              config={config}
              onChange={setConfig}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="text-sm text-rose-700">{error}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {isSaving && <Loader2 size={15} className="animate-spin" />}
            {isSaving ? 'Đang tạo…' : 'Tạo phòng chờ'}
          </button>
        </div>
      </div>
    </div>
  );
}
