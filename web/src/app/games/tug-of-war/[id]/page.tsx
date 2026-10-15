import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTugOfWarSession } from '@/lib/tugOfWar';
import { TugOfWarProjector } from '@/components/games/tug-of-war/TugOfWarProjector';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TugOfWarPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();

  try {
    const session = await getTugOfWarSession(supabase, id);
    if (!session) notFound();

    return <TugOfWarProjector initialSession={session} />;
  } catch (err) {
    notFound();
  }
}
