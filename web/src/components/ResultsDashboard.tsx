'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2, RefreshCw, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { exportResultsWorkbook } from '@/lib/excel';
import { PersistenceError } from '@/lib/exams';
import type { ExamResultRow, ExamRow, QuestionBankRow } from '@/lib/types';
import { RosterUploadModal } from './RosterUploadModal';

interface ResultsDashboardProps {
  exam: ExamRow;
  initialResults: ExamResultRow[];
  questions: QuestionBankRow[];
}

function percentage(score: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((score / total) * 1000) / 10;
}

/**
 * ResultsDashboard — live submission board for one exam.
 *
 * Reads are RLS-scoped to the owning teacher (Phase 1 §B), and the 3-sheet
 * workbook is generated client-side by excel.ts (D4).
 */
export function ResultsDashboard({
  exam,
  initialResults,
  questions,
}: ResultsDashboardProps) {
  const [results, setResults] = useState<ExamResultRow[]>(initialResults);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: queryError } = await supabase
        .from('exam_results')
        .select('*')
        .eq('exam_code', exam.code)
        .order('submitted_at', { ascending: false });

      if (queryError) throw new PersistenceError(queryError.message);
      setResults((data ?? []) as ExamResultRow[]);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không tải được kết quả.');
    } finally {
      setIsRefreshing(false);
    }
  }, [exam.code]);

  // Live updates: v1 used Firebase RTDB listeners; v2 uses Realtime (D2).
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`exam_results:${exam.code}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'exam_results',
          filter: `exam_code=eq.${exam.code}`,
        },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [exam.code, refresh]);

  const needsGrading = results.filter((r) => r.needs_grading).length;
  const averageScore =
    results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const averagePercent =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + percentage(r.score, r.total_questions), 0) / results.length;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Số bài nộp" value={String(results.length)} />
        <StatCard label="Số câu hỏi" value={String(questions.length)} />
        <StatCard
          label="Điểm trung bình"
          value={`${Math.round(averageScore * 100) / 100} (${Math.round(averagePercent * 10) / 10}%)`}
        />
        <StatCard
          label="Cần chấm tự luận"
          value={String(needsGrading)}
          highlight={needsGrading > 0}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <button
          type="button"
          onClick={() => setShowRoster(true)}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <Users size={15} />
          Tải danh sách thí sinh
        </button>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {isRefreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Làm mới
        </button>

        <button
          type="button"
          onClick={() => exportResultsWorkbook(exam, questions, results)}
          disabled={results.length === 0}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          <Download size={15} />
          Xuất Excel (3 sheet)
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {results.length === 0 ? (
          <p className="p-10 text-center text-sm text-slate-500">
            Chưa có bài nộp nào. Kết quả sẽ tự động hiển thị khi học sinh nộp bài.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">STT</th>
                  <th className="px-3 py-2.5 font-semibold">Mã HS</th>
                  <th className="px-3 py-2.5 font-semibold">Họ và tên</th>
                  <th className="px-3 py-2.5 font-semibold">Lớp</th>
                  <th className="px-3 py-2.5 font-semibold">Điểm</th>
                  <th className="px-3 py-2.5 font-semibold">%</th>
                  <th className="px-3 py-2.5 font-semibold">Rời tab</th>
                  <th className="px-3 py-2.5 font-semibold">Nộp lúc</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((result, index) => (
                  <tr key={result.id} className="transition hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                    <td className="px-3 py-2 font-mono text-xs">{result.student_code}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        {result.student_name}
                        {result.needs_grading && (
                          <span
                            title="Có bài tự luận cần chấm"
                            className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700"
                          >
                            TL
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{result.class_name}</td>
                    <td className="px-3 py-2 font-semibold">
                      {result.score}/{result.total_questions}
                    </td>
                    <td className="px-3 py-2">
                      {percentage(result.score, result.total_questions)}%
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          result.blur_count > 0 ? 'font-semibold text-amber-600' : 'text-slate-400'
                        }
                      >
                        {result.blur_count}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {new Date(result.submitted_at).toLocaleString('vi-VN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showRoster && (
        <RosterUploadModal
          examCode={exam.code}
          examTitle={exam.title}
          onClose={() => setShowRoster(false)}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={
          highlight ? 'mt-1 text-xl font-bold text-amber-600' : 'mt-1 text-xl font-bold text-slate-900'
        }
      >
        {value}
      </p>
    </div>
  );
}
