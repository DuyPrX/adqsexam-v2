'use client';

import { useState } from 'react';
import { BarChart3, Shield } from 'lucide-react';
import type { ExamResultRow, ExamRow, QuestionBankRow, StudentRow } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ResultsDashboard } from '@/components/ResultsDashboard';
import { LiveProctorPanel } from '@/components/LiveProctorPanel';
import { LiveProctorDashboard } from '@/components/exams/LiveProctorDashboard';

interface ExamResultsContainerProps {
  exam: ExamRow;
  initialResults: ExamResultRow[];
  questions: QuestionBankRow[];
  roster: StudentRow[];
  initialView?: 'results' | 'proctor';
}

export function ExamResultsContainer({
  exam,
  initialResults,
  questions,
  roster,
  initialView = 'results',
}: ExamResultsContainerProps) {
  const [activeTab, setActiveTab] = useState<'results' | 'proctor'>(initialView);

  return (
    <div className="space-y-4">
      {/* Navigation tabs between Submission Results and Live Anti-Cheat Proctoring */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('results')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition sm:text-sm',
              activeTab === 'results'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            <BarChart3 size={15} />
            Bảng kết quả & Thống kê ({initialResults.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('proctor')}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition sm:text-sm',
              activeTab === 'proctor'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-indigo-700 hover:bg-indigo-50',
            )}
          >
            <Shield size={15} />
            Giám sát trực tiếp 🛡️
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          </button>
        </div>

        <div className="hidden pr-2 text-xs font-medium text-slate-500 sm:block">
          {activeTab === 'proctor'
            ? 'Cảnh báo gian lận & phiên làm bài thời gian thực'
            : 'Tổng hợp điểm số & phân tích câu hỏi'}
        </div>
      </div>

      {activeTab === 'proctor' ? (
        <div className="space-y-4">
          <LiveProctorDashboard
            examCode={exam.code}
            examTitle={exam.title}
            roster={roster}
          />
          <LiveProctorPanel examCode={exam.code} roster={roster} />
        </div>
      ) : (
        <div className="space-y-4">
          <LiveProctorPanel examCode={exam.code} roster={roster} />
          <ResultsDashboard
            exam={exam}
            initialResults={initialResults}
            questions={questions}
          />
        </div>
      )}
    </div>
  );
}
