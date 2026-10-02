'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError, deleteExam } from '@/lib/exams';

interface DeleteExamDialogProps {
  examCode: string;
  examTitle: string;
  /** Submission count decides the tier, so the dialog can state it up front. */
  submissionCount: number;
  /** Called after a successful delete so the caller can refresh the lists. */
  onDeleted: () => void;
}

/**
 * Delete confirmation for one exam (Phase 5.5 §3).
 *
 * The destructive outcome depends on whether the exam has submissions, which the
 * teacher cannot be expected to remember — so the dialog spells out which tier
 * will apply BEFORE the confirm button is pressed. The RPC re-derives the tier
 * server-side regardless.
 */
export function DeleteExamDialog({
  examCode,
  examTitle,
  submissionCount,
  onDeleted,
}: DeleteExamDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const willBeHardDeleted = submissionCount === 0;

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      const supabase = createClient();
      await deleteExam(supabase, examCode);
      setIsOpen(false);
      onDeleted();
    } catch (err) {
      setError(
        err instanceof PersistenceError ? err.message : 'Không xóa được đề thi. Vui lòng thử lại.',
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="Xóa đề thi"
        className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 underline-offset-2 transition hover:text-rose-700 hover:underline"
      >
        <Trash2 size={12} />
        Xóa
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Xác nhận xóa đề thi"
        >
          <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-500" />
              <div>
                <h2 className="font-bold text-slate-900">Xóa đề thi?</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Đề thi: <span className="font-medium text-slate-800">{examTitle}</span>{' '}
                  <span className="font-mono text-xs">({examCode})</span>
                </p>
              </div>
            </div>

            <div
              className={
                willBeHardDeleted
                  ? 'rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800'
                  : 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
              }
            >
              {willBeHardDeleted ? (
                <>
                  Đề thi <strong>chưa có bài nộp</strong> nào. Thao tác này sẽ{' '}
                  <strong>xóa vĩnh viễn</strong> đề thi, toàn bộ câu hỏi và danh sách thí sinh.
                  Không thể hoàn tác.
                </>
              ) : (
                <>
                  Đề thi đã có <strong>{submissionCount} bài nộp</strong>. Đề thi sẽ được chuyển vào{' '}
                  <strong>thùng rác</strong> và tự động xóa vĩnh viễn sau <strong>7 ngày</strong>.
                  Bạn có thể khôi phục trong thời gian này.
                </>
              )}
            </div>

            {error && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                disabled={isDeleting}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
              >
                {isDeleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                {isDeleting ? 'Đang xóa…' : willBeHardDeleted ? 'Xóa vĩnh viễn' : 'Chuyển vào thùng rác'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
