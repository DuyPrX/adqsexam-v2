'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  Award,
  Clock,
  Flag,
  Maximize2,
  Minimize2,
  RefreshCw,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { submitTugOfWarAnswer } from '@/lib/tugOfWar';
import type {
  TugOfWarQuestionItem,
  TugOfWarSessionDetail,
  TugOfWarTeam,
} from '@/lib/types';

interface TugOfWarArenaProps {
  initialSession: TugOfWarSessionDetail;
}

// 4 Vibrant Option Themes Matching Requirements
export const OPTION_THEMES = [
  {
    label: 'A',
    colorHex: '#ef4444',
    borderClass: 'border-[#ef4444]',
    bgClass: 'bg-[#ef4444]/15 hover:bg-[#ef4444]/25',
    badgeClass: 'bg-[#ef4444] text-white',
    textClass: 'text-rose-100',
    ringClass: 'ring-[#ef4444]/50',
  },
  {
    label: 'B',
    colorHex: '#3b82f6',
    borderClass: 'border-[#3b82f6]',
    bgClass: 'bg-[#3b82f6]/15 hover:bg-[#3b82f6]/25',
    badgeClass: 'bg-[#3b82f6] text-white',
    textClass: 'text-blue-100',
    ringClass: 'ring-[#3b82f6]/50',
  },
  {
    label: 'C',
    colorHex: '#f59e0b',
    borderClass: 'border-[#f59e0b]',
    bgClass: 'bg-[#f59e0b]/15 hover:bg-[#f59e0b]/25',
    badgeClass: 'bg-[#f59e0b] text-slate-950 font-black',
    textClass: 'text-amber-100',
    ringClass: 'ring-[#f59e0b]/50',
  },
  {
    label: 'D',
    colorHex: '#10b981',
    borderClass: 'border-[#10b981]',
    bgClass: 'bg-[#10b981]/15 hover:bg-[#10b981]/25',
    badgeClass: 'bg-[#10b981] text-white',
    textClass: 'text-emerald-100',
    ringClass: 'ring-[#10b981]/50',
  },
];

// Simple Web Audio Sound Engine
class SoundEffects {
  private ctx: AudioContext | null = null;
  public isMuted = false;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  playCorrect() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1); // E5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.2); // G5
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Ignore audio error
    }
  }

  playWrong() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.linearRampToValueAtTime(110, now + 0.3);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Ignore audio error
    }
  }

  playVictory() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const now = (this.ctx?.currentTime || 0) + i * 0.12;
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        osc.connect(gain);
        gain.connect(this.ctx!.destination);
        osc.start(now);
        osc.stop(now + 0.4);
      });
    } catch {
      // Ignore
    }
  }
}

const sounds = new SoundEffects();

