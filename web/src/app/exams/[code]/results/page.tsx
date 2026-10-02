import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { PersistenceError } from '@/lib/exams';
import type { ExamResultRow, ExamRow, QuestionBankRow, StudentRow } from '@/lib/types';
import { ResultsDashboard } from '@/components/ResultsDashboard';
import { LiveProctorPanel } from '@/components/LiveProctorPanel';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ code: string }>;
}

/** Loads one exam by its public code (RLS restricts the row to its owner). */
async function loadExam(code: string): Promise<ExamRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('exams')
    .select('id, user_id, code, title, duration_minutes, is_active, created_at')
    .eq('code', code)
    .maybeSingle<ExamRow>();

  if (error) throw new PersistenceError(error.message);
  return data;
}

export default async function ExamResultsPage({ params }: PageProps) {
  const { code } = await params;

  // Phase 5.3 §3: no waterfall. The three child queries key off `code` (not on
  // the exam row), so they can run concurrently with `loadExam` instead of
  // waiting for it. `question_bank` is the only one that needs `exam.id`, so it
  // resolves the id itself rather than forcing a second round-trip.
  const supabase = await createClient();

  const [exam, resultsResponse, questionsResponse, rosterResponse] = await Promise.all([
    loadExam(code),
    supabase
      .from('exam_results')
      .select('*')
      .eq('exam_code', code)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('question_bank')
      .select('*, exam:exams!inner(code)')
      .eq('exam.code', code)
      .order('position', { ascending: true }),
    // Roster: active_sessions carries no names, so the live monitor resolves
    // identity from `students` in memory.
    supabase
      .from('students')
      .select('student_code, exam_code, full_name, class_name')
      .eq('exam_code', code),
  ]);

  if (!exam) notFound();

  if (resultsResponse.error) throw new PersistenceError(resultsResponse.error.message);
  if (questionsResponse.error) throw new PersistenceError(questionsResponse.error.message);
  if (rosterResponse.error) throw new PersistenceError(rosterResponse.error.message);

  // The embedded `exam` join is only there to filter; strip it back off so the
  // component keeps receiving plain QuestionBankRow objects.
  const questions = (questionsResponse.data ?? []).map((row) => {
    const { exam: _exam, ...question } = row as QuestionBankRow & { exam: { code: string } };
    return question as QuestionBankRow;
  });

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <ArrowLeft size={15} />
          Quay lại
        </Link>
        <div>
          <h1 className="text-lg font-bold text-slate-900">{exam.title}</h1>
          <p className="text-xs text-slate-500">
            Mã đề: <span className="font-mono font-semibold">{exam.code}</span> —{' '}
            {exam.duration_minutes} phút
          </p>
        </div>
      </div>

      <LiveProctorPanel examCode={exam.code} roster={(rosterResponse.data ?? []) as StudentRow[]} />

      <ResultsDashboard
        exam={exam}
        initialResults={(resultsResponse.data ?? []) as ExamResultRow[]}
        questions={questions}
      />
    </main>
  );
}
