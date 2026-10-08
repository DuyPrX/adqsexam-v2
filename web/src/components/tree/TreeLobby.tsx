'use client';

import { useMemo, useState } from 'react';
import { Loader2, Play, Users } from 'lucide-react';
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

/**
 * Phase 9.1 — the projector's waiting room.
 *
 * Shown while `status === 'LOBBY'`. Its job is to be the ONE screen a class looks
 * at before a bout starts: a large QR + the short PIN so students can join, four
 * cards showing who is on which Cây, and the teacher's start button.
 *
 * The roster is projected from `participant_config` (absent students removed, team
 * overrides applied) so what the class reads here is exactly the split the arena
 * will use — computing it from `class_members` alone would ignore the pre-flight
 * edits and mislead everyone.
 */
export function TreeLobby({ session, joinUrl, isStarting, onStart }: TreeLobbyProps) {
  const [showUrl, setShowUrl] = useState(false);

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

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 lg:h-screen lg:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Phòng chờ · Đấu trường Cây Tri Thức
          </p>
          <h1 className="mt-1 text-2xl font-bold leading-tight">{session.title}</h1>
          <p className="text-xs text-slate-400">
            Lớp {session.class_name} · {presentCount} học sinh tham gia
            {absentCount > 0 && ` · ${absentCount} vắng mặt`}
          </p>
        </div>
        <span className="rounded-full border border-amber-400/50 bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-200">
          Đang chờ bắt đầu
        </span>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-6 lg:grid-cols-[24rem_1fr] lg:overflow-hidden">
        {/* --- Join panel --- */}
        <section className="flex flex-col items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-sm font-semibold text-slate-200">Học sinh quét mã để vào phòng</p>
          <div className="rounded-xl bg-white p-3">
            <TreeQrCode value={joinUrl} size={220} />
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

          <p className="mt-auto text-center text-xs text-slate-500">
            Trận đấu chỉ bắt đầu khi thầy/cô bấm nút bên phải.
          </p>
        </section>

        {/* --- Team cards + start --- */}
        <section className="flex min-h-0 flex-col gap-3">
          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            {TEAMS.map((team) => {
              const rows = presentByTeam[team];
              return (
                <div
                  key={team}
                  className="flex min-h-[10rem] flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div
                    className={cn(
                      'mb-2 flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm font-extrabold',
                      TEAM_ACCENT[team],
                    )}
                  >
                    <span>Cây {team}</span>
                    <span className="flex items-center gap-1">
                      <Users size={13} />
                      {rows.length}
                    </span>
                  </div>
                  {rows.length === 0 ? (
                    <p className="px-1 text-xs italic text-slate-500">Chưa có học sinh nào.</p>
                  ) : (
                    <ul className="grid grid-cols-2 gap-1 overflow-y-auto">
                      {rows.map((member) => (
                        <li
                          key={member.id}
                          className="flex items-center gap-1.5 rounded-md bg-slate-800/70 px-2 py-1"
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                          <span className="truncate text-[11px] text-slate-200">
                            {member.full_name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onStart}
            disabled={isStarting}
            className="flex w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-5 text-2xl font-extrabold tracking-wide text-white shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isStarting ? <Loader2 size={26} className="animate-spin" /> : <Play size={26} />}
            {isStarting ? 'ĐANG BẮT ĐẦU…' : 'BẮT ĐẦU THI ĐẤU 🚀'}
          </button>
        </section>
      </main>
    </div>
  );
}
