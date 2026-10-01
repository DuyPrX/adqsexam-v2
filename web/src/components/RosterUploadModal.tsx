'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, Loader2, Upload, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError, saveRoster } from '@/lib/exams';
import { parseRosterFile } from '@/lib/excel';
import type { RosterEntry } from '@/lib/types';

interface RosterUploadModalProps {
  examCode: string;
  examTitle: string;
  onClose: () => void;
  onSaved?: (count: number) => void;
}

/**
 * Roster import modal.
 *
 * The file is parsed entirely in the browser (D4: SheetJS replaces the v1
 * Apache POI PortalIntegrationService), previewed for confirmation, and only
 * then batch-inserted into `students`.
 */
export function RosterUploadModal({
  examCode,
  examTitle,
  onClose,
  onSaved,
}: RosterUploadModalProps) {
  const [entries, setEntries] = useState<RosterEntry[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setEntries(null);
    setFileName(file.name);
    setIsParsing(true);
    try {
      setEntries(await parseRosterFile(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSave = async () => {
    if (!entries || entries.length === 0) return;
    setError(null);
    setIsSaving(true);
    try {
      const supabase = createClient();
      const { inserted } = await saveRoster(supabase, examCode, entries);
      onSaved?.(inserted);
      onClose();
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không lưu được danh sách.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Tải danh sách thí sinh</h2>
            <p className="text-xs text-slate-500">
              Đề: {examTitle} — mã <span className="font-mono font-semibold">{examCode}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div
            onClick={() => inputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-slate-300 p-6 text-center transition hover:border-slate-400 hover:bg-slate-50"
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />
            {isParsing ? (
              <Loader2 size={24} className="animate-spin text-slate-500" />
            ) : (
              <Upload size={24} className="text-slate-400" />
            )}
            <div>
              <p className="text-sm font-semibold text-slate-700">
                {fileName ?? 'Chọn tệp Excel (.xlsx / .xls / .csv)'}
              </p>
              <p className="text-xs text-slate-500">
                Cần có cột “Mã học sinh” và “Họ tên”; cột “Lớp” là tuỳ chọn.
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="text-sm text-rose-700">{error}</p>
            </div>
          )}

          {entries && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-700">
                Tìm thấy {entries.length} học sinh
              </p>
              {entries.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Không có dòng hợp lệ nào. Kiểm tra lại tên cột trong tệp.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Mã HS</th>
                        <th className="px-3 py-2 font-semibold">Họ và tên</th>
                        <th className="px-3 py-2 font-semibold">Lớp</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {entries.map((entry) => (
                        <tr key={entry.student_code}>
                          <td className="px-3 py-1.5 font-mono text-xs">{entry.student_code}</td>
                          <td className="px-3 py-1.5">{entry.full_name}</td>
                          <td className="px-3 py-1.5 text-slate-500">{entry.class_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || !entries || entries.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {isSaving && <Loader2 size={15} className="animate-spin" />}
            {isSaving ? 'Đang lưu…' : `Lưu ${entries?.length ?? 0} học sinh`}
          </button>
        </div>
      </div>
    </div>
  );
}
