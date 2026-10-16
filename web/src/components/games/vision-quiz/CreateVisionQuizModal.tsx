'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Clock,
  Dices,
  Hand,
  Keyboard,
  Loader2,
  Settings2,
  Sliders,
  Swords,
  Timer,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { listClassMembers } from '@/lib/classes';
import { listExams } from '@/lib/exams';
import {
  buildVisionQuizQuestions,
  fetchAndNormalizeExamQuestions,
} from '@/lib/visionEngine';
import type {
  ClassMemberRow,
  ClassRow,
  ExamRow,
  VisionAdvanceMode,
  VisionDetectionMode,
  VisionExamDistribution,
  VisionPlayerMode,
  VisionQuizConfig,
} from '@/lib/types';
import { DEFAULT_VISION_QUIZ_CONFIG } from '@/lib/types';

interface CreateVisionQuizModalProps {
  klass: ClassRow;
  onClose: () => void;
}

export function CreateVisionQuizModal({ klass, onClose }: CreateVisionQuizModalProps) {
  const router = useRouter();

  const [members, setMembers] = useState<ClassMemberRow[]>([]);
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Advanced section collapse
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Form State initialized from DEFAULT_VISION_QUIZ_CONFIG
  const [playerMode, setPlayerMode] = useState<VisionPlayerMode>(DEFAULT_VISION_QUIZ_CONFIG.playerMode);
  const [blueName, setBlueName] = useState<string>('Học sinh 1');
  const [redName, setRedName] = useState<string>('Học sinh 2');
  const [swapSides, setSwapSides] = useState<boolean>(DEFAULT_VISION_QUIZ_CONFIG.swapSides);

  const [distributionMode, setDistributionMode] = useState<VisionExamDistribution>(
    DEFAULT_VISION_QUIZ_CONFIG.examDistributionMode
  );
  const [blueExamId, setBlueExamId] = useState<string>('');
  const [redExamId, setRedExamId] = useState<string>('');
  const [questionCount, setQuestionCount] = useState<number>(DEFAULT_VISION_QUIZ_CONFIG.questionCount);
  const [shuffleQuestions, setShuffleQuestions] = useState<boolean>(
    DEFAULT_VISION_QUIZ_CONFIG.shuffleQuestions
  );
  const [shuffleOptions, setShuffleOptions] = useState<boolean>(
    DEFAULT_VISION_QUIZ_CONFIG.shuffleOptions
  );

  const [durationSeconds, setDurationSeconds] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.durationSeconds
  );
  const [holdDurationMs, setHoldDurationMs] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.holdDurationMs
  );
  const [wrongPenaltySeconds, setWrongPenaltySeconds] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.wrongPenaltySeconds
  );
  const [pointsPerCorrect, setPointsPerCorrect] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.pointsPerCorrect
  );
  const [wrongPointDeduction, setWrongPointDeduction] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.wrongPointDeduction
  );
  const [speedBonusEnabled, setSpeedBonusEnabled] = useState<boolean>(
    DEFAULT_VISION_QUIZ_CONFIG.speedBonusEnabled
  );
  const [winGap, setWinGap] = useState<number>(DEFAULT_VISION_QUIZ_CONFIG.winGap);
  const [advanceMode, setAdvanceMode] = useState<VisionAdvanceMode>(
    DEFAULT_VISION_QUIZ_CONFIG.advanceMode
  );
  const [revealAnswerOnWrong, setRevealAnswerOnWrong] = useState<boolean>(
    DEFAULT_VISION_QUIZ_CONFIG.revealAnswerOnWrong
  );

  const [detectionMode, setDetectionMode] = useState<VisionDetectionMode>(
    DEFAULT_VISION_QUIZ_CONFIG.detectionMode
  );
  const [splitRatio, setSplitRatio] = useState<number>(DEFAULT_VISION_QUIZ_CONFIG.splitRatio);
  const [minConfidence, setMinConfidence] = useState<number>(
    DEFAULT_VISION_QUIZ_CONFIG.minConfidence
  );
  const [mirrorVideo, setMirrorVideo] = useState<boolean>(DEFAULT_VISION_QUIZ_CONFIG.mirrorVideo);
  const [showSkeleton, setShowSkeleton] = useState<boolean>(DEFAULT_VISION_QUIZ_CONFIG.showSkeleton);

  const [blueKeys, setBlueKeys] = useState<[string, string, string, string]>(
    DEFAULT_VISION_QUIZ_CONFIG.keybindings.blue
  );
  const [redKeys, setRedKeys] = useState<[string, string, string, string]>(
    DEFAULT_VISION_QUIZ_CONFIG.keybindings.red
  );

  // Load class members and exams on mount
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
          setBlueExamId(loadedExams[0].id);
          setRedExamId(loadedExams.length > 1 ? loadedExams[1].id : loadedExams[0].id);
        }

        if (loadedMembers.length > 0) {
          setBlueName(loadedMembers[0].full_name);
          if (loadedMembers.length > 1) {
            setRedName(loadedMembers[1].full_name);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Không tải được dữ liệu.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [klass.id]);

  // Randomize student helper
  const handleRandomizeStudents = () => {
    if (members.length === 0) return;
    if (playerMode === 'SINGLE') {
      const idx = Math.floor(Math.random() * members.length);
      setBlueName(members[idx].full_name);
    } else {
      if (members.length === 1) {
        setBlueName(members[0].full_name);
        return;
      }
      const idx1 = Math.floor(Math.random() * members.length);
      let idx2 = Math.floor(Math.random() * (members.length - 1));
      if (idx2 >= idx1) idx2++;
      setBlueName(members[idx1].full_name);
      setRedName(members[idx2].full_name);
    }
  };

  // Swap Left and Right players
  const handleSwapSides = () => {
    const temp = blueName;
    setBlueName(redName);
    setRedName(temp);
    setSwapSides((prev) => !prev);
  };

  const canLaunch =
    !isLoading &&
    !isLaunching &&
    Boolean(blueExamId) &&
    (distributionMode !== 'DUAL_EXAMS' || Boolean(redExamId)) &&
    Boolean(blueName.trim()) &&
    (playerMode === 'SINGLE' || Boolean(redName.trim()));

  const handleLaunchGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canLaunch) return;

    setError(null);
    setIsLaunching(true);

    try {
      const supabase = createClient();

      // 1. Fetch questions for primary exam
      const primaryQuestions = await fetchAndNormalizeExamQuestions(supabase, blueExamId);
      if (primaryQuestions.length === 0) {
        throw new Error('Đề thi đã chọn chưa có câu hỏi trắc nghiệm hợp lệ.');
      }

      // 2. Fetch secondary exam questions if in DUAL_EXAMS mode
      let secondaryQuestions: typeof primaryQuestions = [];
      if (playerMode === 'DUEL' && distributionMode === 'DUAL_EXAMS' && redExamId) {
        secondaryQuestions = await fetchAndNormalizeExamQuestions(supabase, redExamId);
        if (secondaryQuestions.length === 0) {
          throw new Error('Đề thi bên phải chưa có câu hỏi trắc nghiệm hợp lệ.');
        }
      }

      // 3. Build player question sets
      const { blueQuestions, redQuestions } = buildVisionQuizQuestions({
        mode: playerMode === 'SINGLE' ? 'SHARED_SYNC' : distributionMode,
        primaryPool: primaryQuestions,
        secondaryPool: secondaryQuestions,
        questionCount,
        shuffleQuestions,
        shuffleOptions,
      });

      // 4. Construct complete VisionQuizConfig
      const config: VisionQuizConfig = {
        playerMode,
        bluePlayerName: blueName.trim() || 'Học sinh 1',
        redPlayerName: playerMode === 'DUEL' ? redName.trim() || 'Học sinh 2' : '',
        swapSides,
        examDistributionMode: playerMode === 'SINGLE' ? 'SHARED_SYNC' : distributionMode,
        blueExamId,
        redExamId: distributionMode === 'DUAL_EXAMS' ? redExamId : blueExamId,
        questionCount: Math.min(questionCount, blueQuestions.length),
        shuffleQuestions,
        shuffleOptions,
        durationSeconds,
        holdDurationMs,
        wrongPenaltySeconds,
        pointsPerCorrect,
        wrongPointDeduction,
        speedBonusEnabled,
        winGap,
        advanceMode,
        revealAnswerOnWrong,
        detectionMode,
        splitRatio,
        minConfidence,
        graceWindowMs: 200,
        mirrorVideo,
        showSkeleton,
        keybindings: {
          blue: blueKeys,
          red: redKeys,
        },
      };

      const primaryExamTitle = exams.find((x) => x.id === blueExamId)?.title || 'Đề thi trắc nghiệm';
      const secondaryExamTitle = exams.find((x) => x.id === redExamId)?.title || primaryExamTitle;

      // 5. Store session state in sessionStorage for zero-latency instant arena boot
      const sessionPayload = {
        config,
        className: klass.name,
        classId: klass.id,
        primaryExamTitle,
        secondaryExamTitle,
        blueQuestions,
        redQuestions,
        createdAt: new Date().toISOString(),
      };

      sessionStorage.setItem('adqs_vision_quiz_session', JSON.stringify(sessionPayload));

      // 6. Navigate to Vision Quiz Arena
      router.push('/games/vision-quiz');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không khởi động được trận đấu.');
      setIsLaunching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900 text-slate-100 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-lg shadow-purple-500/25 text-2xl">
              📷
            </span>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Đấu Trường Cử Chỉ AI
                <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-xs font-semibold text-purple-300 border border-purple-500/30">
                  AI Camera Quiz
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Lớp: <span className="font-semibold text-slate-200">{klass.name}</span> • 1P / 2P Đối kháng
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleLaunchGame} className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {error && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-300">
              ⚠️ {error}
            </div>
          )}

          {/* SECTION 1: Player Mode & Student Selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Users size={14} className="text-indigo-400" />
                1. Chế độ người chơi & Chọn học sinh
              </label>
              <button
                type="button"
                onClick={handleRandomizeStudents}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-950/70 border border-indigo-700/50 px-2.5 py-1 text-[11px] font-bold text-indigo-300 hover:bg-indigo-900 transition"
                title="Chọn ngẫu nhiên học sinh trong lớp"
              >
                <Dices size={13} />
                Chọn ngẫu nhiên
              </button>
            </div>

            {/* Mode switch 1P vs 2P */}
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950 p-1.5 border border-slate-800">
              <button
                type="button"
                onClick={() => setPlayerMode('SINGLE')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-bold transition ${
                  playerMode === 'SINGLE'
                    ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <User size={15} />
                👤 1 Học sinh (Cá nhân)
              </button>
              <button
                type="button"
                onClick={() => setPlayerMode('DUEL')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-bold transition ${
                  playerMode === 'DUEL'
                    ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Swords size={15} />
                ⚔️ 2 Học sinh (Đối kháng)
              </button>
            </div>

            {/* Student Name Inputs */}
            {playerMode === 'SINGLE' ? (
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Tên học sinh thi đấu:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={blueName}
                    onChange={(e) => setBlueName(e.target.value)}
                    placeholder="Nhập tên học sinh..."
                    className="flex-1 rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    required
                  />
                  {members.length > 0 && (
                    <select
                      onChange={(e) => {
                        if (e.target.value) setBlueName(e.target.value);
                      }}
                      className="rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-slate-300 focus:border-indigo-500 focus:outline-none max-w-[140px]"
                    >
                      <option value="">Chọn từ lớp...</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.full_name}>
                          {m.full_name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Blue side */}
                  <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-sky-400">
                      <span>🔵 Bên Trái ({swapSides ? 'Đỏ' : 'Xanh'})</span>
                    </div>
                    <input
                      type="text"
                      value={blueName}
                      onChange={(e) => setBlueName(e.target.value)}
                      placeholder="Tên Học sinh 1..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                      required
                    />
                    {members.length > 0 && (
                      <select
                        onChange={(e) => {
                          if (e.target.value) setBlueName(e.target.value);
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-300 focus:border-sky-500 focus:outline-none"
                      >
                        <option value="">Chọn từ danh sách lớp...</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.full_name}>
                            {m.full_name} {m.group_number ? `(Tổ ${m.group_number})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Red side */}
                  <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-rose-400">
                      <span>🔴 Bên Phải ({swapSides ? 'Xanh' : 'Đỏ'})</span>
                    </div>
                    <input
                      type="text"
                      value={redName}
                      onChange={(e) => setRedName(e.target.value)}
                      placeholder="Tên Học sinh 2..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-rose-500 focus:outline-none"
                      required
                    />
                    {members.length > 0 && (
                      <select
                        onChange={(e) => {
                          if (e.target.value) setRedName(e.target.value);
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-300 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="">Chọn từ danh sách lớp...</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.full_name}>
                            {m.full_name} {m.group_number ? `(Tổ ${m.group_number})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleSwapSides}
                    className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-indigo-300 transition"
                  >
                    ⇄ Đổi bên Trái / Phải
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* SECTION 2: Exam & Question Distribution */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Zap size={14} className="text-amber-400" />
              2. Chế độ Đề thi & Phân bổ câu hỏi
            </label>

            {playerMode === 'DUEL' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setDistributionMode('SHARED_SYNC')}
                  className={`rounded-xl p-2.5 text-left border transition ${
                    distributionMode === 'SHARED_SYNC'
                      ? 'border-indigo-500 bg-indigo-950/40 text-white shadow-sm'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-200">🤝 SHARED_SYNC</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                    Chung 1 câu đồng bộ, giấu đáp án người chốt trước
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setDistributionMode('SAME_EXAM_SHUFFLED')}
                  className={`rounded-xl p-2.5 text-left border transition ${
                    distributionMode === 'SAME_EXAM_SHUFFLED'
                      ? 'border-purple-500 bg-purple-950/40 text-white shadow-sm'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-200">🔀 SAME_SHUFFLED</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                    Cùng 1 đề, đảo câu hỏi và đáp án độc lập
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setDistributionMode('DUAL_EXAMS')}
                  className={`rounded-xl p-2.5 text-left border transition ${
                    distributionMode === 'DUAL_EXAMS'
                      ? 'border-pink-500 bg-pink-950/40 text-white shadow-sm'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-200">⚔️ DUAL_EXAMS</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                    2 đề thi khác biệt cho 2 học sinh
                  </div>
                </button>
              </div>
            )}

            {/* Exam Selectors */}
            {distributionMode === 'DUAL_EXAMS' && playerMode === 'DUEL' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-sky-400 font-semibold">Đề thi Bên Trái:</label>
                  <select
                    value={blueExamId}
                    onChange={(e) => setBlueExamId(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-xs text-white focus:border-sky-500 focus:outline-none"
                    required
                  >
                    {exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.title} ({exam.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-rose-400 font-semibold">Đề thi Bên Phải:</label>
                  <select
                    value={redExamId}
                    onChange={(e) => setRedExamId(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3 py-2 text-xs text-white focus:border-rose-500 focus:outline-none"
                    required
                  >
                    {exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.title} ({exam.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs text-slate-400">Chọn Đề thi trắc nghiệm:</label>
                <select
                  value={blueExamId}
                  onChange={(e) => {
                    setBlueExamId(e.target.value);
                    setRedExamId(e.target.value);
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800/90 px-3.5 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  required
                >
                  {exams.map((exam) => (
                    <option key={exam.id} value={exam.id}>
                      {exam.title} ({exam.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Shuffle checkboxes */}
            <div className="flex flex-wrap gap-4 pt-1">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shuffleQuestions}
                  onChange={(e) => setShuffleQuestions(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                />
                Đảo thứ tự câu hỏi
              </label>

              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shuffleOptions}
                  onChange={(e) => setShuffleOptions(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                />
                Đảo vị trí đáp án (A, B, C, D)
              </label>
            </div>
          </div>

          {/* SECTION 3: Timing, Scoring & Victory Rules */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Timer size={14} className="text-emerald-400" />
              3. Thời gian, Luật thắng & Chuyển câu
            </label>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Question Count */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 space-y-1">
                <span className="text-[11px] text-slate-400">Số câu hỏi:</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm font-bold text-white text-center"
                />
              </div>

              {/* Match Timer */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 space-y-1">
                <span className="text-[11px] text-slate-400">Thời gian (giây):</span>
                <input
                  type="number"
                  min={30}
                  max={600}
                  step={10}
                  value={durationSeconds}
                  onChange={(e) => setDurationSeconds(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm font-bold text-white text-center"
                />
              </div>

              {/* Hold Duration */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 space-y-1">
                <span className="text-[11px] text-slate-400">Giữ tay chốt (s):</span>
                <input
                  type="number"
                  min={0.5}
                  max={3.0}
                  step={0.1}
                  value={holdDurationMs / 1000}
                  onChange={(e) => setHoldDurationMs(Math.round(Number(e.target.value) * 1000))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm font-bold text-white text-center"
                />
              </div>

              {/* Wrong Penalty Freeze */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 space-y-1">
                <span className="text-[11px] text-slate-400">Phạt đóng băng (s):</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={wrongPenaltySeconds}
                  onChange={(e) => setWrongPenaltySeconds(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm font-bold text-white text-center"
                />
              </div>
            </div>

            {/* Advance Mode & Reveal Wrong */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400">Chế độ chuyển câu:</label>
                <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-slate-950 p-1 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setAdvanceMode('AUTO')}
                    className={`rounded-md py-1 text-[11px] font-bold transition ${
                      advanceMode === 'AUTO'
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    ⚡ Tự động
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdvanceMode('MANUAL_TEACHER')}
                    className={`rounded-md py-1 text-[11px] font-bold transition ${
                      advanceMode === 'MANUAL_TEACHER'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    👨‍🏫 Giáo viên bấm
                  </button>
                </div>
              </div>

              <div className="flex items-center pt-4">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={revealAnswerOnWrong}
                    onChange={(e) => setRevealAnswerOnWrong(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                  />
                  Hiện đáp án đúng khi trả lời sai
                </label>
              </div>
            </div>
          </div>

          {/* SECTION 4: Advanced AI Camera & Calibration Settings */}
          <div className="border-t border-slate-800 pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between py-1 text-xs font-bold text-slate-400 hover:text-white transition"
            >
              <span className="flex items-center gap-1.5 text-purple-400">
                <Settings2 size={14} />
                ⚙️ Tùy chỉnh AI Camera & Phím tắt dự phòng
              </span>
              {showAdvanced ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4 animate-in slide-in-from-top-2 duration-150">
                {/* Detection Mode */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">Kiểu nhận diện cử chỉ AI:</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setDetectionMode('HAND_FINGERS')}
                      className={`flex items-center justify-center gap-2 rounded-xl p-2 text-xs font-bold border transition ${
                        detectionMode === 'HAND_FINGERS'
                          ? 'border-purple-500 bg-purple-950/50 text-purple-300'
                          : 'border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <Hand size={15} />
                      ✋ Đếm ngón tay (1-2-3-4)
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetectionMode('BODY_POSE')}
                      className={`flex items-center justify-center gap-2 rounded-xl p-2 text-xs font-bold border transition ${
                        detectionMode === 'BODY_POSE'
                          ? 'border-pink-500 bg-pink-950/50 text-pink-300'
                          : 'border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <User size={15} />
                      🕺 Dáng người cơ thể (Tay giơ/chéo)
                    </button>
                  </div>
                </div>

                {/* Sliders: Split Ratio & Min Confidence */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Vạch chia camera:</span>
                      <span className="font-mono text-white">{Math.round(splitRatio * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.3}
                      max={0.7}
                      step={0.05}
                      value={splitRatio}
                      onChange={(e) => setSplitRatio(Number(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Độ nhạy AI (Confidence):</span>
                      <span className="font-mono text-white">{Math.round(minConfidence * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.4}
                      max={0.85}
                      step={0.05}
                      value={minConfidence}
                      onChange={(e) => setMinConfidence(Number(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  </div>
                </div>

                {/* Checkboxes: Mirror & Skeleton */}
                <div className="flex flex-wrap gap-4 pt-1">
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mirrorVideo}
                      onChange={(e) => setMirrorVideo(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                    />
                    Lật gương camera (Mirror)
                  </label>

                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showSkeleton}
                      onChange={(e) => setShowSkeleton(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                    />
                    Vẽ khung xương AR trên camera
                  </label>

                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={speedBonusEnabled}
                      onChange={(e) => setSpeedBonusEnabled(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                    />
                    Thưởng điểm nhanh tay (+5đ)
                  </label>
                </div>

                {/* Fallback Keybindings */}
                <div className="space-y-2 pt-2 border-t border-slate-800">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Keyboard size={13} className="text-slate-400" />
                    Phím tắt bàn phím dự phòng:
                  </label>
                  <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-400">
                    <div>
                      <span className="text-sky-400 font-bold">Bên Trái: </span>
                      {blueKeys.join(' - ')} (A-B-C-D)
                    </div>
                    <div>
                      <span className="text-rose-400 font-bold">Bên Phải: </span>
                      {redKeys.join(' - ')} (A-B-C-D)
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isLaunching}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 transition"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={!canLaunch}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 hover:brightness-110 disabled:opacity-50 transition"
            >
              {isLaunching ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Đang khởi tạo trận đấu...
                </>
              ) : (
                <>🚀 Bắt đầu Đấu Trường AI</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
