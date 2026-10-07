'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  Plus,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import {
  autoBalanceClassGroups,
  createClass,
  deleteClass,
  deleteClassMember,
  listClassMembers,
  saveClassMembers,
  togglePracticePermission,
  updateMemberGroup,
} from '@/lib/classes';
import { parseStudentRosterFile } from '@/lib/excel';
import { downloadStudentCsvTemplate } from '@/lib/studentTemplate';
import type { ClassMemberInput, ClassMemberRow, ClassRow, GroupNumber } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CreateTreeSessionModal } from '@/components/tree/CreateTreeSessionModal';

/**
 * Phase 8.11 — the four group colours called for by the task, extended to the
 * full 1..8 range so every group in the picker is identifiable at a glance.
 *
 * A lookup (rather than a template literal) because Tailwind's build-time
 * scanner only emits classes it can see VERBATIM in the source: an interpolated
 * `bg-${colour}-100` produces no CSS at all.
 */
const GROUP_BADGE_CLASSES: Record<GroupNumber, string> = {
  1: 'bg-blue-100 text-blue-800 border-blue-300',
  2: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  3: 'bg-amber-100 text-amber-800 border-amber-300',
  4: 'bg-purple-100 text-purple-800 border-purple-300',
  5: 'bg-rose-100 text-rose-800 border-rose-300',
  6: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  7: 'bg-lime-100 text-lime-800 border-lime-300',
  8: 'bg-indigo-100 text-indigo-800 border-indigo-300',
};

