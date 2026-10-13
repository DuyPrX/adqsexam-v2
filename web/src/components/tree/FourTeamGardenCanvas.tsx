'use client';

import React, { useEffect, useRef } from 'react';
import { FourTeamGardenEngine } from '@/lib/FourTeamGardenEngine';

interface FourTeamGardenCanvasProps {
  onEngineReady?: (engine: FourTeamGardenEngine) => void;
  className?: string;
}

export default function FourTeamGardenCanvas({
  onEngineReady,
  className = 'w-full h-full block'
}: FourTeamGardenCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<FourTeamGardenEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new FourTeamGardenEngine(canvas);
    engineRef.current = engine;

    if (onEngineReady) {
      onEngineReady(engine);
    }

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [onEngineReady]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-radial from-slate-800 via-slate-900 to-slate-950">
      <canvas
        ref={canvasRef}
        id="garden-canvas"
        className={className}
      />
    </div>
  );
}
