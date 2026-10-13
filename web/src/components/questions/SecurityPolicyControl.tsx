'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CopyX,
  EyeOff,
  Fingerprint,
  Hand,
  Shield,
  ShieldCheck,
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
  ].filter(Boolean).length;

  const handleToggle = (key: keyof ExamSecurityConfig) => {
    if (disabled) return;
    onChange({
      ...config,
      [key]: !config[key],
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
            {activeCount}/4 đang bật
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
        </div>
      )}
    </div>
  );
}
