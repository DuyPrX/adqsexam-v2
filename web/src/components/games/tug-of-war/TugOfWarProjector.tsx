'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { startTugOfWarSession } from '@/lib/tugOfWar';
import type { TugOfWarSessionDetail } from '@/lib/types';
import { TugOfWarArena } from './TugOfWarArena';
import { TugOfWarLobby } from './TugOfWarLobby';

interface TugOfWarProjectorProps {
  initialSession: TugOfWarSessionDetail;
}

export function TugOfWarProjector({ initialSession }: TugOfWarProjectorProps) {
  const [session, setSession] = useState<TugOfWarSessionDetail>(initialSession);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to Realtime row changes on this session
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`tug-projector-${session.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tug_of_war_sessions',
          filter: `id=eq.${session.id}`,
        },
        (payload) => {
          const updated = payload.new as TugOfWarSessionDetail;
          setSession((prev) => ({
            ...prev,
            ...updated,
          }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session.id]);

  const handleStart = async () => {
    if (session.status !== 'LOBBY' || isStarting) return;
    setIsStarting(true);
    setError(null);

    try {
      const supabase = createClient();
      const res = await startTugOfWarSession(supabase, session.id);
      setSession((prev) => ({
        ...prev,
        status: 'ACTIVE',
        started_at: res.startedAt,
        ends_at: res.endsAt,
      }));
    } catch (err) {
      setError((err as Error).message || 'Không thể bắt đầu trận đấu.');
      setIsStarting(false);
    }
  };

  if (session.status === 'LOBBY') {
    return (
      <TugOfWarLobby
        session={session}
        isStarting={isStarting}
        onStart={handleStart}
      />
    );
  }

  return <TugOfWarArena initialSession={session} />;
}
