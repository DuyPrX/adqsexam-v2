'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Maximize2, Minimize2, Play, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { TeamNumber, TreeRosterEntry, TreeSessionDetail } from '@/lib/types';
import { TreeQrCode } from './TreeQrCode';

/** The four Cây cards, in display order. */
const TEAMS: TeamNumber[] = [1, 2, 3, 4];

/** Colour per Tổ, matching the arena's badges and the roster planner's columns. */
const TEAM_ACCENT: Record<TeamNumber, string> = {
  1: 'border-blue-500/50 bg-blue-500/10 text-blue-200',
  2: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  3: 'border-amber-500/50 bg-amber-500/10 text-amber-200',
  4: 'border-purple-500/50 bg-purple-500/10 text-purple-200',
};

interface TreeLobbyProps {
  session: TreeSessionDetail;
  /** The URL a student scans / opens to join. */
  joinUrl: string;
  /** True while the LOBBY -> ACTIVE RPC is in flight. */
  isStarting: boolean;
  onStart: () => void;
}

export function TreeLobby({ session, joinUrl, isStarting, onStart }: TreeLobbyProps) {
  const [showUrl, setShowUrl] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Set of student_code (normalized uppercase) who have checked into the lobby live
  const [joinedCodes, setJoinedCodes] = useState<Set<string>>(new Set());
  // Count of anonymous connections currently on the QR check-in screen
  const [scanningCount, setScanningCount] = useState(0);

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
      // Ignore if blocked
    }
  }, []);

  // --- Realtime Presence & Broadcast for Student Check-in in Lobby ---------
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`tree-lobby-${session.id}`, {
      config: { presence: { key: 'projector' } },
    });

    const syncPresence = () => {
      const state = channel.presenceState();
      const codes = new Set<string>();
      let anonymousViewers = 0;

      Object.values(state).forEach((presences) => {
        (presences as Array<Record<string, unknown>>).forEach((p) => {
          if (p.role === 'projector') return;
          const code = String(p.student_code ?? '').trim().toUpperCase();
          if (code) {
            codes.add(code);
          } else {
            anonymousViewers += 1;
          }
        });
      });

      setJoinedCodes((prev) => {
        const merged = new Set(prev);
        codes.forEach((c) => merged.add(c));
        return merged;
      });
      setScanningCount(anonymousViewers);
    };

    channel
      .on('presence', { event: 'sync' }, syncPresence)
      .on('presence', { event: 'join' }, syncPresence)
      .on('broadcast', { event: 'student_checkin' }, ({ payload }) => {
        const code = String(payload?.student_code ?? '').trim().toUpperCase();
        if (code) {
          setJoinedCodes((prev) => {
            const next = new Set(prev);
            next.add(code);
            return next;
          });
        }
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session.id]);

  /** The present roster with each member's EFFECTIVE team applied. */
  const presentByTeam = useMemo(() => {
    const config = session.participant_config ?? { absent_ids: [], assignments: {} };
    const absent = new Set(config.absent_ids);
    const grouped: Record<TeamNumber, TreeRosterEntry[]> = { 1: [], 2: [], 3: [], 4: [] };

    session.roster
      .filter((member) => !absent.has(member.id))
      .forEach((member) => {
        const override = Number(config.assignments[member.id]);
        const team = (override >= 1 && override <= 4 ? override : member.team_number) as TeamNumber;
        grouped[team].push(member);
      });

    return grouped;
  }, [session.roster, session.participant_config]);

  const presentCount = TEAMS.reduce((sum, team) => sum + presentByTeam[team].length, 0);
  const absentCount = (session.participant_config?.absent_ids ?? []).length;

  // Count how many roster members have actually joined the lobby
  const joinedRosterCount = useMemo(() => {
    let count = 0;
    TEAMS.forEach((team) => {
      presentByTeam[team].forEach((m) => {
        if (joinedCodes.has(String(m.student_code ?? '').trim().toUpperCase())) {
          count += 1;
        }
      });
    });
    return count;
  }, [presentByTeam, joinedCodes]);

  const handleStartWithBroadcast = async () => {
    // Broadcast an immediate start signal to all students in the lobby channel
    try {
      const supabase = createClient();
      const ch = supabase.channel(`tree-lobby-${session.id}`);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void ch.send({
            type: 'broadcast',
            event: 'bout_started',
            payload: { session_id: session.id },
          });
        }
      });
    } catch {
      // Non-fatal; DB RPC & polling still handle transition
    }
    onStart();
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 lg:h-screen lg:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-3.5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Phòng chờ · Đấu trường Cây Tri Thức
          </p>
          <h1 className="mt-0.5 text-2xl font-bold leading-tight">{session.title}</h1>
          <p className="text-xs text-slate-400">
            Lớp {session.class_name} · Sĩ số tham gia: {presentCount} học sinh
            {absentCount > 0 && ` (${absentCount} vắng mặt)`}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/50 bg-emerald-500/15 px-3.5 py-1 text-xs font-extrabold text-emerald-300">
            <CheckCircle2 size={14} />
            Đã vào phòng: {joinedRosterCount}/{presentCount} bạn
            {scanningCount > 0 && ` (+${scanningCount} đang chọn tên)`}
          </span>

          <span className="rounded-full border border-amber-400/50 bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-200">
            Đang chờ bắt đầu
          </span>

          <button
            type="button"
            onClick={() => void handleToggleFullscreen()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-emerald-500/50 hover:bg-slate-800"
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {isFullscreen ? 'Thoát Fullscreen' : 'Toàn màn hình'}
          </button>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:min-h-0 lg:grid-cols-[22rem_1fr] lg:overflow-hidden">
        {/* --- Join panel --- */}
        <section className="flex flex-col items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-sm font-semibold text-slate-200">Học sinh quét mã để vào phòng</p>
          <div className="rounded-xl bg-white p-3">
            <TreeQrCode value={joinUrl} size={210} />
          </div>

          <div className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              Mã phòng
            </p>
            <p className="font-mono text-4xl font-extrabold tracking-[0.3em] text-emerald-300">
              {session.session_code}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowUrl((value) => !value)}
            className="text-xs font-semibold text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
          >
            {showUrl ? 'Ẩn liên kết' : 'Hiện liên kết trực tiếp'}
          </button>
          {showUrl && (
            <p className="break-all text-center text-[11px] leading-tight text-slate-400">{joinUrl}</p>
          )}

          <div className="mt-auto w-full rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-400">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                Sáng xanh: Đã vào phòng
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-slate-600" />
                Mờ: Chưa vào
              </span>
            </div>
          </div>
        </section>

        {/* --- Team cards (Strict 2x2 grid) + start --- */}
        <section className="flex min-h-0 flex-col gap-3">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 sm:grid-rows-2">
            {TEAMS.map((team) => {
              const rows = presentByTeam[team];
              const teamJoinedCount = rows.filter((m) =>
                joinedCodes.has(String(m.student_code ?? '').trim().toUpperCase()),
              ).length;

              return (
                <div
                  key={team}
                  className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div
                    className={cn(
                      'mb-2 flex shrink-0 items-center justify-between rounded-lg border px-3 py-1.5 text-sm font-extrabold',
                      TEAM_ACCENT[team],
                    )}
                  >
                    <span>Cây {team}</span>
                    <span className="flex items-center gap-1.5 text-xs">
                      <Users size={13} />
                      <span>
                        Đã vào: {teamJoinedCount}/{rows.length}
                      </span>
                    </span>
                  </div>
                  {rows.length === 0 ? (
                    <p className="px-1 text-xs italic text-slate-500">Chưa có học sinh nào.</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                      {rows.map((member) => {
                        const isJoined = joinedCodes.has(
                          String(member.student_code ?? '').trim().toUpperCase(),
                        );
                        return (
                          <li
                            key={member.id}
                            className={cn(
                              'flex items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 transition-all duration-300',
                              isJoined
                                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100 shadow-sm'
                                : 'border-transparent bg-slate-800/40 text-slate-400 opacity-55',
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  'h-2 w-2 shrink-0 rounded-full',
                                  isJoined
                                    ? 'animate-pulse bg-emerald-400 shadow-[0_0_8px_#34d399]'
                                    : 'bg-slate-600',
                                )}
                              />
                              <span className="truncate text-[11.5px] font-semibold">
                                {member.full_name}
                              </span>
                            </div>
                            {isJoined && (
                              <span className="shrink-0 rounded bg-emerald-500/25 px-1.5 py-0.5 text-[9.5px] font-bold text-emerald-300">
                                Có mặt
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => void handleStartWithBroadcast()}
            disabled={isStarting}
            className="flex shrink-0 w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-4 text-xl font-extrabold tracking-wide text-white shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isStarting ? <Loader2 size={24} className="animate-spin" /> : <Play size={24} />}
            {isStarting ? 'ĐANG BẮT ĐẦU…' : 'BẮT ĐẦU THI ĐẤU 🚀'}
          </button>
        </section>
      </main>
    </div>
  );
}