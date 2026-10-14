'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Medal,
  Radio,
  Sparkles,
  StopCircle,
  Trophy,
  Users,
} from 'lucide-react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { resolveStudentAppBaseUrl } from '@/lib/env';
import { PersistenceError } from '@/lib/exams';
import {
  clampTeamNumber,
  computeTeamProgress,
  countActiveMembersPerTeam,
  endTreeSession,
  getTeamSeed,
  startTreeSession,
} from '@/lib/tree';
import { computeTreeState, type LayoutFruitAnchor, type TreeState } from '@/lib/tree-engine';
import {
  isAudioMuted,
  playBloomFanfare,
  playDewdropSound,
  resumeAudioContext,
  toggleAudioMute,
} from '@/lib/tree-audio';
import type { TeamNumber, TreeSessionDetail, TreeSubmissionRow } from '@/lib/types';
import { TreeCanvas, type TreeCanvasHandle } from './TreeCanvas';
import { TreeLobby } from './TreeLobby';
import { TreeQrCode } from './TreeQrCode';
import { aggregateBrainstormContributions } from '@/lib/treeBrainstormSummary';
import { TreeBrainstormSummaryModal } from './TreeBrainstormSummaryModal';

interface TreeProjectorProps {
  session: TreeSessionDetail;
  /** Submissions at first paint; Realtime deltas are layered on top. */
  initialSubmissions: TreeSubmissionRow[];
}

/** Podium rank: 1 = Quán quân (Gold), 2 = Á quân (Silver), 3 = Hạng ba (Bronze). */
type PodiumRank = 1 | 2 | 3 | null;

/** The four teams, in display order. */
const TEAMS: TeamNumber[] = [1, 2, 3, 4];

/** Duration (ms) for the floating finish announcement banner before auto-hiding. */
const FINISH_BANNER_DURATION_MS = 3000;

/**
 * Builds the URL a student scans to join.
 */
function buildJoinUrl(session: TreeSessionDetail): string {
  const base = resolveStudentAppBaseUrl();
  const code = session.session_code || session.id;
  return base ? `${base}/?tree=${code}` : `/?tree=${code}`;
}

/** Strips characters that are illegal in a filename on Windows/macOS. */
function toSafeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned || 'Phien';
}

/** `mm:ss` remaining, floored at 0. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Computes the timestamp (ms) when a finished team crossed its completion threshold,
 * so a page refresh still reconstructs the exact 1st / 2nd / 3rd finish order.
 */
function getTeamFinishTimestampMs(
  teamSubmissions: TreeSubmissionRow[],
  targetCount: number,
): number {
  if (teamSubmissions.length === 0) return Number.MAX_SAFE_INTEGER;
  const sorted = [...teamSubmissions].sort((a, b) => {
    const ta = Date.parse(String(a.submitted_at ?? '')) || 0;
    const tb = Date.parse(String(b.submitted_at ?? '')) || 0;
    return ta - tb;
  });
  const idx = Math.min(Math.max(1, targetCount) - 1, sorted.length - 1);
  return Date.parse(String(sorted[idx]?.submitted_at ?? '')) || Number.MAX_SAFE_INTEGER;
}

/**
 * TreeProjector — the classroom projector view for one tree session.
 */
