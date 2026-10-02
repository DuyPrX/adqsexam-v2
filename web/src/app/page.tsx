import { after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { countResultsByExam, listExams, listTrashedExams, purgeExpiredExams } from '@/lib/exams';
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

  // Second layer of defence for the 7-day Trash window.
  //
  // pg_cron owns the daily cadence (migration 20261002190000), but a
  // free-tier project that was paused runs no background workers, so the sweep
  // can lag behind a wake-up. Sweeping here closes that gap.
  //
  // `after` rather than a bare floating promise: it runs once the response has
  // been sent, so the dashboard is never slowed down, but — unlike a detached
  // promise — serverless runtimes cannot kill it mid-flight.
  //
  // Gated on a non-empty Trash because the sweep is global and scans `exams`:
  // with nothing trashed there is provably nothing to purge.
  if (trashedExams.length > 0) {
    after(async () => {
      try {
        await purgeExpiredExams(supabase);
      } catch {
        // Purely opportunistic: the cron job remains the guarantee, so a
        // failed sweep must never surface as a dashboard error.
      }
    });
  }

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
