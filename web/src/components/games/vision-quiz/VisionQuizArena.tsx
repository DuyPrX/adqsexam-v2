'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Clock,
  Eye,
  Flame,
  Hand,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Settings,
  SkipForward,
  Trophy,
  User,
  Users,
  Volume2,
  VolumeX,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  PlayerId,
  VisionDetectionMode,
  VisionQuizConfig,
  VisionQuizQuestionItem,
} from '@/lib/types';
import {
  assignDetectionsToPlayers,
  classifyBodyPose,
  countExtendedFingers,
  drawVisionOverlay,
  HoldConfirmationTracker,
  PlayerDetectionAssignment,
  VisionSoundEffects,
} from '@/lib/visionEngine';

interface VisionQuizArenaProps {
  initialConfig: VisionQuizConfig;
  blueQuestions: VisionQuizQuestionItem[];
  redQuestions: VisionQuizQuestionItem[];
  className?: string;
  primaryExamTitle?: string;
  onExit?: () => void;
}

const OPTION_THEMES = [
  {
    letter: 'A',
    bg: 'bg-red-500/15 hover:bg-red-500/25 border-red-500/40 text-red-100',
    activeBg: 'bg-red-600 text-white border-red-400 shadow-lg shadow-red-600/40',
    badge: 'bg-red-600 text-white',
    border: 'border-red-500',
  },
  {
    letter: 'B',
    bg: 'bg-blue-500/15 hover:bg-blue-500/25 border-blue-500/40 text-blue-100',
    activeBg: 'bg-blue-600 text-white border-blue-400 shadow-lg shadow-blue-600/40',
    badge: 'bg-blue-600 text-white',
    border: 'border-blue-500',
  },
  {
    letter: 'C',
    bg: 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-100',
    activeBg: 'bg-amber-600 text-white border-amber-400 shadow-lg shadow-amber-600/40',
    badge: 'bg-amber-600 text-white',
    border: 'border-amber-500',
  },
  {
    letter: 'D',
    bg: 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-100',
    activeBg: 'bg-emerald-600 text-white border-emerald-400 shadow-lg shadow-emerald-600/40',
    badge: 'bg-emerald-600 text-white',
    border: 'border-emerald-500',
  },
];