export function TreeProjector({ session, initialSubmissions }: TreeProjectorProps) {
  const [submissions, setSubmissions] = useState<TreeSubmissionRow[]>(initialSubmissions);
  const [isActive, setIsActive] = useState(session.is_active);
  const [status, setStatus] = useState(session.status);
  const [startedAt, setStartedAt] = useState<string | null>(session.started_at);
  const [endsAt, setEndsAt] = useState<string | null>(session.ends_at);
  const [isStarting, setIsStarting] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [hovered, setHovered] = useState<{ team: TeamNumber; anchor: LayoutFruitAnchor } | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEnding, setIsEnding] = useState(false);
  const [muted, setMuted] = useState(false);
  // Ordered list of teams that have reached 100% (index 0 -> 1st, index 1 -> 2nd, index 2 -> 3rd).
  const [finishOrder, setFinishOrder] = useState<TeamNumber[]>([]);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  useEffect(() => {
    setMuted(isAudioMuted());
  }, []);

  useEffect(() => {
    const unlock = () => {
      void resumeAudioContext();
      window.removeEventListener('pointerdown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    return () => window.removeEventListener('pointerdown', unlock, true);
  }, []);

  const joinUrl = useMemo(() => buildJoinUrl(session), [session]);

  const brainstormSummaries = useMemo(() => {
    if (session.game_mode !== 'BRAINSTORM') return [];
    return aggregateBrainstormContributions(submissions);
  }, [session.game_mode, submissions]);

  // --- countdown -----------------------------------------------------------
  const deadline = useMemo(() => {
    if (endsAt) return new Date(endsAt).getTime();
    const anchor = startedAt ?? session.created_at;
    return new Date(anchor).getTime() + session.time_limit_minutes * 60_000;
  }, [endsAt, session.created_at, session.time_limit_minutes, startedAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  const remainingMs = deadline - now;
  const isExpired = remainingMs <= 0;
  const isOpen = isActive && !isExpired;

  // --- realtime ------------------------------------------------------------
  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel;

    const applyChange = (payload: RealtimePostgresChangesPayload<TreeSubmissionRow>) => {
      if (payload.eventType === 'DELETE') {
        const removedId = (payload.old as Partial<TreeSubmissionRow>)?.id;
        if (!removedId) return;
        setSubmissions((previous) => previous.filter((row) => row.id !== removedId));
        return;
      }

      const row = payload.new as TreeSubmissionRow;
      if (!row?.id) return;
      if (row.session_id !== session.id) return;

      setSubmissions((previous) => {
        const index = previous.findIndex((existing) => existing.id === row.id);
        if (index === -1) return [...previous, row];
        const next = previous.slice();
        next[index] = row;
        return next;
      });
    };

    channel = supabase
      .channel(`tree-session-${session.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tree_submissions',
          filter: `session_id=eq.${session.id}`,
        },
        applyChange,
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setConnection('live');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('error');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session.id]);

  // --- per-team projections -----------------------------------------------
  const activeMembersPerTeam = useMemo(
    () => countActiveMembersPerTeam(session.roster, session.participant_config),
    [session.roster, session.participant_config],
  );

  const teamStats = useMemo(() => {
    return TEAMS.map((team) => {
      const teamSubmissions = submissions.filter(
        (row) => clampTeamNumber(row.team_number) === team,
      );
      const done = teamSubmissions.length;
      const { denominator, progress, isFinished } = computeTeamProgress({
        gameMode: session.game_mode,
        acceptedCount: done,
        activeMembersCount: activeMembersPerTeam[team] ?? 0,
        targetScore: session.target_score,
      });
      const treeState: TreeState = computeTreeState({
        totalStudents: denominator,
        submissions: teamSubmissions,
        timeLimitMinutes: session.time_limit_minutes,
        createdAt: session.started_at ?? session.created_at,
        seed: getTeamSeed(session.tree_seed, team),
      });
      return {
        team,
        rawTotal: denominator,
        done,
        percent: Math.round(progress * 100),
        treeState,
        isFinished,
        teamSubmissions,
        finishTimestampMs: isFinished
          ? getTeamFinishTimestampMs(teamSubmissions, denominator)
          : Number.MAX_SAFE_INTEGER,
      };
    });
  }, [
    submissions,
    activeMembersPerTeam,
    session.game_mode,
    session.target_score,
    session.time_limit_minutes,
    session.started_at,
    session.created_at,
    session.tree_seed,
  ]);

  const k = submissions.length;
  const totalStudents = Math.max(session.total_students, 1);
  const percent = Math.min(100, Math.round((k / totalStudents) * 100));

  const vitality = useMemo(
    () =>
      computeTreeState({
        totalStudents,
        submissions,
        timeLimitMinutes: session.time_limit_minutes,
        createdAt: session.created_at,
        seed: session.tree_seed,
      }).vitality,
    [totalStudents, submissions, session.time_limit_minutes, session.created_at, session.tree_seed],
  );

  // --- Podium latch: 1st (Gold), 2nd (Silver), 3rd (Bronze) ----------------
  const previousCountRef = useRef(submissions.length);
  const vitalityRef = useRef(vitality);
  vitalityRef.current = vitality;
  const finishedSetRef = useRef<Set<TeamNumber>>(new Set());

  useEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = k;

    if (k > previousCount) {
      const newRows = k - previousCount;
      for (let i = 0; i < newRows; i += 1) {
        playDewdropSound(vitalityRef.current);
      }
    }
  }, [k]);

  useEffect(() => {
    // Find any team that has finished but is not yet latched in `finishedSetRef`.
    const newlyFinished = teamStats
      .filter((stat) => stat.isFinished && !finishedSetRef.current.has(stat.team))
      .sort((a, b) => a.finishTimestampMs - b.finishTimestampMs || a.team - b.team);

    if (newlyFinished.length === 0) return;

    const wasEmpty = finishedSetRef.current.size === 0;
    newlyFinished.forEach((stat) => finishedSetRef.current.add(stat.team));

    setFinishOrder((prev) => {
      const next = [...prev];
      for (const item of newlyFinished) {
        if (!next.includes(item.team)) next.push(item.team);
      }
      return next;
    });

    // Play fanfare when a podium spot (1st, 2nd, or 3rd) is claimed live
    if (wasEmpty || finishedSetRef.current.size <= 3) {
      playBloomFanfare();
    }
  }, [teamStats]);

  /** Maps each team (1..4) to its podium rank (1, 2, 3, or null). */
  const podiumRanks = useMemo<Record<TeamNumber, PodiumRank>>(() => {
    const map: Record<TeamNumber, PodiumRank> = { 1: null, 2: null, 3: null, 4: null };
    finishOrder.forEach((teamNum, idx) => {
      if (idx === 0) map[teamNum] = 1;
      else if (idx === 1) map[teamNum] = 2;
      else if (idx === 2) map[teamNum] = 3;
    });
    return map;
  }, [finishOrder]);

  const handleToggleMute = useCallback(() => {
    void resumeAudioContext();
    setMuted(toggleAudioMute());
  }, []);

  const activeFruit = useMemo(() => {
    if (pinnedId) return submissions.find((row) => row.id === pinnedId) ?? null;
    if (!hovered) return null;
    return submissions.find((row) => row.id === hovered.anchor.id) ?? null;
  }, [pinnedId, hovered, submissions]);

  const tooltipTeam = useMemo<{ team: TeamNumber; anchor: LayoutFruitAnchor | null } | null>(() => {
    if (pinnedId && activeFruit) {
      return { team: clampTeamNumber(activeFruit.team_number), anchor: null };
    }
    if (hovered) return { team: hovered.team, anchor: hovered.anchor };
    return null;
  }, [pinnedId, activeFruit, hovered]);

  useEffect(() => {
    setShowAnswer(false);
  }, [activeFruit?.id]);

  const handleEndSession = async () => {
    if (!window.confirm('Kết thúc hoạt động? Học sinh sẽ không thể nộp thêm câu trả lời.')) return;
    setIsEnding(true);
    setError(null);
    try {
      await endTreeSession(createClient(), session.id);
      setIsActive(false);
      setStatus('FINISHED');
      if (session.game_mode === 'BRAINSTORM') {
        setIsSummaryOpen(true);
      }
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không kết thúc được hoạt động.');
    } finally {
      setIsEnding(false);
    }
  };

  const handleStartSession = async () => {
    setIsStarting(true);
    setError(null);
    try {
      const { startedAt: started, endsAt: serverEndsAt } = await startTreeSession(createClient(), session.id);
      setStartedAt(started || new Date().toISOString());
      if (serverEndsAt) setEndsAt(serverEndsAt);
      setStatus('ACTIVE');
      setIsActive(true);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không bắt đầu được trận đấu.');
    } finally {
      setIsStarting(false);
    }
  };

  const handleSaveImage = () => {
    const targetTeam = finishOrder[0] ?? 1;
    const dataUrl = canvasRefs.current[targetTeam]?.current?.exportImage();
    if (!dataUrl) {
      setError('Không tạo được ảnh. Vui lòng thử lại.');
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `Cay_Tri_Thuc_${toSafeFilename(session.title)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const canvasRefs = useRef<Record<TeamNumber, { current: TreeCanvasHandle | null }>>({
    1: { current: null },
    2: { current: null },
    3: { current: null },
    4: { current: null },
  });

  const champion = finishOrder[0] ?? null;
  const secondPlace = finishOrder[1] ?? null;
  const thirdPlace = finishOrder[2] ?? null;

  if (status === 'LOBBY') {
    return (
      <>
        <TreeLobby
          session={session}
          joinUrl={joinUrl}
          isStarting={isStarting}
          onStart={() => void handleStartSession()}
        />
        {error && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-rose-800 bg-rose-950/95 px-4 py-2 text-sm text-rose-100 shadow-lg">
            {error}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 lg:h-screen lg:flex-row">
      {/* ---------------- Sidebar ---------------- */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-slate-800 p-5 lg:w-[24rem] lg:border-r">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Đấu trường Cây Tri Thức
          </p>
          <h1 className="mt-1 text-2xl font-bold leading-tight">{session.title}</h1>
          <p className="mt-1 text-xs text-slate-400">Lớp {session.class_name} · 4 Tổ thi đua</p>
        </div>

        <div className="rounded-xl bg-slate-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Câu hỏi</p>
          <p className="mt-2 whitespace-pre-wrap text-base font-semibold leading-snug text-slate-50">
            {session.question_text}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full bg-slate-800 px-3 py-1 text-slate-200">
            Tối thiểu: {session.min_words} từ
          </span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-slate-200">
            Trùng lặp tối đa: {Math.round(session.max_similarity * 100)}%
          </span>
        </div>

        {/* Timer + progress + podium leaderboard */}
        <div className="space-y-3 rounded-xl bg-slate-900 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-300">
              <Clock size={15} />
              Thời gian còn lại
            </span>
            <span
              className={
                isExpired
                  ? 'font-mono text-2xl font-bold text-rose-400'
                  : remainingMs < 5 * 60_000
                    ? 'font-mono text-2xl font-bold text-amber-300'
                    : 'font-mono text-2xl font-bold text-emerald-300'
              }
            >
              {isExpired ? '00:00' : formatRemaining(remainingMs)}
            </span>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
              <span className="flex items-center gap-1.5">
                <Users size={13} />
                {k}/{totalStudents} bạn đã góp dưỡng chất ({percent}%)
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {champion ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 rounded-lg border border-amber-400/60 bg-amber-500/15 px-3 py-2">
                <Trophy size={16} className="shrink-0 text-amber-300" />
                <p className="text-xs font-bold text-amber-100">
                  QUÁN QUÂN: TỔ {champion} về đích đầu tiên!
                </p>
              </div>
              {(secondPlace || thirdPlace) && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {secondPlace && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-slate-300/40 bg-slate-300/10 px-2.5 py-1 text-[11px] font-bold text-slate-200">
                      🥈 Á quân: Tổ {secondPlace}
                    </span>
                  )}
                  {thirdPlace && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-600/40 bg-amber-700/15 px-2.5 py-1 text-[11px] font-bold text-amber-400">
                      🥉 Hạng ba: Tổ {thirdPlace}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs font-semibold text-slate-400">
              Chưa có Tổ nào cán đích. Cùng chung sức nhé!
            </p>
          )}

          <ConnectionBadge state={connection} />
        </div>

        {/* QR */}
        <div className="flex flex-col items-center gap-2 rounded-xl bg-slate-900 p-4">
          <p className="text-sm font-semibold text-slate-200">Quét mã để tham gia</p>
          <TreeQrCode value={joinUrl} size={160} />
          <p className="break-all text-center text-[11px] leading-tight text-slate-400">{joinUrl}</p>
        </div>

        {/* Actions */}
        <div className="mt-auto space-y-2">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-800 bg-rose-950/60 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-400" />
              <p className="text-xs text-rose-200">{error}</p>
            </div>
          )}

          {!isOpen && (
            <p className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300">
              <CheckCircle2 size={14} />
              {isExpired && isActive ? 'Đã hết thời gian làm bài.' : 'Hoạt động đã kết thúc.'}
            </p>
          )}

          <button
            type="button"
            onClick={handleToggleMute}
            title={muted ? 'Bật âm thanh' : 'Tắt âm thanh'}
            aria-pressed={!muted}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
          >
            {muted ? '🔇 Đã tắt âm' : '🔊 Âm thanh'}
          </button>

          <button
            type="button"
            onClick={handleSaveImage}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
          >
            <Sparkles size={16} />
            📸 Lưu ảnh kỷ niệm
          </button>

          {session.game_mode === 'BRAINSTORM' && (
            <button
              type="button"
              onClick={() => setIsSummaryOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
            >
              💡 Xem tổng kết ý tưởng
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleEndSession()}
            disabled={isEnding || !isActive}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isEnding ? <Loader2 size={16} className="animate-spin" /> : <StopCircle size={16} />}
            {isEnding ? 'Đang kết thúc…' : 'Kết thúc hoạt động'}
          </button>
        </div>
      </aside>

      {/* ---------------- Arena stage (2x2) ---------------- */}
      <main className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 sm:grid-cols-2 lg:min-h-0">
        {teamStats.map((stat) => (
          <TeamCard
            key={stat.team}
            session={session}
            stat={stat}
            rank={podiumRanks[stat.team]}
            canvasRef={canvasRefs.current[stat.team]}
            onFruitHover={(anchor) =>
              setHovered(anchor ? { team: stat.team, anchor } : null)
            }
            onFruitClick={(anchor) =>
              setPinnedId((current) => (anchor && anchor.id !== current ? anchor.id : null))
            }
            tooltip={
              tooltipTeam?.team === stat.team && activeFruit ? (
                <FruitTooltip
                  anchor={tooltipTeam.anchor}
                  fruit={activeFruit}
                  showAnswer={showAnswer}
                  onToggleAnswer={() => setShowAnswer((value) => !value)}
                  onClose={() => {
                    setPinnedId(null);
                    setHovered(null);
                  }}
                />
              ) : null
            }
          />
        ))}
      </main>

      {session.game_mode === 'BRAINSTORM' && (
        <TreeBrainstormSummaryModal
          isOpen={isSummaryOpen}
          onClose={() => setIsSummaryOpen(false)}
          teams={brainstormSummaries}
          topicTitle={session.title}
        />
      )}
    </div>
  );
}

/** One team's card: header, podium border (Gold/Silver/Bronze), 3s finish banner, and tree canvas. */
function TeamCard({
  session,
  stat,
  rank,
  canvasRef,
  onFruitHover,
  onFruitClick,
  tooltip,
}: {
  session: TreeSessionDetail;
  stat: {
    team: TeamNumber;
    rawTotal: number;
    done: number;
    percent: number;
    treeState: TreeState;
    isFinished: boolean;
    teamSubmissions: TreeSubmissionRow[];
  };
  rank: PodiumRank;
  canvasRef: { current: TreeCanvasHandle | null };
  onFruitHover: (anchor: LayoutFruitAnchor | null) => void;
  onFruitClick: (anchor: LayoutFruitAnchor | null) => void;
  tooltip: React.ReactNode;
}) {
  const { team, treeState, done, rawTotal, percent, teamSubmissions } = stat;
  const vitalityPercent = Math.round(treeState.vitality * 100);
  const isBrainstorm = session.game_mode === 'BRAINSTORM';
  const progressLabel = isBrainstorm
    ? `${done}/${rawTotal} đã nộp`
    : `${done}/${rawTotal} điểm`;

  // --- Auto-dismissing 3-second finish banner state ------------------------
  const [showFinishToast, setShowFinishToast] = useState(false);
  const announcedRankRef = useRef<PodiumRank>(null);

  useEffect(() => {
    if (rank !== null && announcedRankRef.current !== rank) {
      announcedRankRef.current = rank;
      setShowFinishToast(true);
      const timer = setTimeout(() => {
        setShowFinishToast(false);
      }, FINISH_BANNER_DURATION_MS);
      return () => clearTimeout(timer);
    }
    if (rank === null) {
      announcedRankRef.current = null;
      setShowFinishToast(false);
    }
  }, [rank]);

  // --- Podium visual hierarchy: Gold (1st) > Silver (2nd) > Bronze (3rd) ---
  const cardBorderClasses =
    rank === 1
      ? 'border-amber-400 ring-2 ring-amber-400/80 shadow-[0_0_32px_rgba(251,191,36,0.28)]'
      : rank === 2
        ? 'border-slate-300/80 ring-1 ring-slate-300/40 shadow-[0_0_18px_rgba(203,213,225,0.16)]'
        : rank === 3
          ? 'border-amber-700/85 ring-1 ring-amber-600/35 shadow-[0_0_14px_rgba(217,119,6,0.14)]'
          : 'border-slate-800';

  const teamBadgeClasses =
    rank === 1
      ? 'bg-amber-400 text-amber-950 shadow-sm shadow-amber-400/30'
      : rank === 2
        ? 'bg-slate-200 text-slate-900'
        : rank === 3
          ? 'bg-amber-700 text-amber-50'
          : 'bg-emerald-600 text-white';

  const toastBannerConfig =
    rank === 1
      ? {
          text: `🏆 QUÁN QUÂN: TỔ ${team} VỀ ĐÍCH ĐẦU TIÊN! 🌸`,
          cls: 'border-amber-300 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400 text-amber-950 shadow-[0_10px_30px_rgba(251,191,36,0.5)] scale-105',
        }
      : rank === 2
        ? {
            text: `🥈 Á QUÂN: TỔ ${team} VỀ ĐÍCH THỨ HAI! ✨`,
            cls: 'border-slate-200 bg-gradient-to-r from-slate-200 via-white to-slate-300 text-slate-900 shadow-[0_8px_22px_rgba(203,213,225,0.35)]',
          }
        : rank === 3
          ? {
              text: `🥉 HẠNG BA: TỔ ${team} HOÀN THÀNH XUẤT SẮC! 🌱`,
              cls: 'border-amber-500/60 bg-gradient-to-r from-amber-700 via-amber-600 to-amber-700 text-amber-50 shadow-[0_8px_20px_rgba(180,83,9,0.35)]',
            }
          : null;

  return (
    <section
      className={`relative flex min-h-[42vh] flex-col overflow-hidden rounded-2xl border bg-[#090d16] transition-all duration-300 lg:min-h-0 ${cardBorderClasses}`}
    >
      <header className="relative z-10 flex items-center justify-between gap-2 border-b border-slate-800/80 bg-slate-950/75 px-3 py-2 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className={`rounded-lg px-2.5 py-1 text-sm font-extrabold transition-colors ${teamBadgeClasses}`}>
            Tổ {team}
          </span>

          {rank === 1 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/50 bg-amber-400/15 px-2.5 py-0.5 text-xs font-extrabold text-amber-300">
              <Trophy size={13} />
              Quán quân
            </span>
          )}

          {rank === 2 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-300/40 bg-slate-300/15 px-2.5 py-0.5 text-xs font-bold text-slate-200">
              <Medal size={13} />
              Á quân
            </span>
          )}

          {rank === 3 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-600/45 bg-amber-700/20 px-2.5 py-0.5 text-xs font-bold text-amber-400">
              <Award size={13} />
              Hạng ba
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] font-semibold">
          <span className="rounded-full bg-slate-800/90 px-2.5 py-0.5 text-slate-200">
            {progressLabel} ({percent}%)
          </span>
          <span className="rounded-full border border-teal-500/25 bg-teal-500/10 px-2.5 py-0.5 text-teal-300">
            Sức sống {vitalityPercent}%
          </span>
        </div>
      </header>

      <div className="relative flex-1">
        <TreeCanvas
          ref={canvasRef}
          session={session}
          totalStudents={Math.max(rawTotal, 1)}
          submissions={teamSubmissions}
          seed={getTeamSeed(session.tree_seed, team)}
          onFruitClick={onFruitClick}
          onFruitHover={onFruitHover}
        />

        {/* Floating finish banner: pops in prominently for 3 seconds then auto-hides */}
        {showFinishToast && toastBannerConfig && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
            <div
              className={`animate-bounce rounded-full border px-4 py-1.5 text-center text-xs font-extrabold tracking-wide transition-all duration-300 ${toastBannerConfig.cls}`}
            >
              {toastBannerConfig.text}
            </div>
          </div>
        )}

        {done === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center">
            <p className="inline-block rounded-full bg-slate-950/70 px-3 py-1.5 text-[11px] font-semibold text-slate-400">
              Tổ {team} chưa có câu trả lời nào…
            </p>
          </div>
        )}

        {tooltip}
      </div>
    </section>
  );
}

/** Realtime connection indicator. */
function ConnectionBadge({ state }: { state: 'connecting' | 'live' | 'error' }) {
  if (state === 'connecting') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
        <Radio size={13} className="animate-pulse" />
        Đang kết nối…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-400">
        <AlertTriangle size={13} />
        Mất kết nối thời gian thực — cây có thể không tự cập nhật.
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      Đang trực tiếp
    </span>
  );
}

interface FruitTooltipProps {
  anchor: LayoutFruitAnchor | null;
  fruit: TreeSubmissionRow;
  showAnswer: boolean;
  onToggleAnswer: () => void;
  onClose: () => void;
}

/**
 * Floating fruit detail card, hosted inside the owning team's card.
 */
function FruitTooltip({ anchor, fruit, showAnswer, onToggleAnswer, onClose }: FruitTooltipProps) {
  return (
    <div
      className="absolute z-20 w-72 max-w-[85%] rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur"
      style={
        anchor
          ? { left: `min(max(${anchor.x + 12}px, 8px), calc(100% - 18rem - 8px))`, top: `${anchor.y + 12}px` }
          : { right: '0.75rem', bottom: '0.75rem' }
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
            Giọt sương tri thức
          </p>
          <p className="text-sm font-bold text-white">{fruit.student_name}</p>
          <p className="font-mono text-[11px] text-slate-400">{fruit.student_code}</p>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-600/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
          Tổ {clampTeamNumber(fruit.team_number)} · #{fruit.fruit_index}
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-300">
        {fruit.word_count} từ · {new Date(fruit.submitted_at).toLocaleTimeString('vi-VN')}
      </p>

      {showAnswer ? (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 text-xs leading-relaxed text-slate-200">
          {fruit.answer_text}
        </p>
      ) : (
        <p className="mt-2 select-none rounded-lg bg-slate-950 p-2 text-xs italic text-slate-500">
          Nội dung đang được ẩn.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleAnswer}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-slate-700"
        >
          {showAnswer ? <EyeOff size={13} /> : <Eye size={13} />}
          {showAnswer ? 'Ẩn nội dung' : '👁️ Xem nội dung'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
        >
          Đóng
        </button>
      </div>
    </div>
  );
}