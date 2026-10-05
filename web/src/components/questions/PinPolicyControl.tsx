'use client';

import { ShieldCheck } from 'lucide-react';
import type { PinMode } from '@/lib/types';
import { cn } from '@/lib/utils';

interface PinPolicyControlProps {
  mode: PinMode;
  globalPin: string;
  onModeChange: (mode: PinMode) => void;
  onGlobalPinChange: (value: string) => void;
  /** Blocks the controls while a save/import is in flight. */
  disabled?: boolean;
}

const PIN_MODE_OPTIONS: ReadonlyArray<{ value: PinMode; label: string; hint: string }> = [
  {
    value: 'INDIVIDUAL',
    label: 'Từng học sinh',
    hint: 'Mỗi em dùng mã PIN riêng; nếu để trống thì dùng ngày sinh dạng DDMM.',
  },
  {
    value: 'GLOBAL',
    label: 'Chung toàn đề',
    hint: 'Một mã duy nhất cho cả phòng thi.',
  },
  {
    value: 'NONE',
    label: 'Không yêu cầu mã',
    hint: 'Học sinh vào thi không cần nhập mã.',
  },
];

/**
 * Per-exam admission policy selector (Phase 6.2).
 *
 * Mirrors the server-side `exams.pin_mode` CHECK (Phase 6.1). The `global_pin`
 * input only appears for GLOBAL, and an empty value is rejected by
 * `buildPinFields`/`updateExamMetadata` — Phase 6.1's RPC fails CLOSED on a NULL
 * shared PIN, so writing one would leave an exam nobody can enter.
 */
export function PinPolicyControl({
  mode,
  globalPin,
  onModeChange,
  onGlobalPinChange,
  disabled = false,
}: PinPolicyControlProps) {
  const active = PIN_MODE_OPTIONS.find((option) => option.value === mode) ?? PIN_MODE_OPTIONS[0]!;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center gap-1.5">
        <ShieldCheck size={14} className="text-slate-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Loại mã bảo vệ
        </span>
      </div>

      <div className="flex flex-col gap-1 sm:flex-row sm:overflow-hidden sm:rounded-lg sm:border sm:border-slate-200">
        {PIN_MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(option.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition sm:flex-1 sm:rounded-none',
              mode === option.value
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-slate-500">{active.hint}</p>

      {mode === 'GLOBAL' && (
        <div className="space-y-1">
          <label className="text-xs font-semibold text-slate-600">Mã PIN chung</label>
          <input
            type="text"
            value={globalPin}
            disabled={disabled}
            onChange={(event) => onGlobalPinChange(event.target.value)}
            placeholder="VD: PHONGTHI12A1"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none transition focus:border-slate-400 disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}
