'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError, recalculateExamScores } from '@/lib/exams';

interface RegradeButtonProps {
  examCode: string;
  /** Re-grading with nothing to grade is pointless, so the button stays disabled. */
  submissionCount: number;
}

/**
 * "Chấm lại toàn bộ bài nộp" (Phase 5.5 §3.4).
 *
 * Re-grading matters because answer keys can be edited after submissions exist
 * (update_exam_questions_safe allows content edits). After a successful run the
 * router is refreshed so the dashboard picks up the new scores, and the count of
 * rewritten results is shown to the teacher.
 */
export function RegradeButton({ examCode, submissionCount }: RegradeButtonProps) {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRegrade = async () => {
    setIsRunning(true);
    setResult(null);
    setError(null);
    try {
      const supabase = createClient();
      const { updatedCount, message } = await recalculateExamScores(supabase, examCode);
      setResult(`${message} (${updatedCount} bài)`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof PersistenceError ? err.message : 'Không chấm lại được. Vui lòng thử lại.',
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleRegrade}
        disabled={isRunning || submissionCount === 0}
        title={
          submissionCount === 0 ? 'Chưa có bài nộp nào để chấm lại.' : 'Chấm lại theo đáp án mới nhất'
        }
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isRunning ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        {isRunning ? 'Đang chấm lại…' : 'Chấm lại toàn bộ bài nộp'}
      </button>

      {result && (
        <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
          <CheckCircle2 size={13} />
          {result}
        </span>
      )}
      {error && <span className="text-xs font-semibold text-rose-600">{error}</span>}
    </div>
  );
}
