'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  Award,
  Clock,
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

// Simple Web Audio Sound Engine
class SoundEffects {
  private ctx: AudioContext | null = null;
  public isMuted = false;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  // Get current questions for each team
  const blueCurrentQuestion: TugOfWarQuestionItem | null = useMemo(() => {
    if (session.blue_current_idx >= session.question_count) return null;
    const poolIdx = session.blue_question_order[session.blue_current_idx];
    return session.questions_pool[poolIdx] || null;
  }, [session.blue_current_idx, session.question_count, session.blue_question_order, session.questions_pool]);

  const redCurrentQuestion: TugOfWarQuestionItem | null = useMemo(() => {
    if (session.red_current_idx >= session.question_count) return null;
    const poolIdx = session.red_question_order[session.red_current_idx];
    return session.questions_pool[poolIdx] || null;
  }, [session.red_current_idx, session.question_count, session.red_question_order, session.questions_pool]);

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
          } else {
            sounds.playWrong();
          }

          // Optimistically update local state for instantaneous tactile responsiveness
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

  // Keyboard shortcut listener:
  // Blue: Q (0), W (1), A (2), S (3)
  // Red:  O (0), P (1), K (2), L (3)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();
      // Blue Team Shortcuts
      if (key === 'q') void handleAnswer('BLUE', 0);
      else if (key === 'w') void handleAnswer('BLUE', 1);
      else if (key === 'a') void handleAnswer('BLUE', 2);
      else if (key === 's') void handleAnswer('BLUE', 3);
      // Red Team Shortcuts
      else if (key === 'o') void handleAnswer('RED', 0);
      else if (key === 'p') void handleAnswer('RED', 1);
      else if (key === 'k') void handleAnswer('RED', 2);
      else if (key === 'l') void handleAnswer('RED', 3);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleAnswer]);

  // Center Tug-of-war position calculation:
  // -100% to +100% based on (red_score - blue_score) / win_gap
  const ropeOffsetPercentage = useMemo(() => {
    const gap = session.win_gap > 0 ? session.win_gap : 5;
    const diff = session.red_score - session.blue_score;
    const ratio = diff / gap;
    return Math.max(-100, Math.min(100, ratio * 100));
  }, [session.blue_score, session.red_score, session.win_gap]);

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 select-none overflow-hidden relative font-sans">
      {/* 1. TOP HEADER BAR (#0f172a) */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-800 bg-[#0f172a] px-6 shadow-md z-20">
        {/* Left: Yellow Bold Exam Title */}
        <div className="flex items-center gap-3">
          <span className="text-xl">⚔️</span>
          <h1 className="text-base font-extrabold text-amber-400 sm:text-lg tracking-tight truncate max-w-xs md:max-w-md">
            {session.title}
          </h1>
        </div>

        {/* Center: Blue Pill vs Red Pill + Central Timer Box */}
        <div className="flex items-center gap-4">
          {/* Blue Pill */}
          <div className="flex items-center gap-2 rounded-full border border-blue-500/50 bg-blue-600/20 px-4 py-1.5 shadow-sm">
            <span className="text-xs font-bold uppercase text-blue-300">🔵 {session.blue_team_name}</span>
            <span className="font-mono text-xl font-black text-blue-400">{session.blue_score}</span>
          </div>

          {/* Central Timer Box */}
          <div className="flex items-center gap-2 rounded-2xl border-2 border-amber-500/50 bg-slate-900/90 px-5 py-1.5 shadow-lg shadow-amber-500/10">
            <Clock size={18} className="text-amber-400 animate-pulse" />
            <span className="font-mono text-2xl font-black tracking-wider text-amber-400">
              {timerDisplay}
            </span>
          </div>

          {/* Red Pill */}
          <div className="flex items-center gap-2 rounded-full border border-rose-500/50 bg-rose-600/20 px-4 py-1.5 shadow-sm">
            <span className="font-mono text-xl font-black text-rose-400">{session.red_score}</span>
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
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
          >
            {isMuted ? <VolumeX size={15} className="text-rose-400" /> : <Volume2 size={15} className="text-emerald-400" />}
            <span>{isMuted ? 'Bật âm' : 'Tắt âm'}</span>
          </button>

          <button
            type="button"
            onClick={handleToggleFullscreen}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>

          <button
            type="button"
            onClick={() => router.push('/classes')}
            className="flex items-center gap-1.5 rounded-xl border border-rose-800/60 bg-rose-950/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-900/60 transition"
          >
            <ArrowLeft size={15} />
            <span>Thoát</span>
          </button>
        </div>
      </header>

      {/* 2. THREE-COLUMN MAIN ARENA STAGE */}
      <main className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr_1.3fr_1fr] gap-4 p-4 overflow-hidden relative">
        {/* LEFT COLUMN: Blue Team Panel (#1e40af / #1d4ed8) */}
        <section className="flex flex-col rounded-3xl border-2 border-blue-500/50 bg-[#1e40af]/30 p-5 shadow-2xl relative overflow-hidden backdrop-blur">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-blue-400/30 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-sm font-black shadow">
                Q
              </span>
              <h2 className="text-base font-black uppercase text-blue-200">
                {session.blue_team_name}
              </h2>
            </div>
            <span className="rounded-full bg-blue-500/30 px-3 py-1 text-xs font-bold text-blue-300">
              Câu {Math.min(session.blue_current_idx + 1, session.question_count)} / {session.question_count}
            </span>
          </div>

          {/* Question Box */}
          <div className="flex-1 flex flex-col justify-between">
            {session.blue_current_idx >= session.question_count ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-blue-400/40 bg-blue-900/30 p-6 text-center">
                <Sparkles size={40} className="text-blue-300 mb-2 animate-bounce" />
                <h3 className="text-lg font-black text-white">ĐÃ HOÀN THÀNH TẤT CẢ CÂU HỎI!</h3>
                <p className="text-xs text-blue-200 mt-1">Đang chờ đối thủ hoặc kết thúc trận đấu...</p>
              </div>
            ) : blueCurrentQuestion ? (
              <>
                <div className="rounded-2xl border border-blue-400/40 bg-slate-900/90 p-4 shadow-inner mb-4 flex-1 flex items-center justify-center">
                  <p className="text-base font-bold text-white text-center leading-relaxed">
                    {blueCurrentQuestion.question_text}
                  </p>
                </div>

                {/* 2x2 Answer Grid */}
                <div className="grid grid-cols-2 gap-3">
                  {blueCurrentQuestion.options.slice(0, 4).map((opt, optIdx) => {
                    const keys = ['Q', 'W', 'A', 'S'];
                    const keyLabel = keys[optIdx];
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => void handleAnswer('BLUE', optIdx)}
                        disabled={blueFreezeRemaining > 0 || submittingTeam === 'BLUE'}
                        className="group relative flex items-center gap-3 rounded-2xl border-2 border-blue-500/50 bg-gradient-to-br from-blue-700 to-blue-900 p-4 text-left shadow-lg transition active:scale-95 hover:brightness-110 hover:border-blue-300 disabled:opacity-50 disabled:pointer-events-none"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-400 text-slate-950 font-black text-sm shadow">
                          {keyLabel}
                        </span>
                        <span className="text-xs font-semibold text-white leading-snug line-clamp-2">
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
              <span className="text-5xl mb-3 animate-spin">❄️</span>
              <h3 className="text-xl font-black uppercase text-cyan-200 tracking-wider">
                ĐÓNG BĂNG!
              </h3>
              <p className="text-xs text-cyan-300 mt-1 mb-3 font-medium">
                Trả lời sai! Chờ hết thời gian phạt để làm câu mới
              </p>
              <div className="rounded-2xl border border-cyan-400/50 bg-cyan-900/60 px-6 py-2">
                <span className="font-mono text-3xl font-black text-white">
                  {blueFreezeRemaining.toFixed(1)}s
                </span>
              </div>
            </div>
          )}
        </section>

        {/* CENTER COLUMN: Tug of War Canvas/SVG Stage (White/Clean Card) */}
        <section className="flex flex-col rounded-3xl border-2 border-slate-700/80 bg-white shadow-2xl p-6 relative overflow-hidden text-slate-900">
          {/* Top Indicator */}
          <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-2">
            <span className="text-xs font-black uppercase tracking-wider text-blue-700">
              ← ĐỘI XANH KÉO
            </span>
            <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
              <span>Cách biệt:</span>
              <span className="font-mono text-sm font-black text-indigo-700">
                {Math.abs(session.blue_score - session.red_score)} câu
              </span>
            </div>
            <span className="text-xs font-black uppercase tracking-wider text-rose-700">
              ĐỘI ĐỎ KÉO →
            </span>
          </div>

          {/* Animated SVG Tug Of War Arena */}
          <div className="flex-1 flex flex-col items-center justify-center relative w-full h-full min-h-[300px]">
            {/* Center Dashed Green Victory Line (#22c55e) */}
            <div className="absolute top-4 bottom-12 left-1/2 -translate-x-1/2 w-0 border-l-2 border-dashed border-[#22c55e] z-10">
              <div className="absolute top-0 -translate-x-1/2 rounded bg-[#22c55e] px-2 py-0.5 text-[10px] font-bold text-white shadow">
                VẠCH GIỮA
              </div>
            </div>

            {/* Dynamic Tug of War Group with Smooth Interpolation */}
            <div
              className="relative w-full flex items-center justify-center transition-transform duration-500 ease-out"
              style={{
                transform: `translateX(${ropeOffsetPercentage * 1.5}px)`,
              }}
            >
              {/* The Rope SVG */}
              <svg
                viewBox="0 0 800 240"
                className="w-full h-auto max-h-[320px] select-none pointer-events-none overflow-visible"
              >
                <defs>
                  {/* Rope texture pattern */}
                  <linearGradient id="ropeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#d97706" />
                    <stop offset="50%" stopColor="#b45309" />
                    <stop offset="100%" stopColor="#78350f" />
                  </linearGradient>

                  <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
                    <feDropShadow dx="0" dy="4" stdDeviation="4" floodOpacity="0.25" />
                  </filter>
                </defs>

                {/* Ground Line */}
                <line x1="20" y1="200" x2="780" y2="200" stroke="#cbd5e1" strokeWidth="4" strokeLinecap="round" />

                {/* 3 Blue Pullers (Left) */}
                <g className="blue-pullers" transform="translate(100, 40)">
                  {/* Puller 1 */}
                  <g transform="translate(0, 0)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="50" cy="50" r="16" fill="#3b82f6" />
                    <circle cx="48" cy="48" r="4" fill="#ffffff" />
                    <path d="M 50 66 L 40 120 L 25 155" stroke="#1d4ed8" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 40 100 L 70 120" stroke="#1d4ed8" strokeWidth="10" strokeLinecap="round" />
                    <path d="M 45 80 L 80 105" stroke="#1d4ed8" strokeWidth="8" strokeLinecap="round" />
                  </g>

                  {/* Puller 2 */}
                  <g transform="translate(70, 5)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="50" cy="50" r="16" fill="#2563eb" />
                    <circle cx="48" cy="48" r="4" fill="#ffffff" />
                    <path d="M 50 66 L 40 120 L 25 155" stroke="#1e40af" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 40 100 L 70 120" stroke="#1e40af" strokeWidth="10" strokeLinecap="round" />
                    <path d="M 45 80 L 80 105" stroke="#1e40af" strokeWidth="8" strokeLinecap="round" />
                  </g>

                  {/* Puller 3 (Anchor) */}
                  <g transform="translate(140, 10)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="50" cy="50" r="17" fill="#1d4ed8" />
                    <circle cx="48" cy="48" r="4" fill="#ffffff" />
                    <path d="M 50 66 L 40 120 L 20 155" stroke="#172554" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 40 100 L 70 120" stroke="#172554" strokeWidth="11" strokeLinecap="round" />
                    <path d="M 45 80 L 80 105" stroke="#172554" strokeWidth="9" strokeLinecap="round" />
                  </g>
                </g>

                {/* The ROPE */}
                <path
                  d="M 120 145 C 260 146, 540 146, 680 145"
                  stroke="url(#ropeGrad)"
                  strokeWidth="14"
                  strokeLinecap="round"
                  filter="url(#shadow)"
                />

                {/* Central Red Ribbon Knot */}
                <g transform="translate(400, 145)">
                  {/* Center knot ribbon */}
                  <circle cx="0" cy="0" r="12" fill="#ef4444" stroke="#991b1b" strokeWidth="2" filter="url(#shadow)" />
                  <path d="M 0 0 L -8 30 L 0 25 L 8 30 Z" fill="#dc2626" />
                  <path d="M 0 0 L -12 28 L 0 23 L 6 32 Z" fill="#ef4444" />
                </g>

                {/* 3 Red Pullers (Right) */}
                <g className="red-pullers" transform="translate(480, 40)">
                  {/* Puller 1 */}
                  <g transform="translate(0, 10)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="70" cy="50" r="16" fill="#dc2626" />
                    <circle cx="72" cy="48" r="4" fill="#ffffff" />
                    <path d="M 70 66 L 80 120 L 95 155" stroke="#b91c1c" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 80 100 L 50 120" stroke="#b91c1c" strokeWidth="10" strokeLinecap="round" />
                    <path d="M 75 80 L 40 105" stroke="#b91c1c" strokeWidth="8" strokeLinecap="round" />
                  </g>

                  {/* Puller 2 */}
                  <g transform="translate(70, 5)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="70" cy="50" r="16" fill="#ef4444" />
                    <circle cx="72" cy="48" r="4" fill="#ffffff" />
                    <path d="M 70 66 L 80 120 L 95 155" stroke="#dc2626" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 80 100 L 50 120" stroke="#dc2626" strokeWidth="10" strokeLinecap="round" />
                    <path d="M 75 80 L 40 105" stroke="#dc2626" strokeWidth="8" strokeLinecap="round" />
                  </g>

                  {/* Puller 3 (Anchor) */}
                  <g transform="translate(140, 0)">
                    <ellipse cx="60" cy="155" rx="20" ry="6" fill="#94a3b8" opacity="0.4" />
                    <circle cx="70" cy="50" r="17" fill="#b91c1c" />
                    <circle cx="72" cy="48" r="4" fill="#ffffff" />
                    <path d="M 70 66 L 80 120 L 100 155" stroke="#7f1d1d" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M 80 100 L 50 120" stroke="#7f1d1d" strokeWidth="11" strokeLinecap="round" />
                    <path d="M 75 80 L 40 105" stroke="#7f1d1d" strokeWidth="9" strokeLinecap="round" />
                  </g>
                </g>
              </svg>
            </div>

            {/* Tension gauge bar */}
            <div className="w-full mt-4 max-w-md">
              <div className="h-3 w-full rounded-full bg-slate-200 overflow-hidden relative shadow-inner">
                <div
                  className="absolute top-0 bottom-0 transition-all duration-300"
                  style={{
                    left: ropeOffsetPercentage < 0 ? `${50 + ropeOffsetPercentage / 2}%` : '50%',
                    right: ropeOffsetPercentage > 0 ? `${50 - ropeOffsetPercentage / 2}%` : '50%',
                    backgroundColor: ropeOffsetPercentage < 0 ? '#3b82f6' : '#ef4444',
                  }}
                />
                <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-slate-400 -translate-x-1/2" />
              </div>
              <div className="flex justify-between text-[10px] font-bold text-slate-500 mt-1">
                <span>Vùng Thắng Xanh</span>
                <span>Thăng Bằng</span>
                <span>Vùng Thắng Đỏ</span>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Red Team Panel (#b91c1c / #dc2626) */}
        <section className="flex flex-col rounded-3xl border-2 border-rose-500/50 bg-[#b91c1c]/30 p-5 shadow-2xl relative overflow-hidden backdrop-blur">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-rose-400/30 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-600 text-sm font-black shadow">
                O
              </span>
              <h2 className="text-base font-black uppercase text-rose-200">
                {session.red_team_name}
              </h2>
            </div>
            <span className="rounded-full bg-rose-500/30 px-3 py-1 text-xs font-bold text-rose-300">
              Câu {Math.min(session.red_current_idx + 1, session.question_count)} / {session.question_count}
            </span>
          </div>

          {/* Question Box */}
          <div className="flex-1 flex flex-col justify-between">
            {session.red_current_idx >= session.question_count ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-900/30 p-6 text-center">
                <Sparkles size={40} className="text-rose-300 mb-2 animate-bounce" />
                <h3 className="text-lg font-black text-white">ĐÃ HOÀN THÀNH TẤT CẢ CÂU HỎI!</h3>
                <p className="text-xs text-rose-200 mt-1">Đang chờ đối thủ hoặc kết thúc trận đấu...</p>
              </div>
            ) : redCurrentQuestion ? (
              <>
                <div className="rounded-2xl border border-rose-400/40 bg-slate-900/90 p-4 shadow-inner mb-4 flex-1 flex items-center justify-center">
                  <p className="text-base font-bold text-white text-center leading-relaxed">
                    {redCurrentQuestion.question_text}
                  </p>
                </div>

                {/* 2x2 Answer Grid */}
                <div className="grid grid-cols-2 gap-3">
                  {redCurrentQuestion.options.slice(0, 4).map((opt, optIdx) => {
                    const keys = ['O', 'P', 'K', 'L'];
                    const keyLabel = keys[optIdx];
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => void handleAnswer('RED', optIdx)}
                        disabled={redFreezeRemaining > 0 || submittingTeam === 'RED'}
                        className="group relative flex items-center gap-3 rounded-2xl border-2 border-rose-500/50 bg-gradient-to-br from-rose-700 to-rose-900 p-4 text-left shadow-lg transition active:scale-95 hover:brightness-110 hover:border-rose-300 disabled:opacity-50 disabled:pointer-events-none"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-rose-400 text-slate-950 font-black text-sm shadow">
                          {keyLabel}
                        </span>
                        <span className="text-xs font-semibold text-white leading-snug line-clamp-2">
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
              <span className="text-5xl mb-3 animate-spin">❄️</span>
              <h3 className="text-xl font-black uppercase text-cyan-200 tracking-wider">
                ĐÓNG BĂNG!
              </h3>
              <p className="text-xs text-cyan-300 mt-1 mb-3 font-medium">
                Trả lời sai! Chờ hết thời gian phạt để làm câu mới
              </p>
              <div className="rounded-2xl border border-cyan-400/50 bg-cyan-900/60 px-6 py-2">
                <span className="font-mono text-3xl font-black text-white">
                  {redFreezeRemaining.toFixed(1)}s
                </span>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* 3. VICTORY / END-OF-GAME MODAL */}
      {(session.status === 'FINISHED' || remainingSeconds <= 0) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-lg rounded-3xl border-2 border-amber-500/50 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-8 text-center shadow-2xl overflow-hidden">
            <div className="absolute -top-32 -left-32 h-64 w-64 rounded-full bg-amber-500/20 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-32 -right-32 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl pointer-events-none" />

            <div className="relative z-10 space-y-4">
              <span className="inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-amber-500/20 text-5xl shadow-xl shadow-amber-500/20 border border-amber-500/30">
                🏆
              </span>

              {/* Winner Announcement */}
              {session.winner === 'BLUE' ? (
                <div>
                  <h2 className="text-3xl font-black uppercase text-blue-400 tracking-wide drop-shadow">
                    🔵 ĐỘI XANH CHIẾN THẮNG!
                  </h2>
                  <p className="text-sm text-slate-300 mt-2">
                    {session.blue_team_name} đã xuất sắc chiến thắng đối thủ!
                  </p>
                </div>
              ) : session.winner === 'RED' ? (
                <div>
                  <h2 className="text-3xl font-black uppercase text-rose-400 tracking-wide drop-shadow">
                    🔴 ĐỘI ĐỎ CHIẾN THẮNG!
                  </h2>
                  <p className="text-sm text-slate-300 mt-2">
                    {session.red_team_name} đã xuất sắc chiến thắng đối thủ!
                  </p>
                </div>
              ) : (
                <div>
                  <h2 className="text-3xl font-black uppercase text-amber-300 tracking-wide drop-shadow">
                    🤝 HÒA NHAU!
                  </h2>
                  <p className="text-sm text-slate-300 mt-2">
                    Cả hai đội đã thi đấu vô cùng nỗ lực và cân tài cân sức!
                  </p>
                </div>
              )}

              {/* Score Recap Card */}
              <div className="flex items-center justify-center gap-6 rounded-2xl border border-slate-800 bg-slate-800/50 p-4 my-4">
                <div className="text-center">
                  <span className="text-xs text-blue-300 font-bold block">{session.blue_team_name}</span>
                  <span className="font-mono text-3xl font-black text-blue-400">{session.blue_score}</span>
                </div>
                <span className="text-xl font-bold text-slate-500">—</span>
                <div className="text-center">
                  <span className="text-xs text-rose-300 font-bold block">{session.red_team_name}</span>
                  <span className="font-mono text-3xl font-black text-rose-400">{session.red_score}</span>
                </div>
              </div>

              {/* Victory Reason */}
              <p className="text-xs text-slate-400 italic">
                {session.win_gap > 0 && Math.abs(session.blue_score - session.red_score) >= session.win_gap
                  ? `Thắng lập tức do vượt cách biệt ${session.win_gap} câu!`
                  : remainingSeconds <= 0
                  ? 'Kết thúc do hết thời gian thi đấu!'
                  : 'Hoàn thành toàn bộ số câu hỏi trong trận đấu!'}
              </p>

              {/* Action Buttons */}
              <div className="flex items-center justify-center gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => router.push('/classes')}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700 transition"
                >
                  Về Lớp Học
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/classes')}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-rose-600 px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 hover:brightness-110 transition"
                >
                  <RefreshCw size={14} />
                  Chơi Lại Trận Mới
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
