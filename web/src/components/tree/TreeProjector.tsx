'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
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
import { clampTeamNumber, endTreeSession, getTeamSeed } from '@/lib/tree';
import { computeTreeState, type LayoutFruitAnchor, type TreeState } from '@/lib/tree-engine';
import {
  isAudioMuted,
  playBloomFanfare,
  playDewdropSound,
  resumeAudioContext,
  toggleAudioMute,
} from '@/lib/tree-audio';
import type { TeamCounts, TeamNumber, TreeSessionDetail, TreeSubmissionRow } from '@/lib/types';
import { TreeCanvas, type TreeCanvasHandle } from './TreeCanvas';
import { TreeQrCode } from './TreeQrCode';

interface TreeProjectorProps {
  session: TreeSessionDetail;
  /** Submissions at first paint; Realtime deltas are layered on top. */
  initialSubmissions: TreeSubmissionRow[];
}

/** The four teams, in display order. */
const TEAMS: TeamNumber[] = [1, 2, 3, 4];

/**
 * Builds the URL a student scans to join.
 *
 * The student SPA is a static bundle served from a directory root (Cloudflare
 * Pages `assets.directory`), with no client-side router — so the join link must
 * target its INDEX (`/` or `/index.html`) and carry the session as a query
 * parameter, exactly what `loadTreeFromUrl()` reads. A path like `/tree/join`
 * would be a 404 because there is no such document.
 *
 * The SPA is a separate origin from the teacher web, so its base comes from
 * `NEXT_PUBLIC_STUDENT_APP_URL` (see lib/env.ts); the current origin is the
 * documented local-development fallback.
 */
