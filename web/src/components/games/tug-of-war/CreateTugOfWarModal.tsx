'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Clock, Flame, Loader2, Trophy, Users, X, Zap } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import { listClassMembers } from '@/lib/classes';
import { listExams } from '@/lib/exams';
import { createTugOfWarSession } from '@/lib/tugOfWar';
import type { ClassMemberRow, ClassRow, ExamRow, GroupNumber } from '@/lib/types';
import { GROUP_NUMBERS } from '@/lib/types';

interface CreateTugOfWarModalProps {
  klass: ClassRow;
  onClose: () => void;
}

export function CreateTugOfWarModal({ klass, onClose }: CreateTugOfWarModalProps) {
  const router = useRouter();

  const [members, setMembers] = useState<ClassMemberRow[]>([]);
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [examId, setExamId] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [blueGroup, setBlueGroup] = useState<GroupNumber>(1);
  const [redGroup, setRedGroup] = useState<GroupNumber>(2);
  const [questionCount, setQuestionCount] = useState<number>(10);
  const [durationSeconds, setDurationSeconds] = useState<number>(120);
  const [winGap, setWinGap] = useState<number>(3);
  const [freezeSeconds, setFreezeSeconds] = useState<number>(3);

  // Load members and exams
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const [loadedMembers, loadedExams] = await Promise.all([
          listClassMembers(supabase, klass.id),
          listExams(supabase),
        ]);

        if (cancelled) return;
        setMembers(loadedMembers);
        setExams(loadedExams);

        if (loadedExams.length > 0) {
          setExamId(loadedExams[0].id);
          setTitle(loadedExams[0].title);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof PersistenceError ? err.message : 'Không tải được dữ liệu.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [klass.id]);

  // Handle exam change to update game title
  const handleExamChange = (newExamId: string) => {
    setExamId(newExamId);
    const chosen = exams.find((e) => e.id === newExamId);
    if (chosen) {
      setTitle(chosen.title);
    }
  };

  // Compute member counts per group
  const groupCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const g of GROUP_NUMBERS) counts[g] = 0;
    for (const m of members) {
      const g = m.group_number || 1;
      counts[g] = (counts[g] || 0) + 1;
    }
    return counts;
  }, [members]);

  const canSubmit =
    !isLoading &&
    !isSubmitting &&
    !!examId &&
    !!title.trim() &&
    blueGroup !== redGroup &&
    questionCount > 0 &&
    durationSeconds >= 30;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const session = await createTugOfWarSession(supabase, {
        class_id: klass.id,
        exam_id: examId,
        title: title.trim(),
        blue_group_number: blueGroup,
        red_group_number: redGroup,
        blue_team_name: `Đội Xanh (Tổ ${blueGroup})`,
        red_team_name: `Đội Đỏ (Tổ ${redGroup})`,
        question_count: questionCount,
        duration_seconds: durationSeconds,
        win_gap: winGap,
        freeze_seconds: freezeSeconds,
      });

      router.push(`/games/tug-of-war/${session.id}`);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : (err as Error).message);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900 text-slate-100 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-rose-600 shadow-lg shadow-blue-500/20 text-xl">
              ⚔️
            </span>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Kéo Co Tri Thức
                <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-semibold text-blue-400 border border-blue-500/30">
                  {klass.name}
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Đối kháng trực tiếp 2 tổ trên máy chiếu & điện thoại học sinh
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="flex items-center gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              <AlertTriangle size={16} className="shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-slate-400">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <p className="text-xs">Đang nạp đề thi và danh sách tổ...</p>
            </div>
          ) : exams.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-slate-400 space-y-2">
              <p className="font-semibold text-sm">Chưa có đề thi nào trong hệ thống</p>
              <p className="text-xs text-slate-500">
                Vui lòng tạo hoặc tải lên ít nhất một đề thi trắc nghiệm trước khi bắt đầu trò chơi.
              </p>
            </div>
          ) : (
            <>
              {/* Select Exam & Game Title */}
              <div className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  1. Chọn Đề Thi
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Đề thi ngân hàng câu hỏi</label>
                    <select
                      value={examId}
                      onChange={(e) => handleExamChange(e.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {exams.map((ex) => (
                        <option key={ex.id} value={ex.id}>
                          {ex.code} — {ex.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Tiêu đề trò chơi hiển thị</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Tin 8: bài 2: Thông tin kĩ thuật số"
                      required
                      className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"
                    />
                  </div>
                </div>
              </div>

              {/* Team Matchup (Blue vs Red) */}
              <div className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  2. Chọn 2 Tổ Đối Kháng
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* Blue Team Selection */}
                  <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-bold text-blue-400 uppercase">
                        🔵 Đội Xanh (Bên Trái)
                      </span>
                      <span className="text-[11px] text-blue-300/80 font-medium">
                        {groupCounts[blueGroup]} học sinh
                      </span>
                    </div>
                    <select
                      value={blueGroup}
                      onChange={(e) => setBlueGroup(Number(e.target.value) as GroupNumber)}
                      className="w-full rounded-lg border border-blue-500/40 bg-slate-900 px-3 py-2 text-sm font-semibold text-blue-200 focus:border-blue-400 focus:outline-none"
                    >
                      {GROUP_NUMBERS.map((g) => (
                        <option key={g} value={g} disabled={g === redGroup}>
                          Tổ {g} ({groupCounts[g]} học sinh){g === redGroup ? ' (Đang là Đội Đỏ)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Red Team Selection */}
                  <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-bold text-rose-400 uppercase">
                        🔴 Đội Đỏ (Bên Phải)
                      </span>
                      <span className="text-[11px] text-rose-300/80 font-medium">
                        {groupCounts[redGroup]} học sinh
                      </span>
                    </div>
                    <select
                      value={redGroup}
                      onChange={(e) => setRedGroup(Number(e.target.value) as GroupNumber)}
                      className="w-full rounded-lg border border-rose-500/40 bg-slate-900 px-3 py-2 text-sm font-semibold text-rose-200 focus:border-rose-400 focus:outline-none"
                    >
                      {GROUP_NUMBERS.map((g) => (
                        <option key={g} value={g} disabled={g === blueGroup}>
                          Tổ {g} ({groupCounts[g]} học sinh){g === blueGroup ? ' (Đang là Đội Xanh)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {blueGroup === redGroup && (
                  <p className="text-xs text-rose-400 font-medium">
                    ⚠️ Hai đội đối kháng phải thuộc hai tổ khác nhau!
                  </p>
                )}
              </div>

              {/* Match Parameters */}
              <div className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  3. Thông Số Trận Đấu
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* Question Count */}
                  <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-3 space-y-1.5">
                    <label className="flex items-center justify-between text-xs text-slate-300 font-medium">
                      <span>Số câu hỏi ngẫu nhiên</span>
                      <span className="font-bold text-white">{questionCount} câu</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={questionCount}
                      onChange={(e) => setQuestionCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[11px] text-slate-500">
                      Rút ngẫu nhiên từ đề và xáo trộn riêng cho mỗi đội.
                    </p>
                  </div>

                  {/* Duration Seconds */}
                  <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-3 space-y-1.5">
                    <label className="flex items-center justify-between text-xs text-slate-300 font-medium">
                      <span className="flex items-center gap-1">
                        <Clock size={13} className="text-amber-400" />
                        Thời gian thi đấu (giây)
                      </span>
                      <span className="font-bold text-white">{durationSeconds}s ({Math.floor(durationSeconds / 60)}p{durationSeconds % 60}s)</span>
                    </label>
                    <div className="flex gap-1.5">
                      {[60, 120, 180, 300].map((sec) => (
                        <button
                          key={sec}
                          type="button"
                          onClick={() => setDurationSeconds(sec)}
                          className={`flex-1 rounded-lg py-1 text-xs font-semibold transition ${
                            durationSeconds === sec
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'border border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
                          }`}
                        >
                          {sec}s
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Win Gap */}
                  <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-3 space-y-1.5">
                    <label className="flex items-center justify-between text-xs text-slate-300 font-medium">
                      <span className="flex items-center gap-1">
                        <Trophy size={13} className="text-yellow-400" />
                        Cách biệt thắng lập tức
                      </span>
                      <span className="font-bold text-white">
                        {winGap > 0 ? `${winGap} câu` : 'Tắt'}
                      </span>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={winGap}
                      onChange={(e) => setWinGap(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[11px] text-slate-500">
                      Khi một đội dẫn trước đối thủ {winGap} điểm sẽ thắng ngay (0 = tắt).
                    </p>
                  </div>

                  {/* Freeze Seconds Penalty */}
                  <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-3 space-y-1.5">
                    <label className="flex items-center justify-between text-xs text-slate-300 font-medium">
                      <span className="flex items-center gap-1">
                        <Flame size={13} className="text-cyan-400" />
                        Đóng băng khi trả lời sai
                      </span>
                      <span className="font-bold text-white">{freezeSeconds}s</span>
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={15}
                      value={freezeSeconds}
                      onChange={(e) => setFreezeSeconds(Math.max(0, parseInt(e.target.value, 10) || 0))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                    />
                    <p className="text-[11px] text-slate-500">
                      Thời gian đội bị khóa nút và phủ băng tuyết trước khi sang câu kế tiếp.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Footer Actions */}
          <div className="pt-2 flex items-center justify-end gap-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-rose-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Đang khởi tạo trận đấu...
                </>
              ) : (
                <>
                  <Zap size={15} />
                  🚀 Bắt đầu Phòng Chờ Kéo Co
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
