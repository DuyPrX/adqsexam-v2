'use client';

import { useEffect, useRef, useState } from 'react';
import type { TreeSubmissionRow } from '@/lib/types';

export type PodiumRank = 1 | 2 | 3 | null;

export interface TeamRankInput {
  teamNumber: number; // 1 | 2 | 3 | 4
  totalMembers: number;
  submissions: TreeSubmissionRow[];
}

/**
 * Tính toán thứ hạng Nhất (1) - Nhì (2) - Ba (3) cho các Tổ đã hoàn thành 100% sĩ số.
 * Tổ nào có thời điểm bài nộp cuối cùng (`submitted_at` thứ N) sớm hơn sẽ xếp hạng cao hơn.
 */
export function computeTeamPodiumRanks(teams: TeamRankInput[]): Record<number, PodiumRank> {
  const completedTeams: { teamNumber: number; finishTimeMs: number }[] = [];

  for (const t of teams) {
    const targetCount = Math.max(1, t.totalMembers);
    if (t.submissions.length >= targetCount) {
      // Sắp xếp bài nộp theo thời gian tăng dần để lấy đúng thời điểm học sinh thứ N hoàn thành
      const sorted = [...t.submissions].sort((a, b) => {
        const ta = Date.parse(String(a.submitted_at ?? '')) || 0;
        const tb = Date.parse(String(b.submitted_at ?? '')) || 0;
        return ta - tb;
      });
      const nthSubmission = sorted[targetCount - 1] || sorted[sorted.length - 1];
      const finishTimeMs = Date.parse(String(nthSubmission?.submitted_at ?? '')) || Number.MAX_SAFE_INTEGER;
      completedTeams.push({ teamNumber: t.teamNumber, finishTimeMs });
    }
  }

  // Sắp xếp các tổ đã về đích theo thời gian hoàn thành sớm nhất
  completedTeams.sort((a, b) => a.finishTimeMs - b.finishTimeMs || a.teamNumber - b.teamNumber);

  const result: Record<number, PodiumRank> = { 1: null, 2: null, 3: null, 4: null };
  completedTeams.forEach((item, index) => {
    if (index === 0) result[item.teamNumber] = 1;
    else if (index === 1) result[item.teamNumber] = 2;
    else if (index === 2) result[item.teamNumber] = 3;
  });

  return result;
}

/**
 * Class Tailwind cho khung viền Card của từng Tổ theo thứ hạng:
 * - Hạng 1: Khung Vàng Kim rực rỡ có hào quang
 * - Hạng 2: Khung Bạc Ánh Kim thanh lịch
 * - Hạng 3: Khung Đồng Cổ Điển ấm áp
 */
export function getRankCardClasses(rank: PodiumRank): string {
  if (rank === 1) {
    return 'border-2 border-amber-400 shadow-[0_0_30px_rgba(251,191,36,0.28)] ring-1 ring-amber-300/40';
  }
  if (rank === 2) {
    return 'border-[1.5px] border-slate-300/80 shadow-[0_0_18px_rgba(203,213,225,0.16)]';
  }
  if (rank === 3) {
    return 'border-[1.5px] border-amber-700/85 shadow-[0_0_14px_rgba(217,119,6,0.14)]';
  }
  return 'border border-white/10';
}

/**
 * Huy hiệu nhỏ hiển thị vĩnh viễn trên thanh Header của mỗi Tổ sau khi về đích.
 */
export function TeamRankHeaderBadge({ rank }: { rank: PodiumRank }) {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 border border-amber-400/50 px-2.5 py-0.5 text-xs font-extrabold text-amber-300 shadow-sm">
        🏆 Quán quân
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-300/15 border border-slate-300/40 px-2.5 py-0.5 text-xs font-bold text-slate-200">
        🥈 Á quân
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-700/20 border border-amber-600/40 px-2.5 py-0.5 text-xs font-bold text-amber-400/90">
        🥉 Hạng ba
      </span>
    );
  }
  return null;
}

/**
 * Banner nổi xuất hiện đúng 3 giây (3000ms) ngay khi một Tổ vừa chạm mốc về đích,
 * sau đó tự động ẩn đi để không che khuất ngọn cây.
 */
export function TeamFinishToastBanner({
  teamNumber,
  rank,
  durationMs = 3000,
}: {
  teamNumber: number;
  rank: PodiumRank;
  durationMs?: number;
}) {
  const [visible, setVisible] = useState(false);
  const announcedRankRef = useRef<PodiumRank>(null);

  useEffect(() => {
    // Chỉ kích hoạt banner 3s đúng 1 lần khi Tổ này nhận được thứ hạng mới (1, 2, hoặc 3)
    if (rank !== null && announcedRankRef.current !== rank) {
      announcedRankRef.current = rank;
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
      }, durationMs);
      return () => clearTimeout(timer);
    }
    if (rank === null) {
      announcedRankRef.current = null;
      setVisible(false);
    }
  }, [rank, durationMs]);

  if (!visible || rank === null) return null;

  const config = {
    1: {
      text: `🏆 QUÁN QUÂN: TỔ ${teamNumber} VỀ ĐÍCH ĐẦU TIÊN! 🌸`,
      cls: 'bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 text-amber-950 border-amber-200 shadow-[0_8px_28px_rgba(251,191,36,0.45)] scale-105',
    },
    2: {
      text: `🥈 Á QUÂN: TỔ ${teamNumber} VỀ ĐÍCH THỨ HAI! ✨`,
      cls: 'bg-gradient-to-r from-slate-200 via-white to-slate-300 text-slate-900 border-slate-100 shadow-[0_6px_20px_rgba(203,213,225,0.3)]',
    },
    3: {
      text: `🥉 HẠNG BA: TỔ ${teamNumber} HOÀN THÀNH XUẤT SẮC! 🌱`,
      cls: 'bg-gradient-to-r from-amber-700 via-amber-600 to-amber-800 text-amber-50 border-amber-500/50 shadow-[0_6px_18px_rgba(180,83,9,0.3)]',
    },
  }[rank];

  return (
    <div
      className={`pointer-events-none absolute top-14 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border px-4 py-1.5 text-xs font-extrabold tracking-wide transition-all duration-300 animate-bounce ${config.cls}`}
    >
      {config.text}
    </div>
  );
}