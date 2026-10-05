import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { listClasses } from '@/lib/classes';
import { ClassRosterManager } from '@/components/ClassRosterManager';

export const dynamic = 'force-dynamic';

/**
 * Class roster management (Phase 6.2).
 *
 * Classes are fetched server-side so the first paint already has the rosters;
 * every mutation afterwards goes through the client component's Supabase
 * browser client and a `router.refresh()`.
 */
export default async function ClassesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const classes = await listClasses(supabase);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Lớp học</h1>
          <p className="text-sm text-slate-500">
            {user?.email ? `Đăng nhập với ${user.email}` : 'Quản lý danh sách học sinh theo lớp'}
          </p>
        </div>
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <ArrowLeft size={15} />
          Về đề thi
        </Link>
      </div>

      <ClassRosterManager initialClasses={classes} />
    </main>
  );
}
