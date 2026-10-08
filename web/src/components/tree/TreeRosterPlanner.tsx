'use client';

import { useMemo, useState } from 'react';
import { Loader2, Shuffle, UserMinus, UserCheck } from 'lucide-react';
import { balanceTeamAssignments } from '@/lib/tree';
import type { ClassMemberRow, ParticipantConfig, TeamNumber } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The four Cây columns, in display order. */
const TEAMS: TeamNumber[] = [1, 2, 3, 4];

/** Colour per Tổ, matching the arena's own team badges. */
const TEAM_ACCENT: Record<TeamNumber, string> = {
  1: 'border-blue-300 bg-blue-50 text-blue-800',
  2: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  3: 'border-amber-300 bg-amber-50 text-amber-800',
  4: 'border-purple-300 bg-purple-50 text-purple-800',
};

// Phase 9.2 — `buildInitialAssignments` (natural-team seeding) and
// `balanceTeamAssignments` (the explicit round-robin) are pure and live in
// `@/lib/tree` so the modal can seed the config before the planner mounts and
// the e2e suite can exercise both headless (a `.tsx` cannot be imported under
// plain Node). Re-exported here for discoverability alongside the planner UI.
export { buildInitialAssignments } from '@/lib/tree';

interface TreeRosterPlannerProps {
  members: ClassMemberRow[];
  isLoading: boolean;
  config: ParticipantConfig;
  onChange: (next: ParticipantConfig) => void;
}

/**
 * Phase 9.1 — the pre-flight roster manager shown while creating a tree session.
 *
 * Emits a `ParticipantConfig` and nothing else: it holds no persistence of its own
 * and never writes to `class_members`. A session-scoped assignment is deliberately
 * a copy rather than an edit of the roster's `team_number`, so a teacher can
 * re-balance one bout without disturbing the class's standing team split (and
 * without touching the Phase 8.4 arena's own source of truth).
 *
 * Phase 9.2 — the columns are seeded from each member's NATURAL team
 * (`buildInitialAssignments`), not from a modulo-4 split, so opening the modal
 * shows the class's own standing layout. Distribution happens only when the
 * teacher presses "⚖️ Chia đều 4 cây" (`balanceTeamAssignments`), which
 * round-robins the PRESENT members so the four columns end up within one of each
 * other regardless of absentee count.
 */
export function TreeRosterPlanner({
  members,
  isLoading,
  config,
  onChange,
}: TreeRosterPlannerProps) {
  const [error, setError] = useState<string | null>(null);

  const absentSet = useMemo(() => new Set(config.absent_ids), [config.absent_ids]);

  /**
   * A member's effective team: the override if set, else their natural team.
   *
   * Phase 9.2 — the fallback mirrors `buildInitialAssignments` exactly
   * (`team_number` → `((group_number - 1) % 4) + 1` → 1) so a member whose
   * assignment is not in `config.assignments` still lands in the column the
   * seeded config would have put them in.
   */
  const teamOf = (member: ClassMemberRow): TeamNumber => {
    const assigned = Number(config.assignments[member.id]);
    if (assigned >= 1 && assigned <= 4) return assigned as TeamNumber;
    const roster = Number(member.team_number);
    if (Number.isFinite(roster) && roster >= 1 && roster <= 4) return Math.trunc(roster) as TeamNumber;
    const group = Number(member.group_number);
    if (Number.isFinite(group) && group >= 1) return (((Math.trunc(group) - 1) % 4) + 1) as TeamNumber;
    return 1;
  };

  const present = members.filter((member) => !absentSet.has(member.id));

  const toggleAbsent = (member: ClassMemberRow) => {
    setError(null);
    const nextAbsent = new Set(config.absent_ids);
    if (nextAbsent.has(member.id)) {
      nextAbsent.delete(member.id);
    } else {
      nextAbsent.add(member.id);
    }
    onChange({ ...config, absent_ids: [...nextAbsent] });
  };

  const markAllPresent = () => {
    setError(null);
    onChange({ ...config, absent_ids: [] });
  };

  /**
   * Evenly splits the PRESENT members across the four Cây.
   *
   * Phase 9.2 — delegates to the pure `balanceTeamAssignments` so the exact same
   * round-robin the e2e suite asserts against is the one the button runs. Only
   * an explicit click reaches here; merely opening the modal never re-balances.
   */
  const balanceTeams = () => {
    setError(null);
    if (present.length === 0) {
      setError('Không còn học sinh nào để chia tổ (tất cả đang được đánh dấu vắng).');
      return;
    }
    onChange({
      ...config,
      assignments: balanceTeamAssignments(members, config.absent_ids, config.assignments),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-sm text-slate-500">
        <Loader2 size={15} className="animate-spin" />
        Đang tải danh sách học sinh…
      </div>
    );
  }

  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
        Lớp này chưa có học sinh. Hãy nhập danh sách lớp trước khi tổ chức đấu trường.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-700">
          Xếp tổ trước giờ đấu
          <span className="ml-2 font-normal text-slate-500">
            {present.length}/{members.length} có mặt
          </span>
        </span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={balanceTeams}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            <Shuffle size={12} />
            ⚖️ Chia đều 4 cây
          </button>
          <button
            type="button"
            onClick={markAllPresent}
            disabled={config.absent_ids.length === 0}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <UserCheck size={12} />
            Tất cả có mặt
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {TEAMS.map((team) => {
          const rows = present.filter((member) => teamOf(member) === team);
          return (
            <div key={team} className="rounded-lg border border-slate-200 bg-white p-2">
              <div
                className={cn(
                  'mb-1.5 flex items-center justify-between rounded-md border px-2 py-0.5 text-xs font-bold',
                  TEAM_ACCENT[team],
                )}
              >
                <span>Cây {team}</span>
                <span>{rows.length}</span>
              </div>
              <ul className="space-y-1">
                {rows.length === 0 && (
                  <li className="px-1 py-0.5 text-[11px] italic text-slate-400">Trống</li>
                )}
                {rows.map((member) => (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => toggleAbsent(member)}
                      title="Đánh dấu vắng mặt"
                      className="flex w-full items-center justify-between gap-1 rounded px-1 py-0.5 text-left text-[11px] text-slate-700 transition hover:bg-rose-50"
                    >
                      <span className="truncate">{member.full_name}</span>
                      <UserMinus size={11} className="shrink-0 text-slate-300 hover:text-rose-600" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {/* Absent column */}
        <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-2">
          <div className="mb-1.5 flex items-center justify-between rounded-md border border-rose-300 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800">
            <span>Vắng mặt 🚫</span>
            <span>{config.absent_ids.length}</span>
          </div>
          <ul className="space-y-1">
            {config.absent_ids.length === 0 && (
              <li className="px-1 py-0.5 text-[11px] italic text-rose-300">Không có</li>
            )}
            {members
              .filter((member) => absentSet.has(member.id))
              .map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => toggleAbsent(member)}
                    title="Cho phép tham gia lại"
                    className="flex w-full items-center justify-between gap-1 rounded px-1 py-0.5 text-left text-[11px] text-rose-700 line-through transition hover:bg-white"
                  >
                    <span className="truncate">{member.full_name}</span>
                    <UserCheck size={11} className="shrink-0 text-rose-300 hover:text-emerald-600" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Bấm vào tên để chuyển sang <strong>vắng mặt</strong> — học sinh vắng sẽ ở chế độ quan sát và
        không tính vào chỉ tiêu của tổ.
      </p>

      {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
    </div>
  );
}
