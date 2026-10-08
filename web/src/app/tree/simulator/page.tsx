'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { captureCanvasSnapshot } from '@/lib/tree3d';
import type { CameraPreset } from '@/components/tree/three/ArenaStage3D';

// Dynamically import 3D Canvas to guarantee SSR-safety
const ArenaStage3D = dynamic(
  () => import('@/components/tree/three/ArenaStage3D'),
  { ssr: false, loading: () => <div className="p-12 text-white">Đang tải không gian 3D WebGL...</div> }
);

export default function Tree3DSimulatorPage() {
  const [vitalities, setVitalities] = useState<number[]>([0.2, 0.45, 0.75, 1.0]);
  const [dewCounts, setDewCounts] = useState<number[]>([2, 5, 8, 12]);
  const [windSpeed, setWindSpeed] = useState<number>(1.0);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('perspective');
  const [enableOrbit, setEnableOrbit] = useState<boolean>(true);

  const handleSliderChange = (index: number, val: number) => {
    const updated = [...vitalities];
    updated[index] = val;
    setVitalities(updated);
  };

  const handleAddDew = (index: number) => {
    const updated = [...dewCounts];
    updated[index] += 1;
    setDewCounts(updated);
    // Also bump vitality slightly
    const vit = [...vitalities];
    vit[index] = Math.min(1.0, vit[index] + 0.1);
    setVitalities(vit);
  };

  const handleTriggerGolden = (index: number) => {
    const vit = [...vitalities];
    vit[index] = 1.0;
    setVitalities(vit);
  };

  const handleSnapshot = () => {
    const canvas = document.querySelector('canvas');
    if (canvas) {
      captureCanvasSnapshot(canvas, `tree-3d-stage-${Date.now()}.png`);
    } else {
      alert('Không tìm thấy Canvas WebGL!');
    }
  };

  const stageTrees = [1, 2, 3, 4].map((team, idx) => ({
    teamNumber: team,
    vitality: vitalities[idx],
    dewCount: dewCounts[idx]
  }));

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Header */}
      <header className="px-6 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between z-10 flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            🌱 Đấu Trường Cây Tri Thức 3D — Simulator Sandbox
          </h1>
          <p className="text-xs text-slate-400">Kiểm thử trực tiếp mô hình khối 3D, bóng đổ và xuất Snapshot PNG</p>
        </div>

        {/* Global Controls: Wind & Camera & Snapshot */}
        <div className="flex items-center gap-3">
          {/* Wind Speed Selector */}
          <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
            <span className="text-slate-400 px-2 font-medium">Gió:</span>
            <button
              onClick={() => setWindSpeed(0.2)}
              className={`px-2.5 py-1 rounded transition ${windSpeed <= 0.3 ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Yên lặng
            </button>
            <button
              onClick={() => setWindSpeed(1.0)}
              className={`px-2.5 py-1 rounded transition ${windSpeed > 0.3 && windSpeed <= 1.5 ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Thoang thoảng
            </button>
            <button
              onClick={() => setWindSpeed(2.5)}
              className={`px-2.5 py-1 rounded transition ${windSpeed > 1.5 ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Gió bão
            </button>
          </div>

          {/* Camera Angles */}
          <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
            <span className="text-slate-400 px-2 font-medium">Góc nhìn:</span>
            <button
              onClick={() => setCameraPreset('front')}
              className={`px-2.5 py-1 rounded transition ${cameraPreset === 'front' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Chính diện
            </button>
            <button
              onClick={() => setCameraPreset('perspective')}
              className={`px-2.5 py-1 rounded transition ${cameraPreset === 'perspective' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Phối cảnh
            </button>
            <button
              onClick={() => setCameraPreset('top')}
              className={`px-2.5 py-1 rounded transition ${cameraPreset === 'top' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
            >
              Toàn cảnh trên cao
            </button>
          </div>

          {/* OrbitControls Toggle */}
          <button
            onClick={() => setEnableOrbit(!enableOrbit)}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${enableOrbit ? 'bg-slate-700 border-indigo-500/50 text-indigo-300' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
            title="Bật/Tắt xoay chuột tự do"
          >
            {enableOrbit ? '🖱️ Xoay tự do: Bật' : '🖱️ Xoay tự do: Tắt'}
          </button>

          {/* Snapshot Button */}
          <button
            onClick={handleSnapshot}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 font-semibold rounded-lg shadow-lg flex items-center gap-2 text-sm transition"
          >
            📸 Chụp Snapshot (PNG)
          </button>
        </div>
      </header>

      {/* Main 3D Viewport */}
      <div className="flex-1 relative">
        <ArenaStage3D
          trees={stageTrees}
          windSpeed={windSpeed}
          cameraPreset={cameraPreset}
          enableOrbit={enableOrbit}
        />
      </div>

      {/* Bottom Control Deck */}
      <footer className="p-4 bg-slate-900/95 backdrop-blur border-t border-slate-800 z-10 grid grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((team, idx) => (
          <div key={team} className="p-3 bg-slate-800/80 rounded-lg border border-slate-700/60 flex flex-col gap-2">
            <div className="flex justify-between items-center text-xs font-semibold">
              <span className="text-indigo-400 font-medium">Cây {team} (Tổ {team})</span>
              <span className="font-mono text-emerald-400 font-bold">{(vitalities[idx] * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="1.0"
              step="0.01"
              value={vitalities[idx]}
              onChange={(e) => handleSliderChange(idx, parseFloat(e.target.value))}
              className="w-full accent-indigo-500 cursor-pointer"
            />
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => handleAddDew(idx)}
                className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded font-medium transition"
              >
                +1 Câu đúng ({dewCounts[idx]})
              </button>
              <button
                onClick={() => handleTriggerGolden(idx)}
                className="py-1.5 px-3 bg-amber-600 hover:bg-amber-500 text-xs font-bold rounded transition"
                title="Bật Golden Latch 100%"
              >
                🏆 Golden Latch
              </button>
            </div>
          </div>
        ))}
      </footer>
    </div>
  );
}
