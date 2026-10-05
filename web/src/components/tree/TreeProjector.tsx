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
  Users,
} from 'lucide-react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import { endTreeSession } from '@/lib/tree';
import type { LayoutFruitAnchor } from '@/lib/tree-engine';
import type { TreeSessionDetail, TreeSubmissionRow } from '@/lib/types';
import { TreeCanvas, type TreeCanvasHandle } from './TreeCanvas';
import { TreeQrCode } from './TreeQrCode';

interface TreeProjectorProps {
  session: TreeSessionDetail;
  /** Submissions at first paint; Realtime deltas are layered on top. */
  initialSubmissions: TreeSubmissionRow[];
}

/**
 * Builds the URL a student scans to join.
 *
 * The student SPA is a static bundle served from a directory root (Cloudflare
 * Pages `assets.directory`), with no client-side router — so the join link must
 * target its INDEX (`/` or `/index.html`) and carry the session as a query
 * parameter, exactly what `loadTreeFromUrl()` reads. A path like `/tree/join`
 * would be a 404 because there is no such document.
 *
 * The SPA is a separate origin from the teacher web, so
 * `NEXT_PUBLIC_STUDENT_APP_URL` is preferred; falling back to the current origin
 * keeps local development working without configuration.
 */
function buildJoinUrl(sessionId: string): string {
  const base = (process.env.NEXT_PUBLIC_STUDENT_APP_URL ?? '').replace(/\/+$/, '');
  if (base) return `${base}/?session=${sessionId}`;
  if (typeof window !== 'undefined') return `${window.location.origin}/?session=${sessionId}`;
  return `/?session=${sessionId}`;
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
 * TreeProjector — the classroom projector view for one tree session (Phase 7.3).
 *
 * Live growth is driven purely by the `submissions` array: the engine derives
 * the whole tree from `tree_seed` + data on every render, so a Realtime event
 * only has to merge one row into state and the tree redraws itself. No stored
 * geometry and no incremental animation bookkeeping means a late-joining
 * projector and a live one show the identical tree.
 */
export function TreeProjector({ session, initialSubmissions }: TreeProjectorProps) {
  const [submissions, setSubmissions] = useState<TreeSubmissionRow[]>(initialSubmissions);
  const [isActive, setIsActive] = useState(session.is_active);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [hovered, setHovered] = useState<LayoutFruitAnchor | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEnding, setIsEnding] = useState(false);
  const canvasRef = useRef<TreeCanvasHandle>(null);

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
      // must never be merged into this tree.
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

  // --- derived stats -------------------------------------------------------
  const totalStudents = Math.max(session.total_students, 1);
  const k = submissions.length;
  const percent = Math.min(100, Math.round((k / totalStudents) * 100));

  // The pinned fruit wins over the transient hover, so a click "sticks" while
  // the pointer moves off to read the preview.
  const activeFruit = useMemo(() => {
    if (pinnedId) return submissions.find((row) => row.id === pinnedId) ?? null;
    if (!hovered) return null;
    return submissions.find((row) => row.id === hovered.id) ?? null;
  }, [pinnedId, hovered, submissions]);

  useEffect(() => {
    // Reset the answer reveal whenever a different fruit is selected — an
    // inherited "revealed" state would leak one student's answer over another's.
    setShowAnswer(false);
  }, [activeFruit?.id]);

  const handleFruitClick = useCallback((fruit: LayoutFruitAnchor | null) => {
    setPinnedId((current) => (fruit && fruit.id !== current ? fruit.id : null));
  }, []);

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
    const dataUrl = canvasRef.current?.exportImage();
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

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 lg:h-screen lg:flex-row">
      {/* ---------------- Sidebar ---------------- */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-slate-800 p-5 lg:w-[26rem] lg:border-r">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Cây Tri Thức
          </p>
          <h1 className="mt-1 text-2xl font-bold leading-tight">{session.title}</h1>
          <p className="mt-1 text-xs text-slate-400">Lớp {session.class_name}</p>
        </div>

        <div className="rounded-xl bg-slate-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Câu hỏi</p>
          <p className="mt-2 whitespace-pre-wrap text-lg font-semibold leading-snug text-slate-50">
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

        {/* Timer + progress */}
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
                {k}/{totalStudents} Học sinh ({percent}%)
              </span>
            </div>
            <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <ConnectionBadge state={connection} />
        </div>

        {/* QR */}
        <div className="flex flex-col items-center gap-2 rounded-xl bg-slate-900 p-4">
          <p className="text-sm font-semibold text-slate-200">Quét mã để tham gia</p>
          <TreeQrCode value={joinUrl} size={180} />
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
              {isExpired && isActive
                ? 'Đã hết thời gian làm bài.'
                : 'Hoạt động đã kết thúc.'}
            </p>
          )}

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

      {/* ---------------- Canvas stage ---------------- */}
      <main className="relative min-h-[60vh] flex-1 overflow-hidden lg:min-h-0">
        <TreeCanvas
          ref={canvasRef}
          session={session}
          totalStudents={totalStudents}
          submissions={submissions}
          onFruitClick={handleFruitClick}
          onFruitHover={setHovered}
        />

        {activeFruit && (
          <FruitTooltip
            anchor={hovered ?? null}
            fruit={activeFruit}
            showAnswer={showAnswer}
            onToggleAnswer={() => setShowAnswer((value) => !value)}
            onClose={() => setPinnedId(null)}
          />
        )}

        {k === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 text-center">
            <p className="inline-block rounded-full bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-300">
              Chưa có câu trả lời nào. Cây đang chờ những hạt mầm đầu tiên…
            </p>
          </div>
        )}
      </main>
    </div>
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
 * Floating fruit detail card.
 *
 * Positioned from the hovered anchor's pixel coordinates, clamped inside the
 * stage so a fruit near an edge does not push the card off-screen. When a fruit
 * is pinned (no hover) the card docks to a fixed corner instead of tracking a
 * pointer that is no longer there.
 */
function FruitTooltip({ anchor, fruit, showAnswer, onToggleAnswer, onClose }: FruitTooltipProps) {
  return (
    <div
      className="absolute z-20 w-72 max-w-[85vw] rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur"
      style={
        anchor
          ? { left: `min(max(${anchor.x + 12}px, 8px), calc(100% - 18rem - 8px))`, top: `${anchor.y + 12}px` }
          : { right: '1rem', bottom: '1rem' }
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-white">{fruit.student_name}</p>
          <p className="font-mono text-[11px] text-slate-400">{fruit.student_code}</p>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-600/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
          Quả #{fruit.fruit_index}
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
