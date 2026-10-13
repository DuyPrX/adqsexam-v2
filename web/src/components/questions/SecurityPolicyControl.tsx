'use client';

import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Columns2,
  CopyX,
  EyeOff,
  Fingerprint,
  Hand,
  Maximize,
  Shield,
  ShieldAlert,
} from 'lucide-react';
import type { ExamSecurityConfig } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SecurityPolicyControlProps {
  config: ExamSecurityConfig;
  onChange: (config: ExamSecurityConfig) => void;
  /** Blocks controls while save is in flight. */
  disabled?: boolean;
}

export function SecurityPolicyControl({
  config,
  onChange,
  disabled = false,
}: SecurityPolicyControlProps) {
  const [isOpen, setIsOpen] = useState(true);

  const activeCount = [
    config.prevent_copy,
    config.detect_multitouch,
    config.blur_on_leave,
    config.watermark,
    config.enforce_fullscreen,
    config.detect_split_screen,
    config.detect_motion,
    config.auto_submit_on_limit,
  ].filter(Boolean).length;

  const handleToggle = (key: keyof ExamSecurityConfig) => {
    if (disabled) return;
    onChange({
      ...config,
      [key]: !config[key],
    });
  };

  const handleMaxViolationsChange = (val: number) => {
    if (disabled) return;
    const clamped = Math.min(10, Math.max(1, Math.floor(val) || 1));
    onChange({
      ...config,
      max_violations: clamped,
    });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 transition-colors">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-indigo-600" />
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
            Bảo mật phòng thi (Anti-Cheat)
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
              activeCount > 0
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-slate-200 text-slate-600',
            )}
          >
            {activeCount}/8 đang bật
          </span>
        </div>
        <div className="text-slate-400 hover:text-slate-600">
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {isOpen && (
        <div className="mt-3 space-y-2.5 border-t border-slate-200/80 pt-3">
          {/* 1. Prevent copy */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.prevent_copy
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.prevent_copy}
              disabled={disabled}
              onChange={() => handleToggle('prevent_copy')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <CopyX size={13} className="text-indigo-600" />
                <span>Chặn sao chép &amp; nhấn giữ văn bản</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Khóa bôi đen, chuột phải, lệnh sao chép trên toàn bộ đề thi để tránh phát tán câu hỏi.
              </p>
            </div>
          </label>

          {/* 2. Detect multitouch */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.detect_multitouch
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.detect_multitouch}
              disabled={disabled}
              onChange={() => handleToggle('detect_multitouch')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Hand size={13} className="text-indigo-600" />
                <span>Phát hiện chạm ≥ 3 ngón (chống cử chỉ chụp màn hình)</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Phát hiện thao tác vuốt 3 ngón chụp màn hình trên điện thoại/máy tính bảng và kích hoạt lớp chắn làm mờ.
              </p>
            </div>
          </label>

          {/* 3. Blur on leave */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.blur_on_leave
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.blur_on_leave}
              disabled={disabled}
              onChange={() => handleToggle('blur_on_leave')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <EyeOff size={13} className="text-indigo-600" />
                <span>Làm mờ khi chuyển app hoặc rời màn hình</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Làm mờ toàn bộ bài thi khi chuyển tab hoặc đổi ứng dụng, đồng thời ghi log vi phạm về hệ thống.
              </p>
            </div>
          </label>

          {/* 4. Watermark */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.watermark
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.watermark}
              disabled={disabled}
              onChange={() => handleToggle('watermark')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Fingerprint size={13} className="text-indigo-600" />
                <span>In chìm hình mờ pháp y tên thí sinh</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Hiển thị watermark chìm mang họ tên, mã thí sinh và mã đề, tự phục hồi nếu bị can thiệp qua DevTools.
              </p>
            </div>
          </label>

          {/* 5. Enforce Fullscreen */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.enforce_fullscreen
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.enforce_fullscreen}
              disabled={disabled}
              onChange={() => handleToggle('enforce_fullscreen')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Maximize size={13} className="text-indigo-600" />
                <span>Bắt buộc toàn màn hình (Enforce Fullscreen)</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Bắt buộc thí sinh làm bài trong chế độ toàn màn hình. Khi thoát ra sẽ lập tức làm mờ giao diện và ghi nhận vi phạm.
              </p>
            </div>
          </label>

          {/* 6. Detect Split-Screen */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.detect_split_screen
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.detect_split_screen}
              disabled={disabled}
              onChange={() => handleToggle('detect_split_screen')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Columns2 size={13} className="text-indigo-600" />
                <span>Phát hiện chia đôi màn hình / cửa sổ nổi</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Tự động phát hiện khi chiều cao viewport co hẹp bất thường do chia đôi màn hình hoặc mở cửa sổ app khác.
              </p>
            </div>
          </label>

          {/* 7. Detect Motion */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.detect_motion
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.detect_motion}
              disabled={disabled}
              onChange={() => handleToggle('detect_motion')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Activity size={13} className="text-indigo-600" />
                <span>Cố định thiết bị trên bàn (Cảm biến di chuyển)</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Sử dụng cảm biến gia tốc để cảnh báo khi thiết bị bị nhấc lên khỏi mặt bàn hoặc lắc mạnh (iOS yêu cầu xác nhận quyền).
              </p>
            </div>
          </label>

          {/* 8. Auto-submit on limit */}
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition',
              config.auto_submit_on_limit
                ? 'border-indigo-200 bg-white shadow-xs'
                : 'border-slate-200 bg-slate-100/60 opacity-80',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={config.auto_submit_on_limit}
              disabled={disabled}
              onChange={() => handleToggle('auto_submit_on_limit')}
              className="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            />
            <div className="flex-1 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <ShieldAlert size={13} className="text-indigo-600" />
                <span>Tự động nộp bài khi vượt ngưỡng vi phạm</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Tự động thu hồi quyền làm bài và nộp bài cưỡng chế khi số lần vi phạm chạm ngưỡng cho phép.
              </p>
            </div>
          </label>

          {/* Max violations input */}
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                <AlertTriangle size={13} className="text-amber-500" />
                <span>Số lần vi phạm tối đa cho phép</span>
              </div>
              <p className="mt-0.5 text-slate-500">
                Số lần cảnh báo trước khi kích hoạt xử lý vi phạm hoặc tự động nộp bài (1 - 10 lần).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                value={config.max_violations ?? 3}
                disabled={disabled}
                onChange={(e) => handleMaxViolationsChange(parseInt(e.target.value, 10))}
                className="w-16 rounded border border-slate-300 px-2 py-1 text-center text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:outline-none"
              />
              <span className="text-xs text-slate-500">lần</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

