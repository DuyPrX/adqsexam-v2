'use client';

import React, { useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { captureCanvasSnapshot } from '@/lib/tree3d';
import { FourTeamGardenEngine, TEAM_SPECIES, DropType } from '@/lib/FourTeamGardenEngine';

// Dynamically import 2.5D Canvas with ssr: false for Canvas safety
const FourTeamGardenCanvas = dynamic(
  () => import('@/components/tree/FourTeamGardenCanvas'),
  { ssr: false, loading: () => <div className="p-12 text-white">Đang tải Vườn Cây 2.5D WebGL / Canvas...</div> }
);

type SimulatorMode = 'quiz' | 'opinion' | 'manual';

export default function Tree3DSimulatorPage() {
  const [mode, setMode] = useState<SimulatorMode>('quiz');
  const engineRef = useRef<FourTeamGardenEngine | null>(null);

  // Growth & score states for 4 teams
  const [vitalities, setVitalities] = useState<number[]>([0.15, 0.45, 0.75, 1.0]);
  const [dewCounts, setDewCounts] = useState<number[]>([2, 5, 8, 12]);
  const [comboStreaks, setComboStreaks] = useState<number[]>([0, 2, 5, 10]);
  const [multiplier, setMultiplier] = useState<number>(3);
  const [totalMembers, setTotalMembers] = useState<number>(10);

  const handleEngineReady = useCallback((engine: FourTeamGardenEngine) => {
    engineRef.current = engine;
    // Initialize teams with initial growth values
    engine.setTeamGrowth(0, 0.15);
    engine.setTeamGrowth(1, 0.45);
    engine.setTeamGrowth(2, 0.75);
    engine.setTeamGrowth(3, 1.0);
  }, []);

  const handleSliderChange = (index: number, val: number) => {
    const updated = [...vitalities];
    updated[index] = val;
    setVitalities(updated);
    if (engineRef.current) {
      engineRef.current.setTeamGrowth(index, val);
    }
  };

  const handleAddDew = (index: number) => {
    const updatedDew = [...dewCounts];
    updatedDew[index] += 1;
    setDewCounts(updatedDew);

    const updatedVit = [...vitalities];
    updatedVit[index] = Math.min(1.0, updatedVit[index] + 0.08);
    setVitalities(updatedVit);

    if (engineRef.current) {
      if (mode === 'opinion') {
        engineRef.current.updateOpinionMode(index, {
          validSubmittedCount: updatedDew[index],
          totalMembers: totalMembers,
          wordCountRatio: 1.25,
          dropType: 'nutrient',
          isWinner: updatedVit[index] >= 1.0
        });
      } else {
        const nextCombo = comboStreaks[index] + 1;
        const newCombos = [...comboStreaks];
        newCombos[index] = nextCombo;
        setComboStreaks(newCombos);

        engineRef.current.updateQuizMode(index, {
          correctAnswers: updatedDew[index],
          totalMembers: totalMembers,
          multiplier: multiplier,
          comboStreak: nextCombo,
          lastAnswerCorrect: true,
          isFastAnswer: false,
          isWinner: updatedVit[index] >= 1.0
        });
      }
    }
  };

  const handleFastAnswer = (index: number) => {
    const updatedDew = [...dewCounts];
    updatedDew[index] += 1;
    setDewCounts(updatedDew);

    const updatedVit = [...vitalities];
    updatedVit[index] = Math.min(1.0, updatedVit[index] + 0.12);
    setVitalities(updatedVit);

    const nextCombo = comboStreaks[index] + 1;
    const newCombos = [...comboStreaks];
    newCombos[index] = nextCombo;
    setComboStreaks(newCombos);

    if (engineRef.current) {
      engineRef.current.updateQuizMode(index, {
        correctAnswers: updatedDew[index],
        totalMembers: totalMembers,
        multiplier: multiplier,
        comboStreak: nextCombo,
        lastAnswerCorrect: true,
        isFastAnswer: true,
        isWinner: updatedVit[index] >= 1.0
      });
    }
  };

  const handleWrongAnswer = (index: number) => {
    const newCombos = [...comboStreaks];
    newCombos[index] = 0;
    setComboStreaks(newCombos);

    if (engineRef.current) {
      engineRef.current.updateQuizMode(index, {
        correctAnswers: dewCounts[index],
        totalMembers: totalMembers,
        multiplier: multiplier,
        comboStreak: 0,
        lastAnswerCorrect: false,
        isWinner: false
      });
    }
  };

  const handleSpawnDrop = (index: number, dropType: DropType) => {
    if (engineRef.current) {
      engineRef.current.spawnDrop(index, dropType);
    }
  };

  const handleTriggerGolden = (index: number) => {
    const updated = [...vitalities];
    updated[index] = 1.0;
    setVitalities(updated);
    if (engineRef.current) {
      engineRef.current.triggerWinner(index);
    }
  };

  const handleResetSession = () => {
    setVitalities([0.06, 0.06, 0.06, 0.06]);
    setDewCounts([0, 0, 0, 0]);
    setComboStreaks([0, 0, 0, 0]);
    if (engineRef.current) {
      engineRef.current.resetAll();
    }
  };

  const handleSnapshot = () => {
    const canvas = document.querySelector('canvas');
    if (canvas) {
      captureCanvasSnapshot(canvas, `garden-2.5d-snapshot-${Date.now()}.png`);
    } else {
      alert('Không tìm thấy Canvas!');
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Header */}
      <header className="px-6 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between z-10 flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            🌱 Đấu Trường Cây Tri Thức 2.5D — Four Team Garden Simulator
          </h1>
          <p className="text-xs text-slate-400">
            Engine 2.5D High-Detail Botanical Native Canvas — Siêu nhẹ 60FPS, 4 loài cây thi đua đồng thời
          </p>
        </div>

        {/* Global Controls & Mode Switcher */}
        <div className="flex items-center gap-3">
          {/* Mode Switcher */}
          <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
            <span className="text-slate-400 px-2 font-medium">Chế độ:</span>
            <button
              onClick={() => setMode('quiz')}
              className={`px-2.5 py-1 rounded transition ${mode === 'quiz' ? 'bg-indigo-600 text-white font-semibold shadow' : 'text-slate-300 hover:text-white'}`}
            >
              📝 Trắc nghiệm 2x/3x
            </button>
            <button
              onClick={() => setMode('opinion')}
              className={`px-2.5 py-1 rounded transition ${mode === 'opinion' ? 'bg-indigo-600 text-white font-semibold shadow' : 'text-slate-300 hover:text-white'}`}
            >
              💡 Thu thập ý kiến
            </button>
            <button
              onClick={() => setMode('manual')}
              className={`px-2.5 py-1 rounded transition ${mode === 'manual' ? 'bg-indigo-600 text-white font-semibold shadow' : 'text-slate-300 hover:text-white'}`}
            >
              🎛️ Chỉnh tay Sliders
            </button>
          </div>

          {/* Quiz Multiplier Toggle */}
          {mode === 'quiz' && (
            <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
              <span className="text-slate-400 px-2 font-medium">Hệ số:</span>
              <button
                onClick={() => setMultiplier(2)}
                className={`px-2 py-1 rounded transition ${multiplier === 2 ? 'bg-amber-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
              >
                2x Sĩ số
              </button>
              <button
                onClick={() => setMultiplier(3)}
                className={`px-2 py-1 rounded transition ${multiplier === 3 ? 'bg-amber-600 text-white font-semibold' : 'text-slate-300 hover:text-white'}`}
              >
                3x Sĩ số
              </button>
            </div>
          )}

          {/* Reset Session */}
          <button
            onClick={handleResetSession}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 text-xs font-medium transition"
          >
            🔄 Bắt đầu lại
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

      {/* Main 2.5D Viewport */}
      <div className="flex-1 relative">
        <FourTeamGardenCanvas onEngineReady={handleEngineReady} />
      </div>

      {/* Bottom Control Deck */}
      <footer className="p-4 bg-slate-900/95 backdrop-blur border-t border-slate-800 z-10 grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((idx) => {
          const spec = TEAM_SPECIES[idx];
          const vit = vitalities[idx];
          const dews = dewCounts[idx];
          const combo = comboStreaks[idx];

          return (
            <div
              key={spec.id}
              className="p-3 bg-slate-800/80 rounded-lg border border-slate-700/60 flex flex-col gap-2 transition hover:border-slate-600"
            >
              {/* Team Species Title */}
              <div className="flex justify-between items-center text-xs font-semibold">
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block"
                    style={{ backgroundColor: spec.badgeColor }}
                  />
                  <span className="font-bold text-slate-200">{spec.teamDefaultName}</span>
                </div>
                <span className="font-mono text-emerald-400 font-bold">{(vit * 100).toFixed(0)}%</span>
              </div>

              {/* Direct Growth Scrubbing Slider */}
              <input
                type="range"
                min="0.06"
                max="1.0"
                step="0.01"
                value={vit}
                onChange={(e) => handleSliderChange(idx, parseFloat(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
                title={`Kéo thanh trượt điều chỉnh mức lớn của ${spec.teamDefaultName}`}
              />

              {/* Mode-Specific Action Triggers */}
              {mode === 'quiz' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleAddDew(idx)}
                      className="flex-1 py-1 px-2 bg-emerald-600 hover:bg-emerald-500 text-xs rounded font-medium transition"
                      title="Nộp 1 câu đúng bình thường (+1 giọt sương)"
                    >
                      +1 Đúng ({dews})
                    </button>
                    <button
                      onClick={() => handleFastAnswer(idx)}
                      className="py-1 px-2 bg-amber-600 hover:bg-amber-500 text-xs font-bold rounded transition"
                      title="Nộp siêu nhanh <5s (+1 giọt nắng vàng)"
                    >
                      ⚡ Nhanh
                    </button>
                    <button
                      onClick={() => handleWrongAnswer(idx)}
                      className="py-1 px-2 bg-rose-700 hover:bg-rose-600 text-xs font-bold rounded transition"
                      title="Trả lời sai (+1 giọt mưa xám rung cây)"
                    >
                      ❌ Sai
                    </button>
                  </div>
                  <div className="flex justify-between items-center text-[11px] text-slate-400">
                    <span>Chuỗi: {combo > 0 ? `🔥 x${combo}` : '0'}</span>
                    <button
                      onClick={() => handleTriggerGolden(idx)}
                      className="text-amber-400 hover:text-amber-300 font-bold underline"
                    >
                      🏆 Về đích
                    </button>
                  </div>
                </div>
              )}

              {mode === 'opinion' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleAddDew(idx)}
                      className="flex-1 py-1 px-2 bg-indigo-600 hover:bg-indigo-500 text-xs rounded font-medium transition"
                      title="1 học sinh nộp đủ số từ yêu cầu"
                    >
                      +1 Đủ từ ({dews})
                    </button>
                    <button
                      onClick={() => handleFastAnswer(idx)}
                      className="py-1 px-2 bg-amber-600 hover:bg-amber-500 text-xs font-bold rounded transition"
                      title="Học sinh viết xuất sắc vượt 150% số từ"
                    >
                      ⭐ Xuất sắc
                    </button>
                  </div>
                  <div className="flex justify-between items-center text-[11px] text-slate-400">
                    <span>Sĩ số: {totalMembers} HS</span>
                    <button
                      onClick={() => handleTriggerGolden(idx)}
                      className="text-amber-400 hover:text-amber-300 font-bold underline"
                    >
                      🏆 100% Nộp
                    </button>
                  </div>
                </div>
              )}

              {mode === 'manual' && (
                <div className="flex gap-1 justify-between">
                  <button
                    onClick={() => handleSpawnDrop(idx, 'dew')}
                    className="flex-1 py-1 bg-sky-700/80 hover:bg-sky-600 text-xs rounded text-center"
                    title="Thả giọt sương"
                  >
                    💧 Sương
                  </button>
                  <button
                    onClick={() => handleSpawnDrop(idx, 'nutrient')}
                    className="flex-1 py-1 bg-emerald-700/80 hover:bg-emerald-600 text-xs rounded text-center"
                    title="Thả giọt dinh dưỡng"
                  >
                    🌿 Dinh dưỡng
                  </button>
                  <button
                    onClick={() => handleSpawnDrop(idx, 'sun')}
                    className="flex-1 py-1 bg-amber-700/80 hover:bg-amber-600 text-xs rounded text-center"
                    title="Thả giọt ánh dương"
                  >
                    ☀️ Nắng
                  </button>
                  <button
                    onClick={() => handleSpawnDrop(idx, 'rain')}
                    className="flex-1 py-1 bg-slate-700 hover:bg-slate-600 text-xs rounded text-center"
                    title="Thả giọt mưa rung lá"
                  >
                    🌧️ Mưa
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </footer>
    </div>
  );
}
