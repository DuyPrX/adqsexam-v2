'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Link2, QrCode, X } from 'lucide-react';
import QRCode from 'qrcode';
import { resolveStudentAppBaseUrl } from '@/lib/env';

interface ExamShareModalProps {
  exam: { code: string; title: string };
  isOpen: boolean;
  onClose: () => void;
}

/** Strips characters that are illegal in a filename on Windows/macOS. */
function toSafeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned || 'De_thi';
}

/**
 * Builds the student join link for an exam code.
 *
 * The student SPA is a static bundle served from a directory root with no
 * client-side router, so the link targets its INDEX and carries the code as
 * `?code=` — exactly the parameter `prefillFromUrl()` reads. A path prefix such
 * as `/exam/` would 404.
 *
 * The SPA's origin comes from `NEXT_PUBLIC_STUDENT_APP_URL` (see lib/env.ts),
 * because it is a separate deployment; the current origin is the documented
 * local-development fallback.
 */
function buildStudentUrl(code: string): string {
  const base = resolveStudentAppBaseUrl();
  return base ? `${base}/?code=${code}` : `/?code=${code}`;
}

/**
 * Exam share / QR modal (Phase 8.1).
 *
 * The QR is generated as a data URL at a fixed high resolution rather than being
 * drawn at display size, so the "Tải ảnh mã QR" download stays scannable when a
 * teacher pastes it into a slide or prints it for the classroom wall.
 */
export function ExamShareModal({ exam, isOpen, onClose }: ExamShareModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const studentUrl = useMemo(() => buildStudentUrl(exam.code), [exam.code]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setQrFailed(false);

    QRCode.toDataURL(studentUrl, {
      width: 1024,
      margin: 2,
      // Level M tolerates a projector's scaling/compression; H would inflate the
      // module count without a practical benefit at this size.
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
          setQrFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, studentUrl]);

  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(handle);
  }, [copied]);

  if (!isOpen) return null;

  const copy = async (value: string, which: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
    } catch {
      // Clipboard access needs a secure context; on plain HTTP the teacher can
      // still select the text manually, so this is not surfaced as an error.
    }
  };

  const downloadQr = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.href = qrDataUrl;
    link.download = `QR_${exam.code}_${toSafeFilename(exam.title)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <QrCode size={17} />
              Chia sẻ đề thi
            </h2>
            <p className="text-xs text-slate-500">{exam.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Exam code */}
          <div className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Mã đề thi
            </span>
            <div className="flex items-center gap-2">
              <span className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-lg font-bold tracking-widest text-slate-900">
                {exam.code}
              </span>
              <button
                type="button"
                onClick={() => void copy(exam.code, 'code')}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                {copied === 'code' ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                {copied === 'code' ? 'Đã chép' : 'Sao chép'}
              </button>
            </div>
          </div>

          {/* Direct link */}
          <div className="space-y-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Link2 size={13} />
              Liên kết trực tiếp cho học sinh
            </span>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {studentUrl}
              </span>
              <button
                type="button"
                onClick={() => void copy(studentUrl, 'link')}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                {copied === 'link' ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                {copied === 'link' ? 'Đã chép' : 'Sao chép'}
              </button>
            </div>
          </div>

          {/* QR */}
          <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 p-4">
            {qrFailed ? (
              <p className="py-8 text-center text-sm text-slate-500">
                Không tạo được mã QR. Học sinh vẫn có thể nhập mã đề thủ công.
              </p>
            ) : qrDataUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element -- a generated data URL has no loader/optimisation benefit. */
              <img
                src={qrDataUrl}
                alt={`Mã QR cho đề thi ${exam.code}`}
                width={200}
                height={200}
                className="rounded-lg bg-white p-2"
              />
            ) : (
              <div className="h-[200px] w-[200px] animate-pulse rounded-lg bg-slate-200" />
            )}
            <p className="text-center text-xs text-slate-500">
              Học sinh quét mã để vào thẳng phòng làm bài.
            </p>
            <button
              type="button"
              onClick={downloadQr}
              disabled={!qrDataUrl}
              className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              <Download size={15} />
              Tải ảnh mã QR (.PNG)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
