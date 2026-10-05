'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { listClasses } from '@/lib/classes';
import type { ClassRow } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ClassPickerModalProps {
  /** Called with the checked class ids when the teacher confirms. */
  onConfirm: (classIds: string[]) => void;
  onClose: () => void;
  /** Disables the confirm button while the caller is running the import. */
  isBusy?: boolean;
  title?: string;
}

/**
 * Class picker modal (Phase 6.2).
 *
 * Shared by the exam creation flow (selecting classes to import after the exam
 * is saved) and the exam settings editor (importing into an existing exam). It
 * only *selects* — the caller owns when the `import_class_to_exam` RPC runs,
 * because the RPC needs an exam code that does not exist yet during creation.
 */
export function ClassPickerModal({
  onConfirm,
  onClose,
  isBusy = false,
  title = 'Nạp danh sách từ Lớp học',
}: ClassPickerModalProps) {
  const [classes, setClasses] = useState<ClassRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listClasses(createClient());
        if (!cancelled) setClasses(rows);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (classId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  };

  const totalStudents = (classes ?? [])
    .filter((klass) => selected.has(klass.id))
    .reduce((sum, klass) => sum + (klass.member_count ?? 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div className="flex items-center gap-2">
            <BookOpen size={18} className="text-slate-500" />
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="text-sm text-rose-700">{error}</p>
            </div>
          )}

          {classes === null && !error ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              Đang tải danh sách lớp…
            </div>
          ) : classes && classes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              Bạn chưa có lớp nào. Tạo lớp ở mục “Lớp học” trước.
            </p>
          ) : (
            (classes ?? []).map((klass) => (
              <label
                key={klass.id}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition',
                  selected.has(klass.id)
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(klass.id)}
                    onChange={() => toggle(klass.id)}
                    className="h-4 w-4"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800">
                      {klass.name}
                    </span>
                    <span className="block text-xs text-slate-500">{klass.academic_year}</span>
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {klass.member_count ?? 0} HS
                </span>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 p-4">
          <p className="text-xs text-slate-500">
            Đã chọn {selected.size} lớp
            {selected.size > 0 ? ` — ${totalStudents} học sinh` : ''}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Huỷ
            </button>
            <button
              type="button"
              onClick={() => onConfirm([...selected])}
              disabled={isBusy || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {isBusy && <Loader2 size={15} className="animate-spin" />}
              {isBusy ? 'Đang nạp…' : 'Nạp danh sách'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
