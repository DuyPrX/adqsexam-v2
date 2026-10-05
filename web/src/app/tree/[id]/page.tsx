import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { getTreeSession, getTreeSubmissions } from '@/lib/tree';
import { TreeProjector } from '@/components/tree/TreeProjector';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Tree of Knowledge projector (Phase 7.3).
 *
 * The session, its class size and every submission are fetched server-side so
 * the projector's FIRST paint is already a correct tree — a classroom projector
 * that opened to an empty canvas and waited for a Realtime event would look
 * broken. Realtime only carries deltas from there on.
 *
 * Runs inside the teacher area, so the Phase 6 `proxy` auth gate already
 * guarantees `auth.uid()`, and RLS scopes both reads to the owning teacher.
 */
export default async function TreeProjectorPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  // Two independent queries keyed off the same `id`; running them concurrently
  // avoids a waterfall on a screen the teacher opens mid-lesson.
  const [session, submissions] = await Promise.all([
    getTreeSession(supabase, id),
    getTreeSubmissions(supabase, id),
  ]);

  if (!session) notFound();

  return (
    <div className="relative">
      <Link
        href="/classes"
        className="absolute left-4 top-4 z-30 flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 backdrop-blur transition hover:bg-slate-700"
      >
        <ArrowLeft size={14} />
        Lớp học
      </Link>
      <TreeProjector session={session} initialSubmissions={submissions} />
    </div>
  );
}
