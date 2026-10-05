'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Loader2,
  Plus,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import {
  createClass,
  deleteClass,
  deleteClassMember,
  listClassMembers,
  saveClassMembers,
} from '@/lib/classes';
import { parseStudentRosterFile } from '@/lib/excel';
import { downloadStudentCsvTemplate } from '@/lib/studentTemplate';
import type { ClassMemberInput, ClassMemberRow, ClassRow } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CreateTreeSessionModal } from '@/components/tree/CreateTreeSessionModal';

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = initialClasses.find((c) => c.id === selectedId) ?? null;

  const selectClass = async (classId: string) => {
    setSelectedId(classId);
    setMembers(null);
    setError(null);
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
            {initialClasses.map((klass) => (
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
            ))}
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
                        <th className="px-3 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {members.map((member, index) => (
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
                      ))}
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
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const created = await createClass(createClient(), name, academicYear);
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