/** Every group index the roster UI offers. */
const GROUP_OPTIONS: readonly GroupNumber[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** Narrows an arbitrary number to a valid group index, defaulting to 1. */
function toGroupNumber(value: number | null | undefined): GroupNumber {
  return value && value >= 1 && value <= 8 ? (value as GroupNumber) : 1;
}

interface ClassRosterManagerProps {
  initialClasses: ClassRow[];
}

/**
 * Two-pane class roster manager (Phase 6.2).
 *
 * The class list is server-fetched (`initialClasses`); a mutation triggers a
 * `router.refresh()` so the badge counts stay authoritative instead of being
 * patched optimistically in two places. Members are loaded on selection, not
 * with the class list, because a teacher normally opens one class at a time.
 */
export function ClassRosterManager({ initialClasses }: ClassRosterManagerProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<ClassMemberRow[] | null>(null);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  /** Class whose Tree of Knowledge session is being launched (Phase 7.3). */
  const [treeClass, setTreeClass] = useState<ClassRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  /**
   * Phase 8.9 — optimistic overrides for `classes.allow_practice`, keyed by id.
   *
   * The list itself stays server-authoritative (`initialClasses` + refresh), but
   * a permission flip must feel instant, so the switch renders from this map
   * until the refetched row arrives with the same value. A failed RPC deletes
   * its own entry, reverting the switch.
   */
  const [practiceOverrides, setPracticeOverrides] = useState<Record<string, boolean>>({});
  const [busyPracticeId, setBusyPracticeId] = useState<string | null>(null);
  /**
   * Phase 8.11 — optimistic overrides for `class_members.group_number`, keyed by
   * member id, plus the group the roster is filtered to.
   *
   * The override map exists because the inline `<select>` must move the instant
   * the teacher picks a value; the server is reconciled afterwards, and a failed
   * RPC deletes only its OWN entry so the other pending edits keep their
   * optimistic position.
   */
  const [groupOverrides, setGroupOverrides] = useState<Record<string, GroupNumber>>({});
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<number | 'all'>('all');
  const [isBalancing, setIsBalancing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = initialClasses.find((c) => c.id === selectedId) ?? null;

  const isPracticeAllowed = (klass: ClassRow) => practiceOverrides[klass.id] ?? klass.allow_practice;

  /** Phase 8.11 — a member's group, preferring a pending optimistic edit. */
  const groupOf = (member: ClassMemberRow) => groupOverrides[member.id] ?? toGroupNumber(member.group_number);

  /** Phase 8.11 — how many members fall in each group, for the filter pills. */
  const groupCounts = (members ?? []).reduce<Record<number, number>>((acc, member) => {
    const group = groupOf(member);
    acc[group] = (acc[group] ?? 0) + 1;
    return acc;
  }, {});

  /** Phase 8.11 — the roster rows visible under the active filter pill. */
  const visibleMembers = (members ?? []).filter(
    (member) => selectedGroupFilter === 'all' || groupOf(member) === selectedGroupFilter,
  );

  const handleChangeGroup = async (member: ClassMemberRow, next: GroupNumber) => {
    if (next === groupOf(member)) return;
    setError(null);
    setGroupOverrides((prev) => ({ ...prev, [member.id]: next }));
    setBusyGroupId(member.id);
    try {
      await updateMemberGroup(createClient(), member.id, next);
      // Drop the override once the server agrees, so the refetched row becomes
      // the source of truth again and the map does not grow unboundedly.
      setGroupOverrides((prev) => {
        const { [member.id]: _confirmed, ...rest } = prev;
        return rest;
      });
      if (selected) await reloadMembers(selected.id);
    } catch (err) {
      setGroupOverrides((prev) => {
        const { [member.id]: _reverted, ...rest } = prev;
        return rest;
      });
      setError(err instanceof PersistenceError ? err.message : 'Không đổi được tổ cho học sinh này.');
    } finally {
      setBusyGroupId(null);
    }
  };

  /**
   * Phase 8.11 — re-partitions the whole class.
   *
   * Confirmed for the RANDOM shuffle only: it destroys any manual arrangement, so
   * it is worth an explicit prompt. The deterministic name-order split is
   * reproducible and is applied directly.
   */
  const handleAutoBalance = async (randomize: boolean) => {
    if (!selected || isBalancing) return;
    if (randomize && !window.confirm(`Chia ngẫu nhiên ${selected.name} thành 4 tổ? Thao tác này thay đổi toàn bộ tổ hiện tại.`)) {
      return;
    }
    setError(null);
    setIsBalancing(true);
    try {
      await autoBalanceClassGroups(createClient(), selected.id, 4, randomize);
      // A full reshuffle invalidates every optimistic edit at once.
      setGroupOverrides({});
      await reloadMembers(selected.id);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không chia tổ được.');
    } finally {
      setIsBalancing(false);
    }
  };

  const handleTogglePractice = async (klass: ClassRow) => {
    const next = !isPracticeAllowed(klass);
    setError(null);
    setPracticeOverrides((prev) => ({ ...prev, [klass.id]: next }));
    setBusyPracticeId(klass.id);
    try {
      await togglePracticePermission(createClient(), klass.id, next);
      router.refresh();
    } catch (err) {
      setPracticeOverrides((prev) => {
        const { [klass.id]: _dropped, ...rest } = prev;
        return rest;
      });
      setError(err instanceof PersistenceError ? err.message : 'Không cập nhật được quyền tự luyện tập.');
    } finally {
      setBusyPracticeId(null);
    }
  };

  const selectClass = async (classId: string) => {
    setSelectedId(classId);
    setMembers(null);
    setError(null);
    // Phase 8.11 — a filter (and any pending group edit) belongs to one roster,
    // so both are reset; otherwise the next class could open pre-filtered to an
    // empty group.
    setSelectedGroupFilter('all');
    setGroupOverrides({});
    setIsLoadingMembers(true);
    try {
      setMembers(await listClassMembers(createClient(), classId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoadingMembers(false);
    }
  };

  const reloadMembers = async (classId: string) => {
    try {
      setMembers(await listClassMembers(createClient(), classId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeleteClass = async (klass: ClassRow) => {
    if (!window.confirm(`Xoá lớp "${klass.name}" và toàn bộ học sinh trong lớp?`)) return;
    setError(null);
    try {
      await deleteClass(createClient(), klass.id);
      if (selectedId === klass.id) {
        setSelectedId(null);
        setMembers(null);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không xóa được lớp.');
    }
  };

  const handleDeleteMember = async (member: ClassMemberRow) => {
    if (!selected) return;
    if (!window.confirm(`Xoá học sinh "${member.full_name}" khỏi lớp?`)) return;
    setError(null);
    setBusyMemberId(member.id);
    try {
      await deleteClassMember(createClient(), member.id);
      await reloadMembers(selected.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không xóa được học sinh.');
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleImportFile = async (file: File) => {
    if (!selected) return;
    setError(null);
    try {
      const parsed: ClassMemberInput[] = await parseStudentRosterFile(file, selected.name);
      const supabase = createClient();
      await saveClassMembers(supabase, selected.id, parsed);
      await reloadMembers(selected.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : (err as Error).message);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      {/* Class list */}
      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setIsCreateOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Plus size={15} />
          Tạo Lớp Mới
        </button>

        {initialClasses.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            Chưa có lớp nào. Tạo lớp để quản lý danh sách học sinh.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {initialClasses.map((klass) => {
              const practiceOn = isPracticeAllowed(klass);
              return (
                <li key={klass.id}>
                  <div
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-lg border px-3 py-2 transition',
                      selectedId === klass.id
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white hover:bg-slate-50',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void selectClass(klass.id)}
                      className="flex-1 text-left"
                    >
                      <span className="block text-sm font-semibold">{klass.name}</span>
                      <span
                        className={cn(
                          'block text-xs',
                          selectedId === klass.id ? 'text-slate-300' : 'text-slate-500',
                        )}
                      >
                        {klass.academic_year}
                      </span>
                    </button>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        selectedId === klass.id
                          ? 'bg-white/20 text-white'
                          : 'bg-slate-100 text-slate-600',
                      )}
                    >
                      <Users size={11} />
                      {klass.member_count ?? 0}
                    </span>
                    <span
                      title={practiceOn ? 'Học sinh được tự luyện tập' : 'Đã tắt tự luyện tập'}
                      className={cn(
                        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        practiceOn
                          ? selectedId === klass.id
                            ? 'bg-emerald-400/25 text-emerald-100'
                            : 'bg-emerald-50 text-emerald-700'
                          : selectedId === klass.id
                            ? 'bg-white/15 text-slate-200'
                            : 'bg-slate-100 text-slate-500',
                      )}
                    >
                      Tự luyện: {practiceOn ? 'Bật' : 'Tắt'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={practiceOn}
                      aria-label={`Cho phép ${klass.name} tự luyện tập`}
                      disabled={busyPracticeId === klass.id}
                      onClick={() => void handleTogglePractice(klass)}
                      className={cn(
                        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition disabled:opacity-50',
                        practiceOn ? 'bg-emerald-500' : 'bg-slate-300',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-3 w-3 transform rounded-full bg-white transition',
                          practiceOn ? 'translate-x-3.5' : 'translate-x-0.5',
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteClass(klass)}
                      title="Xoá lớp"
                      className={cn(
                        'shrink-0 rounded-md p-1 transition',
                        selectedId === klass.id
                          ? 'text-slate-300 hover:bg-white/10 hover:text-white'
                          : 'text-slate-400 hover:bg-rose-50 hover:text-rose-600',
                      )}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Roster */}
      <section className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
            <p className="text-sm text-rose-700">{error}</p>
          </div>
        )}

        {!selected ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
            Chọn một lớp để xem danh sách học sinh.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">{selected.name}</h2>
                <p className="text-xs text-slate-500">
                  {members?.length ?? selected.member_count ?? 0} học sinh — niên khoá{' '}
                  {selected.academic_year}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTreeClass(selected)}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
                >
                  🌱 Bắt đầu Cây Tri Thức
                </button>
                <button
                  type="button"
                  onClick={() => downloadStudentCsvTemplate(selected.name)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  📥 Tải file mẫu (.CSV)
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  📄 Nhập từ file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImportFile(file);
                    event.target.value = '';
                  }}
                />
              </div>
            </div>

            {/* Phase 8.11 — group toolbar. Rendered only when a roster is loaded,
                because every control here acts on members. */}
            {!isLoadingMembers && members && members.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <button
                  type="button"
                  onClick={() => void handleAutoBalance(true)}
                  disabled={isBalancing}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {isBalancing && <Loader2 size={13} className="animate-spin" />}
                  🎲 Chia ngẫu nhiên 4 tổ
                </button>
                <button
                  type="button"
                  onClick={() => void handleAutoBalance(false)}
                  disabled={isBalancing}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  📋 Chia theo thứ tự (1..4)
                </button>

                <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" />

                {/* Filter pills. Counts are derived from the same override map
                    the badges use, so a pending edit moves the number at once. */}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setSelectedGroupFilter('all')}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
                      selectedGroupFilter === 'all'
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    Tất cả ({members.length})
                  </button>
                  {GROUP_OPTIONS.slice(0, 4).map((group) => (
                    <button
                      key={group}
                      type="button"
                      onClick={() => setSelectedGroupFilter(group)}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
                        selectedGroupFilter === group
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : cn('hover:opacity-80', GROUP_BADGE_CLASSES[group]),
                      )}
                    >
                      Tổ {group} ({groupCounts[group] ?? 0})
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              {isLoadingMembers ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500">
                  <Loader2 size={16} className="animate-spin" />
                  Đang tải…
                </div>
              ) : !members || members.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  Lớp chưa có học sinh. Tải file mẫu, điền và nhập lại.
                </p>
              ) : visibleMembers.length === 0 ? (
                <p className="p-8 text-center text-sm text-slate-500">
                  Không có học sinh nào trong tổ này.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5 font-semibold">STT</th>
                        <th className="px-3 py-2.5 font-semibold">Mã học sinh</th>
                        <th className="px-3 py-2.5 font-semibold">Họ và tên</th>
                        <th className="px-3 py-2.5 font-semibold">Ngày sinh</th>
                        <th className="px-3 py-2.5 font-semibold">Mã PIN</th>
                        <th className="px-3 py-2.5 font-semibold">Tổ / Nhóm</th>
                        <th className="px-3 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleMembers.map((member, index) => {
                        const group = groupOf(member);
                        return (
                        <tr key={member.id} className="transition hover:bg-slate-50">
                          <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                          <td className="px-3 py-2 font-mono text-xs">{member.student_code}</td>
                          <td className="px-3 py-2 font-medium text-slate-800">
                            {member.full_name}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{member.dob ?? '—'}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {member.pin ?? <span className="text-slate-400">DDMM</span>}
                          </td>
                          <td className="px-3 py-2">
                            {/* The badge shows the group as a colour swatch; the
                                select on top of it is what the teacher actually
                                clicks, so the two never disagree. */}
                            <div className="relative inline-flex items-center">
                              <span
                                className={cn(
                                  'pointer-events-none inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold',
                                  GROUP_BADGE_CLASSES[group],
                                )}
                              >
                                Tổ {group}
                                <ChevronDown size={11} />
                              </span>
                              <select
                                value={group}
                                onChange={(event) =>
                                  void handleChangeGroup(
                                    member,
                                    Number(event.target.value) as GroupNumber,
                                  )
                                }
                                disabled={busyGroupId === member.id}
                                aria-label={`Tổ của ${member.full_name}`}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
                              >
                                {GROUP_OPTIONS.map((option) => (
                                  <option key={option} value={option}>
                                    Tổ {option}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => void handleDeleteMember(member)}
                              disabled={busyMemberId === member.id}
                              className="rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                            >
                              {busyMemberId === member.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {isCreateOpen && (
        <CreateClassModal
          onClose={() => setIsCreateOpen(false)}
          onCreated={(created) => {
            setIsCreateOpen(false);
            router.refresh();
            void selectClass(created.id);
          }}
        />
      )}

      {treeClass && (
        <CreateTreeSessionModal klass={treeClass} onClose={() => setTreeClass(null)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create-class modal                                                         */
/* -------------------------------------------------------------------------- */

function CreateClassModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: ClassRow) => void;
}) {
  const [name, setName] = useState('');
  const [academicYear, setAcademicYear] = useState('2026-2027');
  const [allowPractice, setAllowPractice] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const created = await createClass(createClient(), name, academicYear, allowPractice);
      onCreated(created);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không tạo được lớp.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <h2 className="text-base font-semibold text-slate-900">Tạo lớp mới</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Tên lớp</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="VD: 12A1"
              autoFocus
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Niên khoá</span>
            <input
              value={academicYear}
              onChange={(event) => setAcademicYear(event.target.value)}
              placeholder="VD: 2025-2026"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <input
              type="checkbox"
              checked={allowPractice}
              onChange={(event) => setAllowPractice(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-slate-900"
            />
            <span className="text-sm text-slate-700">
              Cho phép học sinh lớp này tự luyện tập bằng file DOCX
            </span>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="text-sm text-rose-700">{error}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving || !name.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {isSaving && <Loader2 size={15} className="animate-spin" />}
            {isSaving ? 'Đang tạo…' : 'Tạo lớp'}
          </button>
        </div>
      </div>
    </div>
  );
}