function buildJoinUrl(sessionId: string): string {
  const base = resolveStudentAppBaseUrl();
  return base ? `${base}/?session=${sessionId}` : `/?session=${sessionId}`;
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
 * TreeProjector — the classroom projector view for one tree session.
 *
 * Phase 7.3 rendered one class-wide tree. Phase 8.4 turns the stage into a 2×2
 * "competition arena": each Tổ gets its OWN tree, seeded by
 * `getTeamSeed(session.tree_seed, teamNumber)` so the four trees are visually
 * distinct, and fed only that team's submissions. The FIRST team to reach 100%
 * of its roster is latched as the champion.
 *
 * Live growth is still driven purely by the `submissions` array: the engine
 * derives each tree from its seed + that team's data on every render, so a
 * Realtime event only merges one row into state and all four trees redraw
 * themselves. No stored geometry and no incremental animation bookkeeping means
 * a late-joining projector and a live one show the identical arena.
 */
export function TreeProjector({ session, initialSubmissions }: TreeProjectorProps) {
  const [submissions, setSubmissions] = useState<TreeSubmissionRow[]>(initialSubmissions);
  const [isActive, setIsActive] = useState(session.is_active);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [hovered, setHovered] = useState<{ team: TeamNumber; anchor: LayoutFruitAnchor } | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEnding, setIsEnding] = useState(false);
  const [muted, setMuted] = useState(false);
  const [firstFinishedTeam, setFirstFinishedTeam] = useState<TeamNumber | null>(null);

  // Phase 8.3 — sound is opt-out and its state lives in localStorage, but the
  // value can only be read on the client, so it is synced after mount rather
  // than in the initializer (which would desync SSR and hydration).
  useEffect(() => {
    setMuted(isAudioMuted());
  }, []);

  // Autoplay Policy: an AudioContext starts suspended and may only be resumed
  // from a user gesture. One capture-phase listener unlocks it on the first
  // click anywhere, then removes itself.
  useEffect(() => {
    const unlock = () => {
      void resumeAudioContext();
      window.removeEventListener('pointerdown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    return () => window.removeEventListener('pointerdown', unlock, true);
  }, []);

  const joinUrl = useMemo(() => buildJoinUrl(session.id), [session.id]);

  // --- countdown -----------------------------------------------------------
  const deadline = useMemo(
    () => new Date(session.created_at).getTime() + session.time_limit_minutes * 60_000,
    [session.created_at, session.time_limit_minutes],
  );
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
      // Guard against a missing server-side filter: a row for another session
      // must never be merged into this arena.
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
  /**
   * One entry per team: its roster size, its submissions, the derived tree state
   * and whether it has finished. `useMemo` keyed on `submissions` keeps a tooltip
   * re-render from recomputing four anchor relaxations.
   */
  const teamStats = useMemo(() => {
    const counts: TeamCounts = session.team_counts ?? { 1: 0, 2: 0, 3: 0, 4: 0 };
    return TEAMS.map((team) => {
      const teamSubmissions = submissions.filter(
        (row) => clampTeamNumber(row.team_number) === team,
      );
      // Floor the denominator at 1: `computeTreeState` divides by it, and an
      // empty team would otherwise yield Infinity/NaN for the ratio. A team with
      // no members can never finish, so guard `isFinished` on the raw count.
      const rawTotal = counts[team] ?? 0;
      const treeState: TreeState = computeTreeState({
        totalStudents: Math.max(rawTotal, 1),
        submissions: teamSubmissions,
        timeLimitMinutes: session.time_limit_minutes,
        createdAt: session.created_at,
        seed: getTeamSeed(session.tree_seed, team),
      });
      const done = teamSubmissions.length;
      return {
        team,
        rawTotal,
        done,
        percent: rawTotal > 0 ? Math.min(100, Math.round((done / rawTotal) * 100)) : 0,
        treeState,
        isFinished: rawTotal > 0 && done >= rawTotal,
        teamSubmissions,
      };
    });
  }, [submissions, session.team_counts, session.time_limit_minutes, session.created_at, session.tree_seed]);

  const k = submissions.length;
  const totalStudents = Math.max(session.total_students, 1);
  const percent = Math.min(100, Math.round((k / totalStudents) * 100));

  // Phase 8.3 — vitality for the dewdrop chime, from the class-wide tree so the
  // sound tracks the overall pace rather than any single team's.
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

  // --- first-to-finish latch (Tổ cán đích đầu tiên) ------------------------
  // Sound is edge-triggered, not level-triggered: a chirp per NEW submission and
  // a fanfare on the single first-finish transition. Comparing against refs means
  // an UPDATE echo or a re-render can never replay a sound.
  const previousCountRef = useRef(submissions.length);
  const vitalityRef = useRef(vitality);
  vitalityRef.current = vitality;
  const firstFinishedRef = useRef<TeamNumber | null>(null);

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
    // The champion is whichever team finished first and is not yet latched. Once
    // set it never changes, so a later team reaching 100% does not steal the 🏆.
    if (firstFinishedRef.current !== null) return;
    const finishing = teamStats.find((stat) => stat.isFinished);
    if (!finishing) return;

    firstFinishedRef.current = finishing.team;
    setFirstFinishedTeam(finishing.team);
    playBloomFanfare();
  }, [teamStats]);

  const handleToggleMute = useCallback(() => {
    // Resume first: the toggle button is itself a gesture, so this is the
    // natural place to satisfy the Autoplay Policy before flipping the flag.
    void resumeAudioContext();
    setMuted(toggleAudioMute());
  }, []);

  // The pinned fruit wins over the transient hover, so a click "sticks" while
  // the pointer moves off to read the preview.
  const activeFruit = useMemo(() => {
    if (pinnedId) return submissions.find((row) => row.id === pinnedId) ?? null;
    if (!hovered) return null;
    return submissions.find((row) => row.id === hovered.anchor.id) ?? null;
  }, [pinnedId, hovered, submissions]);

  /** Which team card should host the detail card: the pinned fruit's, else the hovered one. */
  const tooltipTeam = useMemo<{ team: TeamNumber; anchor: LayoutFruitAnchor | null } | null>(() => {
    if (pinnedId && activeFruit) {
      return { team: clampTeamNumber(activeFruit.team_number), anchor: null };
    }
    if (hovered) return { team: hovered.team, anchor: hovered.anchor };
    return null;
  }, [pinnedId, activeFruit, hovered]);

  useEffect(() => {
    // Reset the answer reveal whenever a different fruit is selected — an
    // inherited "revealed" state would leak one student's answer over another's.
    setShowAnswer(false);
  }, [activeFruit?.id]);

  const handleEndSession = async () => {
    if (!window.confirm('Kết thúc hoạt động? Học sinh sẽ không thể nộp thêm câu trả lời.')) return;
    setIsEnding(true);
    setError(null);
    try {
      await endTreeSession(createClient(), session.id);
      setIsActive(false);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không kết thúc được hoạt động.');
    } finally {
      setIsEnding(false);
    }
  };

  const handleSaveImage = () => {
    const dataUrl = canvasRefs.current[1]?.current?.exportImage();
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

  // One ref per team card, so the "memory picture" can export a single tree.
  const canvasRefs = useRef<Record<TeamNumber, { current: TreeCanvasHandle | null }>>({
    1: { current: null },
    2: { current: null },
    3: { current: null },
    4: { current: null },
  });

  const champion = firstFinishedTeam;

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

        {/* Timer + progress + champion */}
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
            <div className="flex items-center gap-2 rounded-lg border border-amber-400/60 bg-amber-500/15 px-3 py-2">
              <Trophy size={16} className="shrink-0 text-amber-300" />
              <p className="text-xs font-bold text-amber-100">
                QUÁN QUÂN: TỔ {champion} về đích đầu tiên!
              </p>
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
            isChampion={champion === stat.team}
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
    </div>
  );
}

