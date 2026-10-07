'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { FileUp, Loader2, Sparkles, Zap } from 'lucide-react';
import { CUSTOM_MODEL, buildModelOptions } from '@/lib/ai';
import { ExtractionError, extractDocx } from '@/lib/extractor';
import type { ExtractionMode, ExtractionResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

interface UploadZoneProps {
  /** Called with the Worker payload once extraction succeeds. */
  onExtracted: (result: ExtractionResponse, file: File) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}

const ENGINE_OPTIONS: Array<{
  value: ExtractionMode;
  title: string;
  description: string;
  icon: typeof Zap;
}> = [
  {
    value: 'auto',
    title: 'Tự động',
    description: 'Ưu tiên phân tích nhanh, tự chuyển sang AI khi cần.',
    icon: Zap,
  },
  {
    value: 'rule',
    title: 'Phân tích nhanh',
    description: 'Thuật toán rule-based, tức thời và miễn phí.',
    icon: Zap,
  },
  {
    value: 'ai',
    title: 'AI nâng cao',
    description: 'Dùng Gemini cho định dạng phức tạp. Chậm hơn.',
    icon: Sparkles,
  },
];

export function UploadZone({ onExtracted, onError, disabled = false }: UploadZoneProps) {
  const [mode, setMode] = useState<ExtractionMode>('auto');
  const [modelChoice, setModelChoice] = useState<string>('');
  const [customModel, setCustomModel] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The shortlist is deployment configuration (see lib/ai.ts), so it is read
  // once per mount — `process.env` is inlined at build time and cannot change
  // while the page is open.
  const modelOptions = useMemo(() => buildModelOptions(), []);

  const isCustomModel = modelChoice === CUSTOM_MODEL;
  /** The model id actually sent to the Worker; undefined = use the default. */
  const selectedModel = isCustomModel ? customModel.trim() : modelChoice.trim();

  const handleFile = useCallback(
    async (file: File) => {
      // Guard before spending an upload: a custom row with a blank id would
      // silently fall back to the default model instead of what was asked for.
      if (isCustomModel && customModel.trim() === '') {
        const message = 'Vui lòng nhập ID mô hình tùy chỉnh.';
        setLocalError(message);
        onError?.(message);
        return;
      }
      setLocalError(null);
      setFileName(file.name);
      setIsProcessing(true);
      try {
        const result = await extractDocx(file, {
          mode,
          model: selectedModel || undefined,
        });
        onExtracted(result, file);
      } catch (error) {
        const message =
          error instanceof ExtractionError
            ? error.message
            : 'Đã xảy ra lỗi không xác định khi trích xuất.';
        setLocalError(message);
        onError?.(message);
        setFileName(null);
      } finally {
        setIsProcessing(false);
      }
    },
    [mode, selectedModel, isCustomModel, customModel, onExtracted, onError],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled || isProcessing) return;
      const file = event.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [disabled, isProcessing, handleFile],
  );

  return (
    <div className="space-y-5">
      {/* Engine selector */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700">Công cụ trích xuất</span>
          {mode === 'ai' && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-700">
              Tốn token AI
            </span>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {ENGINE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={isProcessing || disabled}
                onClick={() => setMode(option.value)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all disabled:opacity-50',
                  active
                    ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon size={14} />
                  {option.title}
                </span>
                <span
                  className={cn(
                    'text-[11px] leading-snug',
                    active ? 'text-slate-300' : 'text-slate-500',
                  )}
                >
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* AI model selector — only meaningful when the AI engine may run. */}
      {(mode === 'ai' || mode === 'auto') && (
        <div className="space-y-2 rounded-lg border border-purple-200 bg-purple-50/50 p-3">
          <label
            htmlFor="model-select"
            className="flex items-center gap-1.5 text-sm font-semibold text-slate-700"
          >
            <Sparkles size={14} className="text-purple-600" />
            Mô hình AI
          </label>
          <select
            id="model-select"
            value={modelChoice}
            disabled={isProcessing || disabled}
            onChange={(event) => setModelChoice(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200 disabled:opacity-50"
          >
            {modelOptions.map((option) => (
              <option key={option.value || 'default'} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Mô hình tùy chỉnh…</option>
          </select>

          {isCustomModel && (
            <input
              type="text"
              value={customModel}
              disabled={isProcessing || disabled}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder="VD: gemini-2.5-pro"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-800 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200 disabled:opacity-50"
            />
          )}

          <p className="text-[11px] leading-snug text-slate-500">
            {mode === 'auto'
              ? 'Chỉ dùng khi phân tích nhanh không đủ dữ liệu để chuyển sang AI.'
              : 'Mô hình này sẽ được gọi trực tiếp cho toàn bộ tệp.'}
          </p>
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !isProcessing) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => !disabled && !isProcessing && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-all',
          isDragging
            ? 'border-slate-900 bg-slate-100'
            : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50',
          (isProcessing || disabled) && 'pointer-events-none opacity-60',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = '';
          }}
        />

        {isProcessing ? (
          <>
            <Loader2 size={36} className="animate-spin text-slate-700" />
            <div>
              <p className="font-semibold text-slate-800">Đang trích xuất câu hỏi…</p>
              <p className="text-xs text-slate-500">{fileName}</p>
              {mode === 'ai' && (
                <p className="mt-1 text-xs text-purple-600">
                  AI đang phân tích, quá trình này có thể mất tới 2 phút.
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <FileUp size={36} className="text-slate-400" />
            <div>
              <p className="font-semibold text-slate-800">
                Kéo thả tệp .docx vào đây hoặc bấm để chọn
              </p>
              <p className="text-xs text-slate-500">Dung lượng tối đa 50MB</p>
            </div>
          </>
        )}
      </div>

      {localError && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {localError}
        </p>
      )}
    </div>
  );
}
