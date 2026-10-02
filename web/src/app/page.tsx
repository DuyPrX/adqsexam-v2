import { createClient } from '@/lib/supabase/server';
import { countResultsByExam, listExams, listTrashedExams } from '@/lib/exams';
import { ExamList } from '@/components/ExamList';

export const dynamic = 'force-dynamic';

/** Teacher dashboard: live exams + Trash, with submission counts. */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [exams, trashedExams, counts] = await Promise.all([
    listExams(supabase),
    listTrashedExams(supabase),
    countResultsByExam(supabase),
  ]);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <ExamList
        exams={exams}
        trashedExams={trashedExams}
        counts={Object.fromEntries(counts)}
        teacherEmail={user?.email ?? null}
      />
    </main>
  );
}
