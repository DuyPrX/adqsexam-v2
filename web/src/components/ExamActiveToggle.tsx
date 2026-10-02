'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError, setExamActive } from '@/lib/exams';
import { cn } from '@/lib/utils';

interface ExamActiveToggleProps {
  examCode: string;
  initialActive: boolean;
  /** Notifies the parent of the confirmed value (after an optimistic flip). */
  onChange?: (isActive: boolean) => void;
  className?: string;
}

/**
 * Quick open/close switch for one exam (Phase 5.4 §4).
 *
 * Optimistic: the switch flips immediately and rolls back only if the write
 * fails, so a teacher closing a live exam gets instant feedback instead of
 * waiting for a Supabase round-trip.
 */
export function ExamActiveToggle({
  examCode,
  initialActive,
  onChange,
  className,
}: ExamActiveToggleProps) {
  const [isActive, setIsActive] = useState(initialActive);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (isPending) return;
    const next = !isActive;

    setIsActive(next); // optimistic
    setIsPending(true);
    setError(null);
    try {
      const supabase = createClient();
      const confirmed = await setExamActive(supabase, examCode, next);
      setIsActive(confirmed);
      onChange?.(confirmed);
    } catch (err) {
      setIsActive(!next); // roll back
      setError(err instanceof PersistenceError ? err.message : 'Không đổi được trạng thái.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={isActive}
        aria-label={isActive ? 'Đóng đề thi' : 'Mở đề thi'}
        onClick={toggle}
        disabled={isPending}
        title={isActive ? 'Đang mở — bấm để đóng' : 'Đang đóng — bấm để mở'}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50',
          isActive ? 'bg-emerald-500' : 'bg-slate-300',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition',
            isActive ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <span
        className={cn(
          'text-[11px] font-semibold',
          isActive ? 'text-emerald-700' : 'text-slate-500',
        )}
      >
        {isActive ? 'Đang mở' : 'Đã đóng'}
      </span>
      {error && <span className="text-[11px] font-semibold text-rose-600">{error}</span>}
    </div>
  );
}
