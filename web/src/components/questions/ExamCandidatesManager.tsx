'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Pencil, Plus, Search, Trash2, UserCheck, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import {
  addExamCandidate,
  deleteExamCandidate,
  listExamCandidates,
  updateExamCandidate,
  type CandidateUpdate,
} from '@/lib/candidates';
import type { ExamCandidateRow } from '@/lib/types';

interface ExamCandidatesManagerProps {
  examCode: string;
}

/**
 * "Danh sách thí sinh dự thi" tab (Phase 8.1).
 *
 * The roster is loaded client-side rather than passed from the server page so a
 * mutation can refresh just this table — the exam's questions and metadata are
 * untouched by candidate edits, and a `router.refresh()` would re-fetch them too.
 *
 * Editing happens in a modal (not inline) because a candidate has four editable
 * fields; an inline row editor would either be too cramped on the table or
 * reflow the columns while typing.
 */
export function ExamCandidatesManager({ examCode }: ExamCandidatesManagerProps) {
  const [candidates, setCandidates] = useState<ExamCandidateRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** `null` = closed; `'new'` = add modal; otherwise the row being edited. */
  const [editing, setEditing] = useState<'new' | ExamCandidateRow | null>(null);

  const reload = async () => {
    try {
      setCandidates(await listExamCandidates(createClient(), examCode));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void reload();
    // `examCode` is the only real input; reload is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examCode]);

  // Case- and diacritic-sensitive substring match on name OR class. A plain
  // `toLowerCase()` includes is enough here — the roster is small and Vietnamese
  // users type the name as shown, so a locale-aware fold would add complexity
  // without changing the practical result.
  const filtered = useMemo(() => {
    const rows = candidates ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.full_name.toLowerCase().includes(needle)
        || row.class_name.toLowerCase().includes(needle)
        || row.student_code.toLowerCase().includes(needle),
    );
  }, [candidates, search]);

  const handleDelete = async (row: ExamCandidateRow) => {
    if (!window.confirm(`Xóa "${row.full_name}" khỏi danh sách dự thi?`)) return;
    setBusyId(row.id);
    setError(null);
    try {
      await deleteExamCandidate(createClient(), row.id);
      await reload();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không xóa được học sinh.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <UserCheck size={15} />
          Danh sách thí sinh dự thi
          {candidates !== null && (
            <span className="font-mono text-slate-400">({candidates.length})</span>
          )}
        </h2>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tìm theo tên, lớp, mã…"
              className="w-52 rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus size={15} />
            Thêm học sinh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      {candidates === null ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 size={15} className="animate-spin" />
          Đang tải danh sách…
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          {candidates.length === 0
            ? 'Đề thi chưa có thí sinh nào. Nạp từ Lớp học hoặc thêm thủ công.'
            : 'Không tìm thấy thí sinh nào khớp với từ khóa.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Mã học sinh</th>
                <th className="px-3 py-2 font-semibold">Họ và tên</th>
                <th className="px-3 py-2 font-semibold">Lớp</th>
                <th className="px-3 py-2 font-semibold">Ngày sinh</th>
                <th className="px-3 py-2 font-semibold">PIN</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((row) => (
                <tr key={row.id} className="transition hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{row.student_code}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">{row.full_name}</td>
                  <td className="px-3 py-2 text-slate-600">{row.class_name}</td>
                  <td className="px-3 py-2 text-slate-600">{row.dob ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{row.pin ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        className="rounded-md p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                        aria-label={`Sửa ${row.full_name}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(row)}
                        disabled={busyId === row.id}
                        className="rounded-md p-1.5 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                        aria-label={`Xóa ${row.full_name}`}
                      >
                        {busyId === row.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && (
        <CandidateFormModal
          examCode={examCode}
          candidate={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

interface CandidateFormModalProps {
  examCode: string;
  /** Null when adding. */
  candidate: ExamCandidateRow | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/** Add/edit modal for one candidate. */
function CandidateFormModal({ examCode, candidate, onClose, onSaved }: CandidateFormModalProps) {
  const isEdit = candidate !== null;
  const [fullName, setFullName] = useState(candidate?.full_name ?? '');
  const [className, setClassName] = useState(candidate?.class_name ?? '');
  const [dob, setDob] = useState(candidate?.dob ?? '');
  const [pin, setPin] = useState(candidate?.pin ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const supabase = createClient();
      // An empty DOB/PIN input means "clear it", not "leave unchanged" — the
      // teacher erased the value, so sending null is the honest interpretation.
      const nextDob = dob.trim() === '' ? null : dob.trim();
      const nextPin = pin.trim() === '' ? null : pin.trim();

      if (isEdit) {
        const updates: CandidateUpdate = {
          full_name: fullName,
          class_name: className,
          dob: nextDob,
          pin: nextPin,
        };
        await updateExamCandidate(supabase, candidate.id, updates);
      } else {
        await addExamCandidate(supabase, examCode, {
          full_name: fullName,
          class_name: className,
          dob: nextDob,
          pin: nextPin,
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không lưu được thí sinh.');
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {isEdit ? 'Sửa thí sinh' : 'Thêm thí sinh'}
            </h2>
            {isEdit && (
              <p className="font-mono text-xs text-slate-500">{candidate.student_code}</p>
            )}
          </div>
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
            <span className="text-sm font-semibold text-slate-700">Họ và tên</span>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoFocus
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Lớp</span>
            <input
              value={className}
              onChange={(event) => setClassName(event.target.value)}
              placeholder="VD: 12A1"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Ngày sinh</span>
              <input
                type="date"
                value={dob}
                onChange={(event) => setDob(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Mã PIN</span>
              <input
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder="Để trống = dùng DDMM"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            Để trống cả Ngày sinh và PIN nghĩa là học sinh không cần mã bảo vệ.
            Mã học sinh được tạo tự động nếu bỏ trống khi thêm mới.
          </p>

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
            onClick={() => void handleSubmit()}
            disabled={isSaving || !fullName.trim() || !className.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {isSaving && <Loader2 size={15} className="animate-spin" />}
            {isSaving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Thêm thí sinh'}
          </button>
        </div>
      </div>
    </div>
  );
}
