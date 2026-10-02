import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { PersistenceError, loadExamByCode, loadExamQuestions } from '@/lib/exams';
import { ExamEditor } from '@/components/questions/ExamEditor';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ code: string }>;
}

/**
 * Post-creation exam editor (Phase 5.4).
 *
 * Loads metadata + question bank in parallel, and counts submissions in the
 * same pass — the count decides whether the UI locks add/delete. The RPC
 * re-checks the guard server-side, so the count here is a UX hint, not the
 * authority.
 */
export default async function ExamEditPage({ params }: PageProps) {
  const { code } = await params;
  const supabase = await createClient();

  const [exam, resultsResponse] = await Promise.all([
    loadExamByCode(supabase, code),
    supabase.from('exam_results').select('id').eq('exam_code', code),
  ]);

  if (!exam) notFound();
  if (resultsResponse.error) throw new PersistenceError(resultsResponse.error.message);

  const questions = await loadExamQuestions(supabase, exam.id);
  const submissionCount = resultsResponse.data?.length ?? 0;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <ArrowLeft size={15} />
          Quay lại
        </Link>
        <div>
          <h1 className="text-lg font-bold text-slate-900">Chỉnh sửa đề thi</h1>
          <p className="text-xs text-slate-500">
            Mã đề: <span className="font-mono font-semibold">{exam.code}</span>
          </p>
        </div>
      </div>

      <ExamEditor exam={exam} initialQuestions={questions} submissionCount={submissionCount} />
    </main>
  );
}
