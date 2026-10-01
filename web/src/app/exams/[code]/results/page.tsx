import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { PersistenceError } from '@/lib/exams';
import type { ExamResultRow, ExamRow, QuestionBankRow } from '@/lib/types';
import { ResultsDashboard } from '@/components/ResultsDashboard';

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
  const exam = await loadExam(code);
  if (!exam) notFound();

  const supabase = await createClient();

  const [resultsResponse, questionsResponse] = await Promise.all([
    supabase
      .from('exam_results')
      .select('*')
      .eq('exam_code', exam.code)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('question_bank')
      .select('*')
      .eq('exam_id', exam.id)
      .order('position', { ascending: true }),
  ]);

  if (resultsResponse.error) throw new PersistenceError(resultsResponse.error.message);
  if (questionsResponse.error) throw new PersistenceError(questionsResponse.error.message);

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

      <ResultsDashboard
        exam={exam}
        initialResults={(resultsResponse.data ?? []) as ExamResultRow[]}
        questions={(questionsResponse.data ?? []) as QuestionBankRow[]}
      />
    </main>
  );
}