export function VisionQuizArena({
  initialConfig,
  blueQuestions,
  redQuestions,
  className = '',
  primaryExamTitle = 'Đấu trường Cử chỉ AI',
  onExit,
}: VisionQuizArenaProps) {
  const router = useRouter();

  // Active Live Config (modifiable via in-game settings without reload)
  const [config, setConfig] = useState<VisionQuizConfig>(initialConfig);
  const [showSettings, setShowSettings] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Sound Engine
  const sfx = useMemo(() => new VisionSoundEffects(), []);
  useEffect(() => {
    sfx.isMuted = isMuted;
  }, [isMuted, sfx]);

  // Match Timer State
  const [timeLeft, setTimeLeft] = useState<number>(config.durationSeconds);
  const [isGameOver, setIsGameOver] = useState(false);
  const [winnerMessage, setWinnerMessage] = useState<string>('');

  // Player Game States
  const [blueIdx, setBlueIdx] = useState(0);
  const [redIdx, setRedIdx] = useState(0);
  const [blueScore, setBlueScore] = useState(0);
  const [redScore, setRedScore] = useState(0);

  // Freeze Penalty Timestamps
  const [blueFrozenUntil, setBlueFrozenUntil] = useState<number>(0);
  const [redFrozenUntil, setRedFrozenUntil] = useState<number>(0);
  const [freezeSecondsLeft, setFreezeSecondsLeft] = useState({ blue: 0, red: 0 });

  // Answer Locking States (For SHARED_SYNC mode & Feedback)
  const [blueLockedOption, setBlueLockedOption] = useState<number | null>(null);
  const [redLockedOption, setRedLockedOption] = useState<number | null>(null);
  const [lockTimestamp, setLockTimestamp] = useState<{ blue: number | null; red: number | null }>({
    blue: null,
    red: null,
  });

  // Visual Flash Feedback
  const [blueFlash, setBlueFlash] = useState<'correct' | 'wrong' | null>(null);
  const [redFlash, setRedFlash] = useState<'correct' | 'wrong' | null>(null);

  // DOM Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Camera State
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Current Questions
  const currentBlueQ = blueQuestions[blueIdx] || null;
  const currentRedQ =
    config.examDistributionMode === 'SHARED_SYNC'
      ? currentBlueQ
      : redQuestions[redIdx] || null;

  // Dwell Tracker ref
  const trackerRef = useRef<HoldConfirmationTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new HoldConfirmationTracker({
      holdDurationMs: config.holdDurationMs,
      graceWindowMs: config.graceWindowMs,
    });
  }

  // Update tracker config when live config changes
  useEffect(() => {
    trackerRef.current?.setConfig(config.holdDurationMs, config.graceWindowMs);
  }, [config.holdDurationMs, config.graceWindowMs]);

  /* -------------------------------------------------------------------------- */
  /* 1. Camera Stream Initialization                                            */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Trình duyệt không hỗ trợ truy cập camera.');
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraActive(true);
          setCameraError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Không thể mở camera. Vui lòng cho phép quyền truy cập.';
          setCameraError(msg);
          setCameraActive(false);
        }
      }
    }

    void startCamera();

    return () => {
      cancelled = true;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  /* -------------------------------------------------------------------------- */
  /* 2. Match Timer & Freeze Penalty Loop                                       */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    if (isPaused || isGameOver) return;

    const interval = setInterval(() => {
      const now = Date.now();

      // Decrement match countdown
      setTimeLeft((prev) => {
        if (prev <= 1) {
          endGame('Hết thời gian làm bài!');
          return 0;
        }
        return prev - 1;
      });

      // Update Freeze Counters
      const bSec = Math.max(0, Math.ceil((blueFrozenUntil - now) / 1000));
      const rSec = Math.max(0, Math.ceil((redFrozenUntil - now) / 1000));
      setFreezeSecondsLeft({ blue: bSec, red: rSec });
    }, 1000);

    return () => clearInterval(interval);
  }, [isPaused, isGameOver, blueFrozenUntil, redFrozenUntil]);

  /* -------------------------------------------------------------------------- */
  /* 3. Knock-out Victory Check                                                 */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    if (isGameOver || config.playerMode === 'SINGLE' || config.winGap <= 0) return;
    const diff = Math.abs(blueScore - redScore);
    if (diff >= config.winGap) {
      const victor = blueScore > redScore ? config.bluePlayerName : config.redPlayerName;
      endGame(`🏆 KNOCK-OUT! ${victor} dẫn trước cách biệt ${diff} điểm!`);
    }
  }, [blueScore, redScore, config.winGap, config.playerMode, isGameOver, config.bluePlayerName, config.redPlayerName]);

  const endGame = useCallback(
    (reason: string) => {
      setIsGameOver(true);
      setWinnerMessage(reason);
      sfx.playVictory();
    },
    [sfx]
  );

  /* -------------------------------------------------------------------------- */
  /* 4. Answer Handling Logic                                                   */
  /* -------------------------------------------------------------------------- */
  const handleLockOption = useCallback(
    (player: PlayerId, optionIdx: number) => {
      const now = Date.now();

      // Check if player is frozen
      if (player === 'BLUE' && now < blueFrozenUntil) return;
      if (player === 'RED' && now < redFrozenUntil) return;

      sfx.playLockTick();

      if (player === 'BLUE') {
        setBlueLockedOption(optionIdx);
        setLockTimestamp((prev) => ({ ...prev, blue: prev.blue ?? now }));
      } else {
        setRedLockedOption(optionIdx);
        setLockTimestamp((prev) => ({ ...prev, red: prev.red ?? now }));
      }
    },
    [blueFrozenUntil, redFrozenUntil, sfx]
  );

  // Wire tracker lock callback
  useEffect(() => {
    if (trackerRef.current) {
      (trackerRef.current as any).onLock = handleLockOption;
    }
  }, [handleLockOption]);

  // Synchronous resolution in SHARED_SYNC mode when both lock
  useEffect(() => {
    if (config.examDistributionMode !== 'SHARED_SYNC' || !currentBlueQ) return;

    const bothLocked =
      config.playerMode === 'SINGLE'
        ? blueLockedOption !== null
        : blueLockedOption !== null && redLockedOption !== null;

    if (!bothLocked) return;

    // Both players have locked their answer!
    const correctOpt = currentBlueQ.correct_option;

    // Evaluate Blue
    const blueIsCorrect = blueLockedOption === correctOpt;
    let blueEarned = 0;
    if (blueIsCorrect) {
      blueEarned += config.pointsPerCorrect;
      // Speed bonus if blue locked earlier than red
      if (
        config.speedBonusEnabled &&
        lockTimestamp.blue &&
        lockTimestamp.red &&
        lockTimestamp.blue < lockTimestamp.red
      ) {
        blueEarned += 5;
      }
      setBlueScore((s) => s + blueEarned);
      setBlueFlash('correct');
      sfx.playCorrect();
    } else {
      if (config.wrongPointDeduction > 0) {
        setBlueScore((s) => Math.max(0, s - config.wrongPointDeduction));
      }
      setBlueFlash('wrong');
      sfx.playWrong();
      if (config.wrongPenaltySeconds > 0) {
        setBlueFrozenUntil(Date.now() + config.wrongPenaltySeconds * 1000);
      }
    }

    // Evaluate Red if DUEL
    if (config.playerMode === 'DUEL' && redLockedOption !== null) {
      const redIsCorrect = redLockedOption === correctOpt;
      let redEarned = 0;
      if (redIsCorrect) {
        redEarned += config.pointsPerCorrect;
        if (
          config.speedBonusEnabled &&
          lockTimestamp.red &&
          lockTimestamp.blue &&
          lockTimestamp.red < lockTimestamp.blue
        ) {
          redEarned += 5;
        }
        setRedScore((s) => s + redEarned);
        setRedFlash('correct');
        if (!blueIsCorrect) sfx.playCorrect();
      } else {
        if (config.wrongPointDeduction > 0) {
          setRedScore((s) => Math.max(0, s - config.wrongPointDeduction));
        }
        setRedFlash('wrong');
        if (blueIsCorrect) sfx.playWrong();
        if (config.wrongPenaltySeconds > 0) {
          setRedFrozenUntil(Date.now() + config.wrongPenaltySeconds * 1000);
        }
      }
    }

    // Auto-advance after brief verdict delay
    if (config.advanceMode === 'AUTO') {
      const timer = setTimeout(() => {
        advanceNextQuestion();
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [
    blueLockedOption,
    redLockedOption,
    config.examDistributionMode,
    config.playerMode,
    config.pointsPerCorrect,
    config.wrongPointDeduction,
    config.speedBonusEnabled,
    config.wrongPenaltySeconds,
    config.advanceMode,
    currentBlueQ,
    lockTimestamp,
    sfx,
  ]);

  // Self-paced resolution in SAME_EXAM_SHUFFLED or DUAL_EXAMS mode
  const resolveSelfPacedAnswer = useCallback(
    (player: PlayerId, chosenOption: number) => {
      const currentQ = player === 'BLUE' ? currentBlueQ : currentRedQ;
      if (!currentQ) return;

      const isCorrect = chosenOption === currentQ.correct_option;
      if (isCorrect) {
        if (player === 'BLUE') {
          setBlueScore((s) => s + config.pointsPerCorrect);
          setBlueFlash('correct');
          sfx.playCorrect();
        } else {
          setRedScore((s) => s + config.pointsPerCorrect);
          setRedFlash('correct');
          sfx.playCorrect();
        }
      } else {
        if (player === 'BLUE') {
          if (config.wrongPointDeduction > 0) {
            setBlueScore((s) => Math.max(0, s - config.wrongPointDeduction));
          }
          setBlueFlash('wrong');
          sfx.playWrong();
          if (config.wrongPenaltySeconds > 0) {
            setBlueFrozenUntil(Date.now() + config.wrongPenaltySeconds * 1000);
          }
        } else {
          if (config.wrongPointDeduction > 0) {
            setRedScore((s) => Math.max(0, s - config.wrongPointDeduction));
          }
          setRedFlash('wrong');
          sfx.playWrong();
          if (config.wrongPenaltySeconds > 0) {
            setRedFrozenUntil(Date.now() + config.wrongPenaltySeconds * 1000);
          }
        }
      }

      setTimeout(() => {
        if (player === 'BLUE') {
          setBlueFlash(null);
          setBlueLockedOption(null);
          trackerRef.current?.reset('BLUE');
          if (blueIdx + 1 < blueQuestions.length) {
            setBlueIdx((i) => i + 1);
          } else {
            endGame(`Học sinh ${config.bluePlayerName} đã hoàn thành tất cả câu hỏi!`);
          }
        } else {
          setRedFlash(null);
          setRedLockedOption(null);
          trackerRef.current?.reset('RED');
          if (redIdx + 1 < redQuestions.length) {
            setRedIdx((i) => i + 1);
          } else {
            endGame(`Học sinh ${config.redPlayerName} đã hoàn thành tất cả câu hỏi!`);
          }
        }
      }, 1200);
    },
    [
      blueIdx,
      redIdx,
      blueQuestions.length,
      redQuestions.length,
      config.pointsPerCorrect,
      config.wrongPointDeduction,
      config.wrongPenaltySeconds,
      config.bluePlayerName,
      config.redPlayerName,
      currentBlueQ,
      currentRedQ,
      endGame,
      sfx,
    ]
  );

  // Monitor locked options for self-paced modes
  useEffect(() => {
    if (config.examDistributionMode === 'SHARED_SYNC') return;

    if (blueLockedOption !== null && blueFlash === null) {
      resolveSelfPacedAnswer('BLUE', blueLockedOption);
    }
  }, [blueLockedOption, blueFlash, config.examDistributionMode, resolveSelfPacedAnswer]);

  useEffect(() => {
    if (config.examDistributionMode === 'SHARED_SYNC') return;

    if (redLockedOption !== null && redFlash === null) {
      resolveSelfPacedAnswer('RED', redLockedOption);
    }
  }, [redLockedOption, redFlash, config.examDistributionMode, resolveSelfPacedAnswer]);

  // Advance function
  const advanceNextQuestion = useCallback(() => {
    setBlueFlash(null);
    setRedFlash(null);
    setBlueLockedOption(null);
    setRedLockedOption(null);
    setLockTimestamp({ blue: null, red: null });
    trackerRef.current?.reset();

    if (blueIdx + 1 < blueQuestions.length) {
      setBlueIdx((i) => i + 1);
      setRedIdx((i) => i + 1);
    } else {
      endGame('Đã hoàn thành toàn bộ câu hỏi của trận đấu!');
    }
  }, [blueIdx, blueQuestions.length, endGame]);

  /* -------------------------------------------------------------------------- */
  /* 5. Fallback Keyboard Controls                                              */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isPaused || isGameOver) return;
      const key = e.key.toUpperCase();

      // Check Blue keys: A, B, C, D (0, 1, 2, 3)
      const bIdx = config.keybindings.blue.indexOf(key);
      if (bIdx >= 0) {
        handleLockOption('BLUE', bIdx);
        return;
      }

      // Check Red keys: A, B, C, D (0, 1, 2, 3)
      if (config.playerMode === 'DUEL') {
        const rIdx = config.keybindings.red.indexOf(key);
        if (rIdx >= 0) {
          handleLockOption('RED', rIdx);
          return;
        }
      }

      // Teacher hotkeys: Space to advance/pause
      if (e.key === ' ' && config.advanceMode === 'MANUAL_TEACHER') {
        e.preventDefault();
        advanceNextQuestion();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    config.keybindings,
    config.playerMode,
    config.advanceMode,
    handleLockOption,
    advanceNextQuestion,
    isPaused,
    isGameOver,
  ]);

  /* -------------------------------------------------------------------------- */
  /* 6. Realtime AR Canvas Animation Loop                                       */
  /* -------------------------------------------------------------------------- */
  useEffect(() => {
    let animId: number;

    const renderLoop = () => {
      const canvas = canvasRef.current;
      const video = videoRef.current;

      if (canvas && video && video.readyState >= 2) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;

          // Synthetic or MediaPipe detections
          const assignments: PlayerDetectionAssignment = {
            blue: null,
            red: null,
          };

          const holdStates = {
            blue: trackerRef.current?.getState('BLUE') || {
              currentOption: null,
              holdStartTime: null,
              lastDetectedTime: null,
              progress: 0,
              isLocked: false,
            },
            red: trackerRef.current?.getState('RED') || {
              currentOption: null,
              holdStartTime: null,
              lastDetectedTime: null,
              progress: 0,
              isLocked: false,
            },
          };

          drawVisionOverlay(
            ctx,
            canvas.width,
            canvas.height,
            config,
            assignments,
            holdStates
          );
        }
      }

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animId);
  }, [config]);

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  // Switch Left/Right sides live
  const handleSwapSidesLive = () => {
    setConfig((prev) => ({
      ...prev,
      swapSides: !prev.swapSides,
      bluePlayerName: prev.redPlayerName,
      redPlayerName: prev.bluePlayerName,
    }));
  };

  // Toggle Detection Mode live
  const handleToggleDetectionLive = () => {
    setConfig((prev) => ({
      ...prev,
      detectionMode: prev.detectionMode === 'HAND_FINGERS' ? 'BODY_POSE' : 'HAND_FINGERS',
    }));
  };

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 select-none ${
        isFullscreen ? 'p-0' : ''
      }`}
    >
      {/* 1. TOP CONTROL BAR */}
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 py-2.5 backdrop-blur-md z-30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-md shadow-purple-500/20 text-lg">
            📷
          </div>
          <div>
            <h1 className="text-sm font-bold text-white flex items-center gap-2">
              Đấu Trường Cử Chỉ AI
              <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-300 border border-purple-500/30">
                {config.playerMode === 'SINGLE' ? '1P CÁ NHÂN' : '2P ĐỐI KHÁNG'}
              </span>
            </h1>
            <p className="text-[11px] text-slate-400">
              Lớp: <span className="text-slate-200">{className}</span> •{' '}
              {primaryExamTitle}
            </p>
          </div>
        </div>

        {/* Center Countdown Timer */}
        <div className="flex items-center gap-2 rounded-xl bg-slate-900 border border-slate-800 px-4 py-1.5 shadow-inner">
          <Clock
            size={16}
            className={timeLeft < 20 ? 'text-rose-500 animate-pulse' : 'text-emerald-400'}
          />
          <span
            className={`font-mono text-base font-extrabold tracking-wider ${
              timeLeft < 20 ? 'text-rose-400 animate-pulse' : 'text-white'
            }`}
          >
            {Math.floor(timeLeft / 60)
              .toString()
              .padStart(2, '0')}
            :{(timeLeft % 60).toString().padStart(2, '0')}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {/* Pause / Resume */}
          <button
            type="button"
            onClick={() => setIsPaused(!isPaused)}
            className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
            title={isPaused ? 'Tiếp tục' : 'Tạm dừng'}
          >
            {isPaused ? <Play size={14} className="text-emerald-400" /> : <Pause size={14} />}
            <span className="hidden sm:inline">{isPaused ? 'Tiếp tục' : 'Tạm dừng'}</span>
          </button>

          {/* Next Question (Active for Manual Advance or Skip) */}
          <button
            type="button"
            onClick={advanceNextQuestion}
            className="flex items-center gap-1 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white transition shadow-sm"
            title="Chuyển câu hỏi kế tiếp"
          >
            <SkipForward size={14} />
            <span className="hidden sm:inline">Câu tiếp</span>
          </button>

          {/* Swap Sides (DUEL mode) */}
          {config.playerMode === 'DUEL' && (
            <button
              type="button"
              onClick={handleSwapSidesLive}
              className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 transition"
              title="Đổi bên Trái / Phải"
            >
              ⇄
            </button>
          )}

          {/* Toggle Detection Mode */}
          <button
            type="button"
            onClick={handleToggleDetectionLive}
            className="rounded-lg bg-slate-800 px-2 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
            title={`Kiểu nhận diện: ${
              config.detectionMode === 'HAND_FINGERS' ? 'Đếm ngón tay' : 'Dáng người'
            }`}
          >
            {config.detectionMode === 'HAND_FINGERS' ? '✋' : '🕺'}
          </button>

          {/* Quick Settings */}
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 transition"
            title="Cài đặt nhanh"
          >
            <Settings size={16} />
          </button>

          {/* Sound Toggle */}
          <button
            type="button"
            onClick={() => setIsMuted(!isMuted)}
            className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 transition"
            title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
          >
            {isMuted ? <VolumeX size={16} className="text-rose-400" /> : <Volume2 size={16} />}
          </button>

          {/* Fullscreen */}
          <button
            type="button"
            onClick={toggleFullscreen}
            className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 transition"
            title="Toàn màn hình"
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>

          {/* Exit */}
          <button
            type="button"
            onClick={() => {
              if (onExit) onExit();
              else router.back();
            }}
            className="rounded-lg bg-rose-950/60 border border-rose-800/40 p-1.5 text-rose-300 hover:bg-rose-900 transition ml-1"
            title="Thoát trò chơi"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* 2. WEBCAM & AR VIEWPORT (TOP SECTION: ~44% viewport) */}
      <div className="relative h-[44%] w-full bg-slate-950 overflow-hidden shrink-0 border-b border-slate-800/80">
        {/* Real Video Element */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
            cameraActive ? 'opacity-90' : 'opacity-0'
          } ${config.mirrorVideo ? 'scale-x-[-1]' : ''}`}
        />

        {/* AR Overlay Canvas */}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />

        {/* Camera fallback / banner if inactive */}
        {!cameraActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 text-center p-4 z-0">
            <Camera size={36} className="text-slate-500 mb-2 animate-bounce" />
            <h3 className="text-sm font-bold text-slate-300">
              {cameraError ? 'Không thể kết nối Camera' : 'Đang khởi động Camera AI...'}
            </h3>
            <p className="text-xs text-slate-500 max-w-md mt-1">
              Bạn có thể sử dụng bàn phím (Phím tắt A, B, C, D) hoặc bấm trực tiếp vào đáp án bên dưới!
            </p>
          </div>
        )}

        {/* Live Score Badges on Camera Top Left/Right */}
        <div className="absolute top-3 left-4 z-20 flex items-center gap-2 rounded-xl bg-slate-950/80 border border-sky-500/50 px-3.5 py-1.5 shadow-lg backdrop-blur-md">
          <div className="h-3 w-3 rounded-full bg-sky-400 animate-ping" />
          <span className="text-xs font-bold text-sky-300">
            {config.swapSides ? config.redPlayerName : config.bluePlayerName}
          </span>
          <span className="font-mono text-base font-extrabold text-white">
            {config.swapSides ? redScore : blueScore} đ
          </span>
        </div>

        {config.playerMode === 'DUEL' && (
          <div className="absolute top-3 right-4 z-20 flex items-center gap-2 rounded-xl bg-slate-950/80 border border-rose-500/50 px-3.5 py-1.5 shadow-lg backdrop-blur-md">
            <div className="h-3 w-3 rounded-full bg-rose-400 animate-ping" />
            <span className="text-xs font-bold text-rose-300">
              {config.swapSides ? config.bluePlayerName : config.redPlayerName}
            </span>
            <span className="font-mono text-base font-extrabold text-white">
              {config.swapSides ? blueScore : redScore} đ
            </span>
          </div>
        )}

        {/* Freeze Badges if Frozen */}
        {freezeSecondsLeft.blue > 0 && (
          <div className="absolute top-1/2 left-1/4 -translate-x-1/2 -translate-y-1/2 z-20 rounded-2xl bg-sky-950/90 border-2 border-sky-400/80 p-4 shadow-2xl backdrop-blur-md text-center animate-pulse">
            <div className="text-2xl">❄️</div>
            <div className="text-xs font-bold text-sky-200 mt-1">ĐÓNG BĂNG</div>
            <div className="font-mono text-xl font-extrabold text-white">
              {freezeSecondsLeft.blue}s
            </div>
          </div>
        )}

        {freezeSecondsLeft.red > 0 && config.playerMode === 'DUEL' && (
          <div className="absolute top-1/2 right-1/4 translate-x-1/2 -translate-y-1/2 z-20 rounded-2xl bg-rose-950/90 border-2 border-rose-400/80 p-4 shadow-2xl backdrop-blur-md text-center animate-pulse">
            <div className="text-2xl">❄️</div>
            <div className="text-xs font-bold text-rose-200 mt-1">ĐÓNG BĂNG</div>
            <div className="font-mono text-xl font-extrabold text-white">
              {freezeSecondsLeft.red}s
            </div>
          </div>
        )}
      </div>

      {/* 3. QUESTION & OPTIONS STAGE (BOTTOM SECTION: ~56% viewport) */}
      <main className="relative flex-1 flex flex-col p-4 overflow-y-auto bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
        {config.examDistributionMode === 'SHARED_SYNC' || config.playerMode === 'SINGLE' ? (
          /* SINGLE or SHARED_SYNC: Single Central Question + 4 Big Options */
          <div className="max-w-4xl w-full mx-auto flex flex-col justify-between h-full space-y-3">
            {/* Question Card */}
            <div className="relative rounded-2xl border border-slate-700/80 bg-slate-900/90 p-4 shadow-xl backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs text-indigo-400 font-bold mb-1.5">
                <span>
                  CÂU HỎI {blueIdx + 1} / {blueQuestions.length}
                </span>
                {config.speedBonusEnabled && (
                  <span className="flex items-center gap-1 text-amber-400 text-[11px]">
                    <Zap size={12} /> Thưởng tốc độ +5đ
                  </span>
                )}
              </div>
              <h2 className="text-base sm:text-lg font-bold text-white leading-snug">
                {currentBlueQ?.question_text || 'Đang tải câu hỏi...'}
              </h2>

              {/* Status of players in SHARED_SYNC */}
              {config.playerMode === 'DUEL' && (
                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-slate-800 text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-sky-400">
                    🔵 {config.bluePlayerName}:{' '}
                    {blueLockedOption !== null ? 'Đã chốt đáp án 🔒' : 'Đang chọn...'}
                  </span>
                  <span className="flex items-center gap-1.5 font-semibold text-rose-400">
                    🔴 {config.redPlayerName}:{' '}
                    {redLockedOption !== null ? 'Đã chốt đáp án 🔒' : 'Đang chọn...'}
                  </span>
                </div>
              )}
            </div>

            {/* 4 Options Grid (2x2) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 pb-1">
              {(currentBlueQ?.options || []).map((optText, optIdx) => {
                const theme = OPTION_THEMES[optIdx % OPTION_THEMES.length];
                const isBluePicked = blueLockedOption === optIdx;
                const isRedPicked = redLockedOption === optIdx;
                const isCorrect = currentBlueQ?.correct_option === optIdx;

                // Highlight correct if revealed on wrong
                const showCorrectHighlight =
                  config.revealAnswerOnWrong &&
                  (blueFlash === 'wrong' || redFlash === 'wrong') &&
                  isCorrect;

                return (
                  <button
                    key={optIdx}
                    type="button"
                    onClick={() => handleLockOption('BLUE', optIdx)}
                    className={`relative flex items-center gap-3.5 rounded-2xl border-2 p-3.5 text-left transition transform active:scale-95 ${
                      theme.bg
                    } ${
                      isBluePicked || isRedPicked
                        ? 'border-indigo-400 ring-2 ring-indigo-400/50'
                        : ''
                    } ${showCorrectHighlight ? 'border-emerald-400 ring-4 ring-emerald-400/60' : ''}`}
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-mono text-base font-extrabold shadow-md ${theme.badge}`}
                    >
                      {theme.letter}
                    </span>
                    <span className="text-sm font-semibold text-slate-100 leading-snug flex-1">
                      {optText}
                    </span>

                    {/* Indicator badges */}
                    <div className="flex flex-col gap-1 items-end">
                      {isBluePicked && (
                        <span className="rounded-full bg-sky-500/30 border border-sky-400 px-2 py-0.5 text-[10px] font-bold text-sky-200">
                          🔵 {config.bluePlayerName}
                        </span>
                      )}
                      {isRedPicked && (
                        <span className="rounded-full bg-rose-500/30 border border-rose-400 px-2 py-0.5 text-[10px] font-bold text-rose-200">
                          🔴 {config.redPlayerName}
                        </span>
                      )}
                      {showCorrectHighlight && (
                        <span className="rounded-full bg-emerald-500/30 border border-emerald-400 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                          ✓ ĐÁP ÁN ĐÚNG
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          /* SAME_EXAM_SHUFFLED or DUAL_EXAMS: Dual 50/50 Split Screen */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
            {/* Left Column (Blue) */}
            <div className="flex flex-col justify-between rounded-2xl border border-sky-500/30 bg-slate-900/80 p-4 shadow-xl">
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold text-sky-400">
                  <span>🔵 {config.bluePlayerName}</span>
                  <span>
                    Câu {blueIdx + 1} / {blueQuestions.length}
                  </span>
                </div>
                <h3 className="text-sm sm:text-base font-bold text-white leading-snug">
                  {currentBlueQ?.question_text || 'Đã hoàn thành!'}
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                {(currentBlueQ?.options || []).map((optText, optIdx) => {
                  const theme = OPTION_THEMES[optIdx % OPTION_THEMES.length];
                  return (
                    <button
                      key={optIdx}
                      type="button"
                      onClick={() => handleLockOption('BLUE', optIdx)}
                      className={`flex items-center gap-2.5 rounded-xl border p-2.5 text-left text-xs font-semibold transition ${theme.bg}`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono font-bold ${theme.badge}`}
                      >
                        {theme.letter}
                      </span>
                      <span className="truncate">{optText}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Column (Red) */}
            <div className="flex flex-col justify-between rounded-2xl border border-rose-500/30 bg-slate-900/80 p-4 shadow-xl">
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold text-rose-400">
                  <span>🔴 {config.redPlayerName}</span>
                  <span>
                    Câu {redIdx + 1} / {redQuestions.length}
                  </span>
                </div>
                <h3 className="text-sm sm:text-base font-bold text-white leading-snug">
                  {currentRedQ?.question_text || 'Đã hoàn thành!'}
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                {(currentRedQ?.options || []).map((optText, optIdx) => {
                  const theme = OPTION_THEMES[optIdx % OPTION_THEMES.length];
                  return (
                    <button
                      key={optIdx}
                      type="button"
                      onClick={() => handleLockOption('RED', optIdx)}
                      className={`flex items-center gap-2.5 rounded-xl border p-2.5 text-left text-xs font-semibold transition ${theme.bg}`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono font-bold ${theme.badge}`}
                      >
                        {theme.letter}
                      </span>
                      <span className="truncate">{optText}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 4. IN-GAME LIVE SETTINGS DRAWER / POPOVER */}
      {showSettings && (
        <div className="absolute right-4 top-14 z-50 w-80 rounded-2xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-xl space-y-4 animate-in slide-in-from-top-2 duration-150 text-xs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span className="font-bold text-white flex items-center gap-1.5">
              <Settings size={14} className="text-purple-400" /> Cài đặt nhanh trong trận
            </span>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="text-slate-400 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          {/* Hold Duration Slider */}
          <div className="space-y-1">
            <div className="flex justify-between text-slate-300">
              <span>Thời gian giữ chốt:</span>
              <span className="font-mono text-purple-300">
                {(config.holdDurationMs / 1000).toFixed(1)}s
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={3.0}
              step={0.1}
              value={config.holdDurationMs / 1000}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  holdDurationMs: Math.round(Number(e.target.value) * 1000),
                }))
              }
              className="w-full accent-purple-500"
            />
          </div>

          {/* Split Ratio Slider */}
          {config.playerMode === 'DUEL' && (
            <div className="space-y-1">
              <div className="flex justify-between text-slate-300">
                <span>Vạch chia camera:</span>
                <span className="font-mono text-purple-300">
                  {Math.round(config.splitRatio * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.3}
                max={0.7}
                step={0.05}
                value={config.splitRatio}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    splitRatio: Number(e.target.value),
                  }))
                }
                className="w-full accent-purple-500"
              />
            </div>
          )}

          {/* AI Confidence */}
          <div className="space-y-1">
            <div className="flex justify-between text-slate-300">
              <span>Độ nhạy AI:</span>
              <span className="font-mono text-purple-300">
                {Math.round(config.minConfidence * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.4}
              max={0.85}
              step={0.05}
              value={config.minConfidence}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  minConfidence: Number(e.target.value),
                }))
              }
              className="w-full accent-purple-500"
            />
          </div>

          {/* Freeze Penalty */}
          <div className="space-y-1">
            <div className="flex justify-between text-slate-300">
              <span>Phạt đóng băng khi sai:</span>
              <span className="font-mono text-purple-300">{config.wrongPenaltySeconds}s</span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={config.wrongPenaltySeconds}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  wrongPenaltySeconds: Number(e.target.value),
                }))
              }
              className="w-full accent-purple-500"
            />
          </div>

          {/* Advance Mode */}
          <div className="space-y-1.5 pt-1 border-t border-slate-800">
            <span className="text-slate-300">Chế độ chuyển câu:</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setConfig((prev) => ({ ...prev, advanceMode: 'AUTO' }))}
                className={`py-1 rounded font-bold transition ${
                  config.advanceMode === 'AUTO'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                Tự động
              </button>
              <button
                type="button"
                onClick={() =>
                  setConfig((prev) => ({ ...prev, advanceMode: 'MANUAL_TEACHER' }))
                }
                className={`py-1 rounded font-bold transition ${
                  config.advanceMode === 'MANUAL_TEACHER'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                Giáo viên bấm
              </button>
            </div>
          </div>

          {/* Skeleton & Mirror toggles */}
          <div className="space-y-1.5 pt-1 border-t border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer text-slate-300">
              <input
                type="checkbox"
                checked={config.showSkeleton}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, showSkeleton: e.target.checked }))
                }
                className="rounded border-slate-700 bg-slate-800 text-purple-600"
              />
              Hiện khung xương AR trên camera
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-slate-300">
              <input
                type="checkbox"
                checked={config.mirrorVideo}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, mirrorVideo: e.target.checked }))
                }
                className="rounded border-slate-700 bg-slate-800 text-purple-600"
              />
              Lật gương camera (Mirror)
            </label>
          </div>
        </div>
      )}

      {/* 5. VICTORY / GAME OVER MODAL */}
      {isGameOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-gradient-to-b from-slate-900 to-slate-950 p-6 text-center shadow-2xl space-y-4">
            <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-yellow-600 text-3xl shadow-xl shadow-amber-500/30">
              🏆
            </div>

            <div>
              <h2 className="text-xl font-black text-white">TRẬN ĐẤU KẾT THÚC!</h2>
              <p className="text-xs text-amber-300 font-semibold mt-1">{winnerMessage}</p>
            </div>

            {/* Final Scores Card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-4">
              {config.playerMode === 'SINGLE' ? (
                <div className="space-y-1">
                  <div className="text-xs text-slate-400">{config.bluePlayerName}</div>
                  <div className="font-mono text-3xl font-black text-indigo-400">
                    {blueScore} điểm
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 divide-x divide-slate-800">
                  <div className="space-y-1 px-2">
                    <div className="text-xs font-bold text-sky-400">{config.bluePlayerName}</div>
                    <div className="font-mono text-3xl font-black text-white">{blueScore} đ</div>
                  </div>
                  <div className="space-y-1 px-2">
                    <div className="text-xs font-bold text-rose-400">{config.redPlayerName}</div>
                    <div className="font-mono text-3xl font-black text-white">{redScore} đ</div>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setTimeLeft(config.durationSeconds);
                  setBlueIdx(0);
                  setRedIdx(0);
                  setBlueScore(0);
                  setRedScore(0);
                  setIsGameOver(false);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 hover:brightness-110 transition"
              >
                <RotateCcw size={14} /> Chơi lại
              </button>

              <button
                type="button"
                onClick={() => {
                  if (onExit) onExit();
                  else router.back();
                }}
                className="flex-1 rounded-xl border border-slate-700 bg-slate-800 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700 transition"
              >
                Thoát về lớp học
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
