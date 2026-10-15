'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Play, QrCode, RotateCcw, Smartphone, Users, Volume2, VolumeX } from 'lucide-react';
import { resolveStudentAppBaseUrl } from '@/lib/env';
import { createClient } from '@/lib/supabase/client';
import { resetTugOfWarController } from '@/lib/tugOfWar';
import type { TugOfWarParticipant, TugOfWarSessionDetail } from '@/lib/types';
import { TugOfWarQrCode } from './TugOfWarQrCode';

interface TugOfWarLobbyProps {
  session: TugOfWarSessionDetail;
  isStarting: boolean;
  onStart: () => void;
}

export function TugOfWarLobby({ session, isStarting, onStart }: TugOfWarLobbyProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

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
      // Ignored if blocked
    }
  }, []);

  const studentBase = resolveStudentAppBaseUrl();
  const blueJoinUrl = studentBase
    ? `${studentBase}/?tug=${session.session_code}&team=BLUE`
    : `/?tug=${session.session_code}&team=BLUE`;
  const redJoinUrl = studentBase
    ? `${studentBase}/?tug=${session.session_code}&team=RED`
    : `/?tug=${session.session_code}&team=RED`;

  const blueParticipants: TugOfWarParticipant[] = session.joined_participants?.blue || [];
  const redParticipants: TugOfWarParticipant[] = session.joined_participants?.red || [];

  const [resettingTeam, setResettingTeam] = useState<'BLUE' | 'RED' | null>(null);

  const handleResetController = async (team: 'BLUE' | 'RED') => {
    try {
      setResettingTeam(team);
      const supabase = createClient();
      await resetTugOfWarController(supabase, session.id, team);
    } catch (err) {
      console.error('Failed to reset controller:', err);
    } finally {
      setResettingTeam(null);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 select-none overflow-hidden">
      {/* Top Header Bar */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/90 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 via-indigo-600 to-rose-600 text-xl shadow-lg">
            ⚔️
          </span>
          <div>
            <h1 className="text-base font-extrabold text-amber-400 sm:text-lg">
              {session.title}
            </h1>
            <p className="text-xs text-slate-400">
              Phòng Chờ Thi Đấu Kéo Co Tri Thức • {session.class_name || 'Lớp học'}
            </p>
          </div>
        </div>

        {/* Center PIN Badge */}
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-2 text-center shadow-inner">
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-300">
            Mã PIN:
          </span>
          <span className="font-mono text-2xl font-black tracking-widest text-amber-400">
            {session.session_code}
          </span>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            <span className="hidden sm:inline">{isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}</span>
          </button>
        </div>
      </header>

      {/* Main 2-Column Team Arena Lobby */}
      <main className="grid flex-1 grid-cols-1 md:grid-cols-2 gap-6 p-6 overflow-hidden">
        {/* Blue Team Column */}
        <div className="flex flex-col rounded-3xl border-2 border-blue-500/40 bg-gradient-to-b from-blue-950/40 via-slate-900/90 to-blue-950/20 p-6 shadow-2xl backdrop-blur relative overflow-hidden">
          <div className="absolute -top-24 -left-24 h-48 w-48 rounded-full bg-blue-600/20 blur-3xl" />
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-blue-500/30 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-2xl shadow-lg shadow-blue-500/30">
                🔵
              </span>
              <div>
                <h2 className="text-xl font-black tracking-wide text-blue-300 uppercase">
                  {session.blue_team_name}
                </h2>
                <p className="text-xs text-blue-400 font-medium">
                  Tổ {session.blue_group_number} • Quét mã để gia nhập
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-blue-500/40 bg-blue-500/20 px-3.5 py-1 text-xs font-bold text-blue-200">
              <Users size={14} />
              <span>{blueParticipants.length} Đã vào</span>
            </div>
          </div>

          {/* QR Code & Join Info */}
          <div className="flex flex-col sm:flex-row items-center gap-6 py-6 border-b border-blue-500/20">
            <div className="shrink-0 p-1 rounded-2xl bg-white shadow-xl ring-4 ring-blue-500/30">
              <TugOfWarQrCode value={blueJoinUrl} size={160} />
            </div>
            <div className="space-y-2 text-center sm:text-left">
              <span className="inline-block rounded-full bg-blue-600/30 border border-blue-400/40 px-3 py-1 text-xs font-semibold text-blue-200">
                📲 Dành riêng cho Đội Xanh
              </span>
              <p className="text-xs text-slate-300 leading-relaxed">
                Học sinh dùng camera điện thoại quét mã QR bên cạnh để vào đội Xanh.
              </p>
              <p className="break-all font-mono text-[11px] text-blue-300/70 select-all">
                {blueJoinUrl}
              </p>
            </div>
          </div>

          {/* Blue Controller Device Status */}
          <div className="mt-4 flex items-center justify-between rounded-2xl border border-blue-500/40 bg-blue-950/60 p-3 shadow-inner">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600/30 text-blue-300">
                <Smartphone size={18} />
              </span>
              <div>
                <div className="text-xs font-bold text-white flex items-center gap-2">
                  <span>Tay cầm điều khiển:</span>
                  {session.blue_controller ? (
                    <span className="text-emerald-400 font-extrabold flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      {session.blue_controller.full_name || session.blue_controller.student_code}
                    </span>
                  ) : (
                    <span className="text-amber-400 font-medium">Chờ quét mã...</span>
                  )}
                </div>
                <div className="text-[11px] text-blue-300/70">
                  {session.blue_controller
                    ? 'Thiết bị đại diện duy nhất của Đội Xanh đã kết nối'
                    : 'Thiết bị đầu tiên quét mã sẽ trở thành tay cầm bấm đáp án'}
                </div>
              </div>
            </div>
            {session.blue_controller && (
              <button
                type="button"
                onClick={() => handleResetController('BLUE')}
                disabled={resettingTeam === 'BLUE'}
                className="flex items-center gap-1 rounded-xl border border-rose-500/40 bg-rose-500/20 px-2.5 py-1.5 text-xs font-bold text-rose-300 transition hover:bg-rose-500/30 disabled:opacity-50"
              >
                {resettingTeam === 'BLUE' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RotateCcw size={13} />
                )}
                <span>Đổi thiết bị</span>
              </button>
            )}
          </div>

          {/* Live Roster List */}
          <div className="flex-1 overflow-y-auto mt-4 pr-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-2">
              Danh Sách Thành Viên ({blueParticipants.length})
            </h3>
            {blueParticipants.length === 0 ? (
              <div className="flex h-32 items-center justify-center rounded-2xl border border-dashed border-blue-500/20 bg-blue-950/20 text-center text-xs text-blue-300/60">
                Đang chờ học sinh Đội Xanh quét mã vào phòng...
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {blueParticipants.map((p, idx) => (
                  <div
                    key={`${p.student_code}-${idx}`}
                    className="flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-900/30 px-3 py-2 text-xs font-medium text-blue-100 shadow-sm animate-in fade-in zoom-in-95 duration-150"
                  >
                    <span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]" />
                    <div className="truncate">
                      <div className="font-bold truncate">{p.full_name || p.student_code}</div>
                      <div className="text-[10px] text-blue-300/70 font-mono">{p.student_code}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Red Team Column */}
        <div className="flex flex-col rounded-3xl border-2 border-rose-500/40 bg-gradient-to-b from-rose-950/40 via-slate-900/90 to-rose-950/20 p-6 shadow-2xl backdrop-blur relative overflow-hidden">
          <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-rose-600/20 blur-3xl" />
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-rose-500/30 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-600 text-2xl shadow-lg shadow-rose-500/30">
                🔴
              </span>
              <div>
                <h2 className="text-xl font-black tracking-wide text-rose-300 uppercase">
                  {session.red_team_name}
                </h2>
                <p className="text-xs text-rose-400 font-medium">
                  Tổ {session.red_group_number} • Quét mã để gia nhập
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-rose-500/40 bg-rose-500/20 px-3.5 py-1 text-xs font-bold text-rose-200">
              <Users size={14} />
              <span>{redParticipants.length} Đã vào</span>
            </div>
          </div>

          {/* QR Code & Join Info */}
          <div className="flex flex-col sm:flex-row items-center gap-6 py-6 border-b border-rose-500/20">
            <div className="shrink-0 p-1 rounded-2xl bg-white shadow-xl ring-4 ring-rose-500/30">
              <TugOfWarQrCode value={redJoinUrl} size={160} />
            </div>
            <div className="space-y-2 text-center sm:text-left">
              <span className="inline-block rounded-full bg-rose-600/30 border border-rose-400/40 px-3 py-1 text-xs font-semibold text-rose-200">
                📲 Dành riêng cho Đội Đỏ
              </span>
              <p className="text-xs text-slate-300 leading-relaxed">
                Học sinh dùng camera điện thoại quét mã QR bên cạnh để vào đội Đỏ.
              </p>
              <p className="break-all font-mono text-[11px] text-rose-300/70 select-all">
                {redJoinUrl}
              </p>
            </div>
          </div>

          {/* Red Controller Device Status */}
          <div className="mt-4 flex items-center justify-between rounded-2xl border border-rose-500/40 bg-rose-950/60 p-3 shadow-inner">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-600/30 text-rose-300">
                <Smartphone size={18} />
              </span>
              <div>
                <div className="text-xs font-bold text-white flex items-center gap-2">
                  <span>Tay cầm điều khiển:</span>
                  {session.red_controller ? (
                    <span className="text-emerald-400 font-extrabold flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      {session.red_controller.full_name || session.red_controller.student_code}
                    </span>
                  ) : (
                    <span className="text-amber-400 font-medium">Chờ quét mã...</span>
                  )}
                </div>
                <div className="text-[11px] text-rose-300/70">
                  {session.red_controller
                    ? 'Thiết bị đại diện duy nhất của Đội Đỏ đã kết nối'
                    : 'Thiết bị đầu tiên quét mã sẽ trở thành tay cầm bấm đáp án'}
                </div>
              </div>
            </div>
            {session.red_controller && (
              <button
                type="button"
                onClick={() => handleResetController('RED')}
                disabled={resettingTeam === 'RED'}
                className="flex items-center gap-1 rounded-xl border border-rose-500/40 bg-rose-500/20 px-2.5 py-1.5 text-xs font-bold text-rose-300 transition hover:bg-rose-500/30 disabled:opacity-50"
              >
                {resettingTeam === 'RED' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RotateCcw size={13} />
                )}
                <span>Đổi thiết bị</span>
              </button>
            )}
          </div>

          {/* Live Roster List */}
          <div className="flex-1 overflow-y-auto mt-4 pr-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-rose-400 mb-2">
              Danh Sách Thành Viên ({redParticipants.length})
            </h3>
            {redParticipants.length === 0 ? (
              <div className="flex h-32 items-center justify-center rounded-2xl border border-dashed border-rose-500/20 bg-rose-950/20 text-center text-xs text-rose-300/60">
                Đang chờ học sinh Đội Đỏ quét mã vào phòng...
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {redParticipants.map((p, idx) => (
                  <div
                    key={`${p.student_code}-${idx}`}
                    className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-900/30 px-3 py-2 text-xs font-medium text-rose-100 shadow-sm animate-in fade-in zoom-in-95 duration-150"
                  >
                    <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.8)]" />
                    <div className="truncate">
                      <div className="font-bold truncate">{p.full_name || p.student_code}</div>
                      <div className="text-[10px] text-rose-300/70 font-mono">{p.student_code}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Bottom Start Banner */}
      <footer className="h-20 shrink-0 border-t border-slate-800 bg-slate-900/95 px-8 flex items-center justify-between shadow-2xl">
        <div className="flex items-center gap-6 text-xs text-slate-300">
          <div>
            <span className="text-slate-400">Số câu:</span>{' '}
            <strong className="text-white">{session.question_count}</strong>
          </div>
          <div>
            <span className="text-slate-400">Thời gian:</span>{' '}
            <strong className="text-white">{session.duration_seconds}s</strong>
          </div>
          <div>
            <span className="text-slate-400">Cách biệt thắng:</span>{' '}
            <strong className="text-white">{session.win_gap > 0 ? `${session.win_gap} câu` : 'Tắt'}</strong>
          </div>
          <div>
            <span className="text-slate-400">Phạt đóng băng:</span>{' '}
            <strong className="text-white">{session.freeze_seconds}s</strong>
          </div>
        </div>

        <button
          type="button"
          onClick={onStart}
          disabled={isStarting}
          className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-rose-600 px-8 py-3.5 text-base font-extrabold text-white shadow-xl shadow-indigo-600/30 transition hover:brightness-110 active:scale-95 disabled:opacity-50"
        >
          {isStarting ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              ĐANG BẮT ĐẦU...
            </>
          ) : (
            <>
              <Play size={20} className="fill-white" />
              🚀 BẮT ĐẦU KÉO CO
            </>
          )}
        </button>
      </footer>
    </div>
  );
}
