'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Maximize2, MonitorOff, Radio, RefreshCw, Users } from 'lucide-react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import type { ActiveSessionRow, StudentRow } from '@/lib/types';

interface LiveProctorPanelProps {
  examCode: string;
  /** Roster for this exam, used to resolve names (active_sessions holds no PII). */
  roster: StudentRow[];
}

/** A session is "stale" once its heartbeat is older than this (heartbeat = 20s). */
const STALE_AFTER_MS = 45_000;
/** The staleness badge is relative to the clock, so re-evaluate on a timer. */
const TICK_MS = 5_000;

type ConnectionState = 'connecting' | 'live' | 'error';

/**
 * LiveProctorPanel — realtime proctoring monitor for one exam (Phase 5, D2).
 *
 * Subscribes to `active_sessions` via postgres_changes. v1 kept this state in
 * Firebase RTDB (`/sessions/{examCode}`); v2 reads the same table the 20s
 * heartbeat RPC writes to, so no extra write path is needed.
 *
 * The table stores no names — identity is joined from the roster in memory.
 * Rows vanish on submit because `submit_exam_result` deletes the session.
 */
export function LiveProctorPanel({ examCode, roster }: LiveProctorPanelProps) {
  const [sessions, setSessions] = useState<Record<string, ActiveSessionRow>>({});
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** Roster lookup: student_code -> identity. */
  const rosterByCode = useMemo(() => {
    const map = new Map<string, StudentRow>();
    for (const student of roster) map.set(student.student_code, student);
    return map;
  }, [roster]);

  // Recompute staleness on a timer; the data itself is event-driven.
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, []);

  const fetchSessions = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: queryError } = await supabase
        .from('active_sessions')
        .select('*')
        .eq('exam_code', examCode);

      if (queryError) throw new PersistenceError(queryError.message);

      const next: Record<string, ActiveSessionRow> = {};
      for (const row of (data ?? []) as ActiveSessionRow[]) next[row.student_code] = row;
      setSessions(next);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không tải được phiên làm bài.');
    } finally {
      setIsRefreshing(false);
    }
  }, [examCode]);

  // Initial snapshot, then live deltas.
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Keep the latest fetch in a ref so the Realtime callback stays stable.
  const refreshRef = useRef(fetchSessions);
  useEffect(() => {
    refreshRef.current = fetchSessions;
  }, [fetchSessions]);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel;

    /** Applies one postgres_changes payload to local state. */
    const applyChange = (payload: RealtimePostgresChangesPayload<ActiveSessionRow>) => {
      const eventType = payload.eventType;

      if (eventType === 'DELETE') {
        const removed = (payload.old as Partial<ActiveSessionRow>)?.student_code;
        if (!removed) {
          // DELETE records only carry the replica identity; if it is missing,
          // fall back to a refetch rather than silently keeping a ghost row.
          void refreshRef.current();
          return;
        }
        setSessions((previous) => {
          if (!(removed in previous)) return previous;
          const next = { ...previous };
          delete next[removed];
          return next;
        });
        return;
      }

      const row = payload.new as ActiveSessionRow;
      if (!row?.student_code) return;
      // Guard against events for other exams if the filter is not applied
      // server-side (e.g. replica identity fallback).
      if (row.exam_code !== examCode) return;

      setSessions((previous) => ({ ...previous, [row.student_code]: row }));
    };

    channel = supabase
      .channel(`active_sessions:${examCode}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'active_sessions',
          filter: `exam_code=eq.${examCode}`,
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
  }, [examCode]);

  const rows = useMemo(() => {
    return Object.values(sessions)
      .map((session) => {
        const staleSince = now - new Date(session.last_heartbeat).getTime();
        return {
          ...session,
          identity: rosterByCode.get(session.student_code),
          isStale: staleSince > STALE_AFTER_MS,
          staleSeconds: Math.max(0, Math.floor(staleSince / 1000)),
        };
      })
      .sort((a, b) => {
        // Flagged candidates first, then the most recently active.
        const aFlag = a.blur_count > 0 || a.fullscreen_exit_count > 0 ? 0 : 1;
        const bFlag = b.blur_count > 0 || b.fullscreen_exit_count > 0 ? 0 : 1;
        if (aFlag !== bFlag) return aFlag - bFlag;
        return b.blur_count + b.fullscreen_exit_count - (a.blur_count + a.fullscreen_exit_count);
      });
  }, [sessions, rosterByCode, now]);

  const onlineCount = rows.filter((row) => !row.isStale).length;
  const flaggedCount = rows.filter((row) => row.blur_count > 0 || row.fullscreen_exit_count > 0).length;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <Users size={16} className="text-slate-500" />
        <h2 className="text-sm font-bold text-slate-900">Giám sát trực tiếp</h2>

        <ConnectionBadge state={connection} onlineCount={onlineCount} />

        {flaggedCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
            <AlertTriangle size={12} />
            {flaggedCount} cần chú ý
          </span>
        )}

        <button
          type="button"
          onClick={() => void fetchSessions()}
          disabled={isRefreshing}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : undefined} />
          Làm mới
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="text-xs text-rose-700">{error}</p>
        </div>
      )}

      {connection === 'error' && !error && (
        <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-700">
            Mất kết nối thời gian thực. Danh sách có thể không tự cập nhật — hãy bấm Làm mới.
          </p>
        </div>
      )}

      {/* Body */}
      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-slate-500">
          Chưa có học sinh nào đăng nhập. Danh sách sẽ tự cập nhật khi thí sinh vào phòng.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-3 py-2.5 font-semibold">Mã HS</th>
                <th className="px-3 py-2.5 font-semibold">Họ và tên</th>
                <th className="px-3 py-2.5 font-semibold">Lớp</th>
                <th className="px-3 py-2.5 font-semibold">Câu hiện tại</th>
                <th className="px-3 py-2.5 font-semibold">Đã trả lời</th>
                <th className="px-3 py-2.5 font-semibold">Cảnh báo</th>
                <th className="px-3 py-2.5 font-semibold">Nhịp tim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr
                  key={row.student_code}
                  className={
                    row.isStale
                      ? 'bg-slate-50/70 text-slate-400'
                      : 'transition hover:bg-slate-50'
                  }
                >
                  <td className="px-3 py-2">
                    {row.isStale ? (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                        <MonitorOff size={13} />
                        Mất kết nối
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                        </span>
                        Đang làm bài
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.student_code}</td>
                  <td className="px-3 py-2 font-medium">{row.identity?.full_name ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{row.identity?.class_name ?? '—'}</td>
                  <td className="px-3 py-2">Câu {row.current_question + 1}</td>
                  <td className="px-3 py-2 tabular-nums">{row.answered_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.blur_count > 0 && (
                        <span
                          title={`Rời khỏi tab ${row.blur_count} lần`}
                          className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700"
                        >
                          <MonitorOff size={11} />
                          {row.blur_count}
                        </span>
                      )}
                      {row.fullscreen_exit_count > 0 && (
                        <span
                          title={`Thoát toàn màn hình ${row.fullscreen_exit_count} lần`}
                          className="flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700"
                        >
                          <Maximize2 size={11} />
                          {row.fullscreen_exit_count}
                        </span>
                      )}
                      {row.blur_count === 0 && row.fullscreen_exit_count === 0 && (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {row.isStale ? `${row.staleSeconds}s trước` : 'vừa xong'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Realtime connection + live candidate count. */
function ConnectionBadge({ state, onlineCount }: { state: ConnectionState; onlineCount: number }) {
  if (state === 'connecting') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
        <Radio size={12} className="animate-pulse" />
        Đang kết nối…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
        <Radio size={12} />
        Mất kết nối
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
      <Radio size={12} />
      Trực tiếp · {onlineCount} đang làm
    </span>
  );
}
