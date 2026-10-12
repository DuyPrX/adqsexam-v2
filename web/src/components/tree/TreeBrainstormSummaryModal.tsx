'use client';

import React from 'react';
import type { TeamBrainstormSummary } from '@/lib/treeBrainstormSummary';

export interface TreeBrainstormSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  teams: TeamBrainstormSummary[];
  topicTitle?: string;
}

const RANK_BADGES: Record<number, string> = {
  1: '🥇 Hạng 1',
  2: '🥈 Hạng 2',
  3: '🥉 Hạng 3',
  4: 'Hạng 4',
};

const TEAM_THEMES: Record<number, { border: string; bg: string; badge: string; text: string }> = {
  1: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-950/20',
    badge: 'bg-amber-900/60 text-amber-200 border-amber-600/40',
    text: 'text-amber-400',
  },
  2: {
    border: 'border-emerald-500/40',
    bg: 'bg-emerald-950/20',
    badge: 'bg-emerald-900/60 text-emerald-200 border-emerald-600/40',
    text: 'text-emerald-400',
  },
  3: {
    border: 'border-yellow-500/40',
    bg: 'bg-yellow-950/20',
    badge: 'bg-yellow-900/60 text-yellow-200 border-yellow-600/40',
    text: 'text-yellow-400',
  },
  4: {
    border: 'border-fuchsia-500/40',
    bg: 'bg-fuchsia-950/20',
    badge: 'bg-fuchsia-900/60 text-fuchsia-200 border-fuchsia-600/40',
    text: 'text-fuchsia-400',
  },
};

export function TreeBrainstormSummaryModal({
  isOpen,
  onClose,
  teams,
  topicTitle = 'Thảo Luận Động Não',
}: TreeBrainstormSummaryModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 sm:p-6 backdrop-blur-md print:static print:inset-auto print:block print:bg-white print:p-0 print:backdrop-blur-none"
    >
      <div className="flex h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl print:h-auto print:border-none print:bg-white print:text-black print:shadow-none">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 bg-slate-800/80 px-6 py-4 sm:px-8 print:border-slate-300 print:bg-white print:px-0">
          <div>
            <h2 className="flex items-center gap-2.5 text-xl font-bold text-white sm:text-2xl print:text-slate-900">
              💡 Tổng Kết Ý Tưởng Động Não — {topicTitle}
            </h2>
            <p className="mt-1 text-xs text-slate-400 print:text-slate-600">
              Biên bản ghi nhận ý kiến đóng góp của từng thành viên theo từng tổ (1 học sinh = 1 ý tưởng)
            </p>
          </div>
          <div className="flex items-center gap-3 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 shadow-sm"
            >
              🖨️ In / Xuất Báo Cáo
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-600"
            >
              ✕ Đóng
            </button>
          </div>
        </header>

        {/* 4 Team Columns */}
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden p-4 sm:grid-cols-2 lg:grid-cols-4 sm:p-5 print:grid-cols-4 print:gap-3 print:p-0">
          {teams.map((team) => {
            const theme = TEAM_THEMES[team.teamNumber] || TEAM_THEMES[1];
            return (
              <div
                key={team.teamNumber}
                className={`flex flex-col overflow-hidden rounded-xl border ${theme.border} ${theme.bg} p-4 print:border-slate-300 print:bg-white print:p-2`}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 print:border-slate-300">
                  <div>
                    <h3 className="text-lg font-bold text-white print:text-slate-900">
                      {team.teamName}
                    </h3>
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300 print:bg-slate-100 print:text-slate-700">
                      {RANK_BADGES[team.rank] || `Hạng ${team.rank}`}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className={`text-2xl font-black ${theme.text} print:text-slate-900`}>
                      {team.totalApproved}
                    </span>
                    <span className="block text-[11px] text-slate-400 print:text-slate-600">
                      ý kiến
                    </span>
                  </div>
                </div>

                {/* 1 Student = 1 Idea Card List */}
                <div className="mt-3 flex-1 space-y-2.5 overflow-y-auto pr-1 print:overflow-visible">
                  {team.entries.length === 0 ? (
                    <p className="py-10 text-center text-xs text-slate-500 print:text-slate-400">
                      Chưa có ý kiến nào
                    </p>
                  ) : (
                    team.entries.map((entry, idx) => (
                      <div
                        key={entry.id || idx}
                        className="flex flex-col gap-1.5 rounded-lg border border-slate-700/50 bg-slate-800/80 p-3 shadow-sm transition hover:border-slate-600 print:border-slate-200 print:bg-slate-50 print:p-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1 text-xs font-semibold text-indigo-300 print:text-indigo-800">
                            👤 {entry.studentName}
                          </span>
                          <span className="text-[10px] text-slate-400 print:text-slate-500">
                            {new Date(entry.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="break-words border-l-2 border-amber-500/50 pl-1.5 text-xs leading-relaxed text-slate-200 print:border-slate-400 print:text-slate-800">
                          &ldquo;{entry.ideaText}&rdquo;
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default TreeBrainstormSummaryModal;