export function TugOfWarArena({ initialSession }: TugOfWarArenaProps) {
  const router = useRouter();
  const [session, setSession] = useState<TugOfWarSessionDetail>(initialSession);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [submittingTeam, setSubmittingTeam] = useState<TugOfWarTeam | null>(null);

  // Flash Feedback states: 'correct' | 'wrong' | null
  const [blueFlash, setBlueFlash] = useState<'correct' | 'wrong' | null>(null);
  const [redFlash, setRedFlash] = useState<'correct' | 'wrong' | null>(null);

  // Delayed Question switch on freeze: question stays frozen until thaw finishes
  const [blueFrozenLagIdx, setBlueFrozenLagIdx] = useState<number>(session.blue_current_idx);
  const [redFrozenLagIdx, setRedFrozenLagIdx] = useState<number>(session.red_current_idx);

  // Victory celebration trigger guard
  const hasCelebrated = useRef(false);

  // Fullscreen tracker
  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    setIsFullscreen(Boolean(document.fullscreenElement));
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore
    }
  }, []);

  // Tick timer every 100ms for countdown and freeze precision
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Subscribe to Realtime updates on this session
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`tug-arena-${session.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tug_of_war_sessions',
          filter: `id=eq.${session.id}`,
        },
        (payload) => {
          const updated = payload.new as TugOfWarSessionDetail;
          setSession((prev) => ({
            ...prev,
            ...updated,
          }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session.id]);

  // Check victory celebration
  useEffect(() => {
    if (session.status === 'FINISHED' && !hasCelebrated.current) {
      hasCelebrated.current = true;
      sounds.playVictory();
    }
  }, [session.status]);

  // Calculate remaining match time
  const remainingSeconds = useMemo(() => {
    if (!session.ends_at) return session.duration_seconds;
    const ends = new Date(session.ends_at).getTime();
    return Math.max(0, Math.floor((ends - now) / 1000));
  }, [session.ends_at, session.duration_seconds, now]);

  // Format MM:SS
  const timerDisplay = useMemo(() => {
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, [remainingSeconds]);

  // Freeze remaining calculations
  const blueFreezeRemaining = useMemo(() => {
    if (!session.blue_frozen_until) return 0;
    const freezeUntil = new Date(session.blue_frozen_until).getTime();
    return Math.max(0, (freezeUntil - now) / 1000);
  }, [session.blue_frozen_until, now]);

  const redFreezeRemaining = useMemo(() => {
    if (!session.red_frozen_until) return 0;
    const freezeUntil = new Date(session.red_frozen_until).getTime();
    return Math.max(0, (freezeUntil - now) / 1000);
  }, [session.red_frozen_until, now]);

  // Sync displayed question index with freeze completion
  useEffect(() => {
    if (blueFreezeRemaining <= 0) {
      setBlueFrozenLagIdx(session.blue_current_idx);
    }
  }, [blueFreezeRemaining, session.blue_current_idx]);

  useEffect(() => {
    if (redFreezeRemaining <= 0) {
      setRedFrozenLagIdx(session.red_current_idx);
    }
  }, [redFreezeRemaining, session.red_current_idx]);

  // Effective question indices (keeps current question on screen during freeze penalty)
  const effectiveBlueIdx = blueFreezeRemaining > 0 ? blueFrozenLagIdx : session.blue_current_idx;
  const effectiveRedIdx = redFreezeRemaining > 0 ? redFrozenLagIdx : session.red_current_idx;

  // Retrieve current questions: Blue from blue_questions, Red from red_questions
  const blueCurrentQuestion: TugOfWarQuestionItem | null = useMemo(() => {
    if (effectiveBlueIdx >= session.question_count) return null;
    if (session.blue_questions && session.blue_questions.length > effectiveBlueIdx) {
      return session.blue_questions[effectiveBlueIdx];
    }
    const poolIdx = session.blue_question_order[effectiveBlueIdx];
    return session.questions_pool[poolIdx] || null;
  }, [effectiveBlueIdx, session.question_count, session.blue_questions, session.blue_question_order, session.questions_pool]);

  const redCurrentQuestion: TugOfWarQuestionItem | null = useMemo(() => {
    if (effectiveRedIdx >= session.question_count) return null;
    if (session.red_questions && session.red_questions.length > effectiveRedIdx) {
      return session.red_questions[effectiveRedIdx];
    }
    const poolIdx = session.red_question_order[effectiveRedIdx];
    return session.questions_pool[poolIdx] || null;
  }, [effectiveRedIdx, session.question_count, session.red_questions, session.red_question_order, session.questions_pool]);

  // Keybindings
  const blueKeys = useMemo<[string, string, string, string]>(() => {
    return session.keybindings?.blue || ['Q', 'W', 'A', 'S'];
  }, [session.keybindings]);

  const redKeys = useMemo<[string, string, string, string]>(() => {
    return session.keybindings?.red || ['O', 'P', 'K', 'L'];
  }, [session.keybindings]);

  // Answer Submission Handler
  const handleAnswer = useCallback(
    async (team: TugOfWarTeam, optionIdx: number) => {
      if (session.status !== 'ACTIVE' || remainingSeconds <= 0) return;

      if (team === 'BLUE' && blueFreezeRemaining > 0) return;
      if (team === 'RED' && redFreezeRemaining > 0) return;

      const currentIdx = team === 'BLUE' ? session.blue_current_idx : session.red_current_idx;
      setSubmittingTeam(team);

      try {
        const supabase = createClient();
        const res = await submitTugOfWarAnswer(supabase, {
          sessionCode: session.session_code,
          team,
          questionIdx: currentIdx,
          selectedOption: optionIdx,
          studentCode: 'PROJECTOR_BOARD',
        });

        if (res.success) {
          if (res.is_correct) {
            sounds.playCorrect();
            if (team === 'BLUE') {
              setBlueFlash('correct');
              setTimeout(() => setBlueFlash(null), 450);
            } else {
              setRedFlash('correct');
              setTimeout(() => setRedFlash(null), 450);
            }
          } else {
            sounds.playWrong();
            if (team === 'BLUE') {
              setBlueFlash('wrong');
              setTimeout(() => setBlueFlash(null), 450);
              setBlueFrozenLagIdx(currentIdx);
            } else {
              setRedFlash('wrong');
              setTimeout(() => setRedFlash(null), 450);
              setRedFrozenLagIdx(currentIdx);
            }
          }

          setSession((prev) => ({
            ...prev,
            blue_score: res.blue_score ?? prev.blue_score,
            red_score: res.red_score ?? prev.red_score,
            blue_current_idx: res.blue_current_idx ?? prev.blue_current_idx,
            red_current_idx: res.red_current_idx ?? prev.red_current_idx,
            blue_frozen_until: res.blue_frozen_until ?? prev.blue_frozen_until,
            red_frozen_until: res.red_frozen_until ?? prev.red_frozen_until,
            status: (res.status as TugOfWarSessionDetail['status']) ?? prev.status,
            winner: res.winner ?? prev.winner,
          }));
        }
      } catch (err) {
        console.error('Answer submission error:', err);
      } finally {
        setSubmittingTeam(null);
      }
    },
    [session, remainingSeconds, blueFreezeRemaining, redFreezeRemaining],
  );

  // Keyboard shortcut listener matching configured keybindings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      const key = e.key.toUpperCase();

      // Check Blue keys
      const bIdx = blueKeys.findIndex((k) => k.toUpperCase() === key);
      if (bIdx >= 0) {
        void handleAnswer('BLUE', bIdx);
        return;
      }

      // Check Red keys
      const rIdx = redKeys.findIndex((k) => k.toUpperCase() === key);
      if (rIdx >= 0) {
        void handleAnswer('RED', rIdx);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleAnswer, blueKeys, redKeys]);

  // Dynamic Rope Offset Percentage (-100% to +100%)
  const ropeOffsetPercentage = useMemo(() => {
    const gap = session.win_gap > 0 ? session.win_gap : 5;
    const diff = session.red_score - session.blue_score;
    const ratio = diff / gap;
    return Math.max(-100, Math.min(100, ratio * 100));
  }, [session.blue_score, session.red_score, session.win_gap]);

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 select-none overflow-hidden relative font-sans">
      {/* 1. TOP HEADER BAR (#0f172a) */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 bg-[#0f172a] px-6 shadow-md z-20">
        {/* Left: Yellow Bold Exam Title */}
        <div className="flex items-center gap-3">
          <span className="text-xl">⚔️</span>
          <h1 className="text-sm font-extrabold text-amber-400 sm:text-base tracking-tight truncate max-w-xs md:max-w-md">
            {session.title}
          </h1>
        </div>

        {/* Center: Blue Score vs Red Score + Central Timer Box */}
        <div className="flex items-center gap-3">
          {/* Blue Pill */}
          <div className="flex items-center gap-2 rounded-full border border-blue-500/50 bg-blue-600/20 px-3.5 py-1 shadow-sm">
            <span className="text-xs font-bold uppercase text-blue-300">🔵 {session.blue_team_name}</span>
            <span className="font-mono text-lg font-black text-blue-400">{session.blue_score}</span>
          </div>

          {/* Central Timer Box */}
          <div className="flex items-center gap-2 rounded-2xl border-2 border-amber-500/60 bg-slate-900/95 px-4 py-1 shadow-lg shadow-amber-500/10">
            <Clock size={16} className="text-amber-400 animate-pulse" />
            <span className="font-mono text-xl font-black tracking-wider text-amber-400">
              {timerDisplay}
            </span>
          </div>

          {/* Red Pill */}
          <div className="flex items-center gap-2 rounded-full border border-rose-500/50 bg-rose-600/20 px-3.5 py-1 shadow-sm">
            <span className="font-mono text-lg font-black text-rose-400">{session.red_score}</span>
            <span className="text-xs font-bold uppercase text-rose-300">{session.red_team_name} 🔴</span>
          </div>
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const nextMuted = !isMuted;
              setIsMuted(nextMuted);
              sounds.isMuted = nextMuted;
            }}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
          >
            {isMuted ? <VolumeX size={14} className="text-rose-400" /> : <Volume2 size={14} className="text-emerald-400" />}
            <span>{isMuted ? 'Bật âm' : 'Tắt âm'}</span>
          </button>

          <button
            type="button"
            onClick={handleToggleFullscreen}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>

          <button
            type="button"
            onClick={() => router.push('/classes')}
            className="flex items-center gap-1.5 rounded-xl border border-rose-800/60 bg-rose-950/40 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-900/60 transition"
          >
            <ArrowLeft size={14} />
            <span>Thoát</span>
          </button>
        </div>
      </header>

      {/* 2. TOP STAGE: HORIZONTAL STADIUM ROPE ARENA (~32% height) */}
      <section className="h-[32%] shrink-0 flex flex-col justify-between border-b border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900/90 to-slate-950 px-6 py-2 relative overflow-hidden shadow-xl">
        {/* Stadium lighting glow */}
        <div className="absolute -top-20 left-1/4 h-36 w-72 rounded-full bg-blue-600/15 blur-3xl pointer-events-none" />
        <div className="absolute -top-20 right-1/4 h-36 w-72 rounded-full bg-rose-600/15 blur-3xl pointer-events-none" />

        {/* Top Arena Indicator Bar */}
        <div className="flex items-center justify-between text-xs font-bold z-10">
          <div className="flex items-center gap-2 text-blue-400">
            <Flag size={14} />
            <span>← ĐỘI XANH KÉO VỀ ĐÂY</span>
          </div>

          <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-4 py-0.5 border border-slate-700/60 text-slate-300 font-medium">
            <span>Hiệu số dẫn:</span>
            <span className="font-mono font-bold text-amber-400">
              {Math.abs(session.blue_score - session.red_score)} câu
            </span>
            {session.win_gap > 0 && (
              <span className="text-[11px] text-slate-400">(Cách biệt thắng: {session.win_gap})</span>
            )}
          </div>

          <div className="flex items-center gap-2 text-rose-400">
            <span>ĐỘI ĐỎ KÉO VỀ ĐÂY →</span>
            <Flag size={14} />
          </div>
        </div>

        {/* Dynamic Animated Tug of War SVG Stage */}
        <div className="flex-1 flex items-center justify-center relative w-full overflow-hidden">
          {/* Center Dashed Marker Line (#22c55e) */}
          <div className="absolute top-0 bottom-4 left-1/2 -translate-x-1/2 w-0 border-l-2 border-dashed border-[#22c55e] z-10">
            <div className="absolute top-0 -translate-x-1/2 rounded bg-[#22c55e] px-2 py-0.5 text-[9px] font-black text-slate-950 shadow">
              TRUNG TÂM
            </div>
          </div>

          {/* Interpolated Tug of War Characters + Rope Group */}
          <div
            className="relative w-full max-w-4xl flex items-center justify-center transition-transform duration-500 ease-out"
            style={{
              transform: `translateX(${ropeOffsetPercentage * 2.2}px)`,
            }}
          >
            <svg
              viewBox="0 0 800 200"
              className="w-full h-auto max-h-[170px] select-none pointer-events-none overflow-visible"
            >
              <defs>
                <linearGradient id="ropeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#d97706" />
                  <stop offset="50%" stopColor="#b45309" />
                  <stop offset="100%" stopColor="#78350f" />
                </linearGradient>
                <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
                  <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.3" />
                </filter>
              </defs>

              {/* Ground Line */}
              <line x1="20" y1="175" x2="780" y2="175" stroke="#334155" strokeWidth="3" strokeLinecap="round" />

              {/* 3 Blue Pullers (Left) */}
              <g className="blue-pullers" transform="translate(100, 20)">
                <g transform="translate(0, 0)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="50" cy="50" r="16" fill="#3b82f6" />
                  <circle cx="48" cy="48" r="4" fill="#ffffff" />
                  <path d="M 50 66 L 40 120 L 25 155" stroke="#1d4ed8" strokeWidth="11" strokeLinecap="round" fill="none" />
                  <path d="M 40 100 L 70 120" stroke="#1d4ed8" strokeWidth="9" strokeLinecap="round" />
                  <path d="M 45 80 L 80 105" stroke="#1d4ed8" strokeWidth="7" strokeLinecap="round" />
                </g>
                <g transform="translate(65, 5)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="50" cy="50" r="16" fill="#2563eb" />
                  <circle cx="48" cy="48" r="4" fill="#ffffff" />
                  <path d="M 50 66 L 40 120 L 25 155" stroke="#1e40af" strokeWidth="11" strokeLinecap="round" fill="none" />
                  <path d="M 40 100 L 70 120" stroke="#1e40af" strokeWidth="9" strokeLinecap="round" />
                  <path d="M 45 80 L 80 105" stroke="#1e40af" strokeWidth="7" strokeLinecap="round" />
                </g>
                <g transform="translate(130, 8)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="50" cy="50" r="17" fill="#1d4ed8" />
                  <circle cx="48" cy="48" r="4" fill="#ffffff" />
                  <path d="M 50 66 L 40 120 L 20 155" stroke="#172554" strokeWidth="12" strokeLinecap="round" fill="none" />
                  <path d="M 40 100 L 70 120" stroke="#172554" strokeWidth="10" strokeLinecap="round" />
                  <path d="M 45 80 L 80 105" stroke="#172554" strokeWidth="8" strokeLinecap="round" />
                </g>
              </g>

              {/* The Tension ROPE */}
              <path
                d="M 120 128 C 260 129, 540 129, 680 128"
                stroke="url(#ropeGrad)"
                strokeWidth="12"
                strokeLinecap="round"
                filter="url(#shadow)"
              />

              {/* Center Red Ribbon Knot Marker */}
              <g transform="translate(400, 128)">
                <circle cx="0" cy="0" r="11" fill="#ef4444" stroke="#991b1b" strokeWidth="2" filter="url(#shadow)" />
                <path d="M 0 0 L -8 26 L 0 21 L 8 26 Z" fill="#dc2626" />
                <path d="M 0 0 L -11 24 L 0 19 L 5 28 Z" fill="#ef4444" />
              </g>

              {/* 3 Red Pullers (Right) */}
              <g className="red-pullers" transform="translate(480, 20)">
                <g transform="translate(0, 8)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="70" cy="50" r="16" fill="#dc2626" />
                  <circle cx="72" cy="48" r="4" fill="#ffffff" />
                  <path d="M 70 66 L 80 120 L 95 155" stroke="#b91c1c" strokeWidth="11" strokeLinecap="round" fill="none" />
                  <path d="M 80 100 L 50 120" stroke="#b91c1c" strokeWidth="9" strokeLinecap="round" />
                  <path d="M 75 80 L 40 105" stroke="#b91c1c" strokeWidth="7" strokeLinecap="round" />
                </g>
                <g transform="translate(65, 5)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="70" cy="50" r="16" fill="#ef4444" />
                  <circle cx="72" cy="48" r="4" fill="#ffffff" />
                  <path d="M 70 66 L 80 120 L 95 155" stroke="#dc2626" strokeWidth="11" strokeLinecap="round" fill="none" />
                  <path d="M 80 100 L 50 120" stroke="#dc2626" strokeWidth="9" strokeLinecap="round" />
                  <path d="M 75 80 L 40 105" stroke="#dc2626" strokeWidth="7" strokeLinecap="round" />
                </g>
                <g transform="translate(130, 0)">
                  <ellipse cx="60" cy="155" rx="18" ry="5" fill="#1e293b" opacity="0.6" />
                  <circle cx="70" cy="50" r="17" fill="#b91c1c" />
                  <circle cx="72" cy="48" r="4" fill="#ffffff" />
                  <path d="M 70 66 L 80 120 L 100 155" stroke="#7f1d1d" strokeWidth="12" strokeLinecap="round" fill="none" />
                  <path d="M 80 100 L 50 120" stroke="#7f1d1d" strokeWidth="10" strokeLinecap="round" />
                  <path d="M 75 80 L 40 105" stroke="#7f1d1d" strokeWidth="8" strokeLinecap="round" />
                </g>
              </g>
            </svg>
          </div>
        </div>

        {/* Tension Balance Track */}
        <div className="w-full max-w-xl mx-auto z-10 pb-1">
          <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden relative border border-slate-700/60 shadow-inner">
            <div
              className="absolute top-0 bottom-0 transition-all duration-300"
              style={{
                left: ropeOffsetPercentage < 0 ? `${50 + ropeOffsetPercentage / 2}%` : '50%',
                right: ropeOffsetPercentage > 0 ? `${50 - ropeOffsetPercentage / 2}%` : '50%',
                backgroundColor: ropeOffsetPercentage < 0 ? '#3b82f6' : '#ef4444',
              }}
            />
            <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-amber-400 -translate-x-1/2" />
          </div>
        </div>
      </section>

      {/* 3. BOTTOM STAGE: 50% / 50% SPLIT (BLUE vs RED QUESTIONS & OPTIONS) (~60% height) */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 overflow-hidden relative">
        {/* LEFT COLUMN: BLUE TEAM QUESTION & 4 VIBRANT COLOR OPTIONS */}
        <section
          className={`flex flex-col rounded-3xl border-2 transition-all duration-300 p-5 shadow-2xl relative overflow-hidden backdrop-blur ${
            blueFlash === 'correct'
              ? 'border-emerald-400 ring-8 ring-emerald-400/40 bg-emerald-950/40 is-correct-flash'
              : blueFlash === 'wrong'
              ? 'border-rose-500 ring-8 ring-rose-500/40 bg-rose-950/40 is-wrong-flash'
              : 'border-blue-500/50 bg-[#1e40af]/20'
          }`}
        >
          {/* Blue Team Header */}
          <div className="flex items-center justify-between border-b border-blue-400/30 pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black shadow">
                🔵
              </span>
              <h2 className="text-base font-black uppercase text-blue-200">
                {session.blue_team_name}
              </h2>
            </div>
            <span className="rounded-full bg-blue-500/30 px-3 py-0.5 text-xs font-bold text-blue-300">
              Câu {Math.min(effectiveBlueIdx + 1, session.question_count)} / {session.question_count}
            </span>
          </div>

          {/* Blue Question Content */}
          <div className="flex-1 flex flex-col justify-between">
            {effectiveBlueIdx >= session.question_count ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-blue-400/40 bg-blue-900/30 p-6 text-center">
                <Sparkles size={36} className="text-blue-300 mb-2 animate-bounce" />
                <h3 className="text-lg font-black text-white">ĐÃ HOÀN THÀNH TẤT CẢ CÂU HỎI!</h3>
                <p className="text-xs text-blue-200 mt-1">Đang chờ đối thủ hoặc kết thúc trận đấu...</p>
              </div>
            ) : blueCurrentQuestion ? (
              <>
                {/* Large Legible Question Box */}
                <div className="rounded-2xl border border-blue-400/30 bg-slate-900/90 p-4 shadow-inner mb-3 flex-1 flex items-center justify-center">
                  <p className="text-base font-bold text-white text-center leading-relaxed">
                    {blueCurrentQuestion.question_text}
                  </p>
                </div>

                {/* 2x2 Option Grid with 4 Vibrant Themes */}
                <div className="grid grid-cols-2 gap-3">
                  {blueCurrentQuestion.options.slice(0, 4).map((opt, optIdx) => {
                    const theme = OPTION_THEMES[optIdx] || OPTION_THEMES[0];
                    const keyLabel = blueKeys[optIdx] || theme.label;
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => void handleAnswer('BLUE', optIdx)}
                        disabled={blueFreezeRemaining > 0 || submittingTeam === 'BLUE'}
                        className={`group relative flex items-center gap-3 rounded-2xl border-2 ${theme.borderClass} ${theme.bgClass} p-3.5 text-left shadow-lg transition active:scale-95 hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none`}
                      >
                        {/* Keybinding Badge + Option Prefix A., B., C., D. */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`flex h-7 w-7 items-center justify-center rounded-xl ${theme.badgeClass} text-xs font-black shadow`}>
                            {theme.label}
                          </span>
                          <span className="font-mono text-[11px] font-bold text-slate-400 px-1 py-0.5 rounded bg-slate-900/80 border border-slate-700">
                            [{keyLabel}]
                          </span>
                        </div>
                        <span className="text-xs sm:text-sm font-bold text-white leading-snug line-clamp-2">
                          <strong className="text-amber-300 mr-1">{theme.label}.</strong>
                          {opt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>

          {/* Icy Frost Freeze Overlay */}
          {blueFreezeRemaining > 0 && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center rounded-3xl bg-cyan-950/85 backdrop-blur-md border-4 border-cyan-400/60 p-6 text-center animate-in fade-in duration-150">
              <span className="text-5xl mb-2 animate-spin">❄️</span>
              <h3 className="text-xl font-black uppercase text-cyan-200 tracking-wider">
                ĐÓNG BĂNG!
              </h3>
              <p className="text-xs text-cyan-300 mt-1">
                Trả lời sai! Hãy nhìn lại câu hỏi bên dưới và chờ phạt...
              </p>
              <div className="mt-3 rounded-2xl border-2 border-cyan-400 bg-cyan-900/90 px-6 py-2 shadow-lg">
                <span className="font-mono text-3xl font-black text-white">
                  {blueFreezeRemaining.toFixed(1)}s
                </span>
              </div>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: RED TEAM QUESTION & 4 VIBRANT COLOR OPTIONS */}
        <section
          className={`flex flex-col rounded-3xl border-2 transition-all duration-300 p-5 shadow-2xl relative overflow-hidden backdrop-blur ${
            redFlash === 'correct'
              ? 'border-emerald-400 ring-8 ring-emerald-400/40 bg-emerald-950/40 is-correct-flash'
              : redFlash === 'wrong'
              ? 'border-rose-500 ring-8 ring-rose-500/40 bg-rose-950/40 is-wrong-flash'
              : 'border-rose-500/50 bg-[#b91c1c]/20'
          }`}
        >
          {/* Red Team Header */}
          <div className="flex items-center justify-between border-b border-rose-400/30 pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-600 text-xs font-black shadow">
                🔴
              </span>
              <h2 className="text-base font-black uppercase text-rose-200">
                {session.red_team_name}
              </h2>
            </div>
            <span className="rounded-full bg-rose-500/30 px-3 py-0.5 text-xs font-bold text-rose-300">
              Câu {Math.min(effectiveRedIdx + 1, session.question_count)} / {session.question_count}
            </span>
          </div>

          {/* Red Question Content */}
          <div className="flex-1 flex flex-col justify-between">
            {effectiveRedIdx >= session.question_count ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-900/30 p-6 text-center">
                <Sparkles size={36} className="text-rose-300 mb-2 animate-bounce" />
                <h3 className="text-lg font-black text-white">ĐÃ HOÀN THÀNH TẤT CẢ CÂU HỎI!</h3>
                <p className="text-xs text-rose-200 mt-1">Đang chờ đối thủ hoặc kết thúc trận đấu...</p>
              </div>
            ) : redCurrentQuestion ? (
              <>
                {/* Large Legible Question Box */}
                <div className="rounded-2xl border border-rose-400/30 bg-slate-900/90 p-4 shadow-inner mb-3 flex-1 flex items-center justify-center">
                  <p className="text-base font-bold text-white text-center leading-relaxed">
                    {redCurrentQuestion.question_text}
                  </p>
                </div>

                {/* 2x2 Option Grid with 4 Vibrant Themes */}
                <div className="grid grid-cols-2 gap-3">
                  {redCurrentQuestion.options.slice(0, 4).map((opt, optIdx) => {
                    const theme = OPTION_THEMES[optIdx] || OPTION_THEMES[0];
                    const keyLabel = redKeys[optIdx] || theme.label;
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => void handleAnswer('RED', optIdx)}
                        disabled={redFreezeRemaining > 0 || submittingTeam === 'RED'}
                        className={`group relative flex items-center gap-3 rounded-2xl border-2 ${theme.borderClass} ${theme.bgClass} p-3.5 text-left shadow-lg transition active:scale-95 hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none`}
                      >
                        {/* Keybinding Badge + Option Prefix A., B., C., D. */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`flex h-7 w-7 items-center justify-center rounded-xl ${theme.badgeClass} text-xs font-black shadow`}>
                            {theme.label}
                          </span>
                          <span className="font-mono text-[11px] font-bold text-slate-400 px-1 py-0.5 rounded bg-slate-900/80 border border-slate-700">
                            [{keyLabel}]
                          </span>
                        </div>
                        <span className="text-xs sm:text-sm font-bold text-white leading-snug line-clamp-2">
                          <strong className="text-amber-300 mr-1">{theme.label}.</strong>
                          {opt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>

          {/* Icy Frost Freeze Overlay */}
          {redFreezeRemaining > 0 && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center rounded-3xl bg-cyan-950/85 backdrop-blur-md border-4 border-cyan-400/60 p-6 text-center animate-in fade-in duration-150">
              <span className="text-5xl mb-2 animate-spin">❄️</span>
              <h3 className="text-xl font-black uppercase text-cyan-200 tracking-wider">
                ĐÓNG BĂNG!
              </h3>
              <p className="text-xs text-cyan-300 mt-1">
                Trả lời sai! Hãy nhìn lại câu hỏi bên dưới và chờ phạt...
              </p>
              <div className="mt-3 rounded-2xl border-2 border-cyan-400 bg-cyan-900/90 px-6 py-2 shadow-lg">
                <span className="font-mono text-3xl font-black text-white">
                  {redFreezeRemaining.toFixed(1)}s
                </span>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* 4. VICTORY CELEBRATION MODAL */}
      {session.status === 'FINISHED' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-lg p-6 animate-in fade-in zoom-in-95 duration-200">
          <div className="relative w-full max-w-lg rounded-3xl border-2 border-amber-500/60 bg-gradient-to-b from-slate-900 via-slate-900/95 to-slate-950 p-8 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-amber-500/20 text-5xl shadow-xl shadow-amber-500/20">
              {session.winner === 'BLUE' ? '🔵' : session.winner === 'RED' ? '🔴' : '🤝'}
            </div>

            <h2 className="text-3xl font-black uppercase tracking-wider text-amber-400">
              {session.winner === 'BLUE'
                ? `${session.blue_team_name} CHIẾN THẮNG!`
                : session.winner === 'RED'
                ? `${session.red_team_name} CHIẾN THẮNG!`
                : 'HAI ĐỘI HÒA NHAU!'}
            </h2>

            <p className="mt-2 text-sm text-slate-300">
              {session.winner
                ? 'Một trận kéo co tri thức vô cùng kịch tính và xuất sắc!'
                : 'Cả hai đội thi đấu ngang tài ngang sức cho đến giây cuối cùng!'}
            </p>

            {/* Score Summary Box */}
            <div className="my-6 grid grid-cols-2 gap-4 rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
              <div className="flex flex-col items-center border-r border-slate-800">
                <span className="text-xs font-bold text-blue-300 uppercase">
                  {session.blue_team_name}
                </span>
                <span className="font-mono text-4xl font-black text-blue-400 mt-1">
                  {session.blue_score}
                </span>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold text-rose-300 uppercase">
                  {session.red_team_name}
                </span>
                <span className="font-mono text-4xl font-black text-rose-400 mt-1">
                  {session.red_score}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => router.push('/classes')}
                className="flex items-center gap-2 rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-extrabold text-slate-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400 transition"
              >
                <span>Về Danh Sách Lớp</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
