'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError, purgeExamNow, restoreExam } from '@/lib/exams';
import type { ExamRow } from '@/lib/types';
import { daysUntil } from '@/lib/date';
import { cn } from '@/lib/utils';

interface TrashListProps {
  exams: ExamRow[];
}

/**
 * Trash view (Phase 5.5 §3.2).
 *
 * Every row is already soft-deleted, so "Xóa vĩnh viễn" is a plain DELETE gated
 * by the owner RLS policy rather than the delete_exam RPC — there is no tier
 * decision left to make. Restore clears the marker but deliberately leaves the
 * exam closed, so the row is labelled as needing a manual re-open.
 */
export function TrashList({ exams }: TrashListProps) {
  const router = useRouter();
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (code: string, action: () => Promise<unknown>) => {
    setBusyCode(code);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(
        err instanceof PersistenceError ? err.message : 'Thao tác thất bại. Vui lòng thử lại.',
      );
    } finally {
      setBusyCode(null);
    }
  };

  const handleRestore = (code: string) =>
    run(code, async () => restoreExam(createClient(), code));

  const handlePurge = (code: string) => {
    if (
      !window.confirm(
        'Xóa vĩnh viễn đề thi này cùng toàn bộ kết quả và câu hỏi? Thao tác không thể hoàn tác.',
      )
    ) {
      return;
    }
    return run(code, async () => purgeExamNow(createClient(), code));
  };

  if (exams.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <Trash2 size={32} className="text-slate-300" />
        <p className="font-semibold text-slate-700">Thùng rác trống</p>
        <p className="text-sm text-slate-500">
          Các đề thi đã xóa sẽ được giữ ở đây 7 ngày trước khi xóa vĩnh viễn.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Mã đề</th>
                <th className="px-3 py-2.5 font-semibold">Tên đề thi</th>
                <th className="px-3 py-2.5 font-semibold">Ngày xóa</th>
                <th className="px-3 py-2.5 font-semibold">Thời gian còn lại</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {exams.map((exam) => {
                const remaining = daysUntil(exam.deleted_at);
                return (
                  <tr key={exam.id} className="transition hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold">{exam.code}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{exam.title}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">
                      {exam.deleted_at
                        ? new Date(exam.deleted_at).toLocaleString('vi-VN')
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          remaining <= 2
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-amber-100 text-amber-700',
                        )}
                      >
                        {remaining > 0 ? `Còn ${remaining} ngày` : 'Sắp bị xóa'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => handleRestore(exam.code)}
                          disabled={busyCode === exam.code}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 underline-offset-2 transition hover:text-emerald-800 hover:underline disabled:opacity-40"
                        >
                          {busyCode === exam.code ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RotateCcw size={12} />
                          )}
                          Khôi phục
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePurge(exam.code)}
                          disabled={busyCode === exam.code}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 underline-offset-2 transition hover:text-rose-700 hover:underline disabled:opacity-40"
                        >
                          <Trash2 size={12} />
                          Xóa vĩnh viễn
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Đề thi được khôi phục sẽ ở trạng thái <strong>đã đóng</strong> — hãy mở lại khi cần cho học
        sinh thi.
      </p>
    </div>
  );
}