/** One team's card: header, tree canvas and (optionally) the detail card. */
function TeamCard({
  session,
  stat,
  isChampion,
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
  isChampion: boolean;
  canvasRef: { current: TreeCanvasHandle | null };
  onFruitHover: (anchor: LayoutFruitAnchor | null) => void;
  onFruitClick: (anchor: LayoutFruitAnchor | null) => void;
  tooltip: React.ReactNode;
}) {
  const { team, treeState, done, rawTotal, percent, teamSubmissions } = stat;
  const vitalityPercent = Math.round(treeState.vitality * 100);

  return (
    <section
      className={`relative flex min-h-[42vh] flex-col overflow-hidden rounded-2xl border bg-slate-900/60 transition-shadow lg:min-h-0 ${
        isChampion
          ? 'border-amber-400 ring-4 ring-amber-400 shadow-xl shadow-amber-500/20'
          : 'border-slate-800'
      }`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-lg px-2.5 py-1 text-sm font-extrabold ${
              isChampion ? 'bg-amber-400 text-amber-950' : 'bg-emerald-600 text-white'
            }`}
          >
            Tổ {team}
          </span>
          {isChampion && (
            <span className="flex items-center gap-1 text-xs font-bold text-amber-300">
              <Trophy size={14} />
              Quán quân
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] font-semibold">
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-200">
            {done}/{rawTotal} ({percent}%)
          </span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-teal-300">
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

        {isChampion && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-2">
            <p className="animate-pulse rounded-full border border-amber-400/70 bg-amber-500/25 px-4 py-1.5 text-center text-xs font-extrabold text-amber-50 shadow-lg backdrop-blur">
              🏆 QUÁN QUÂN: TỔ {team} VỀ ĐÍCH ĐẦU TIÊN! 🌸
            </p>
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
  /** The hovered fruit, used to position the card. Null when a click pinned it. */
  anchor: LayoutFruitAnchor | null;
  fruit: TreeSubmissionRow;
  showAnswer: boolean;
  onToggleAnswer: () => void;
  onClose: () => void;
}

/**
 * Floating fruit detail card, hosted inside the owning team's card.
 *
 * Positioned from the hovered anchor's pixel coordinates (which are already in
 * that card's canvas space), clamped inside the card so a fruit near an edge does
 * not push the card off-screen. When a fruit is pinned (no hover) the card docks
 * to a fixed corner instead of tracking a pointer that is no longer there.
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
