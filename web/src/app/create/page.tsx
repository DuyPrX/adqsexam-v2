'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { UploadZone } from '@/components/UploadZone';
import { ExamPreviewEditor } from '@/components/questions/ExamPreviewEditor';
import type { ExtractionResponse } from '@/lib/types';

/**
 * Create-exam flow: UploadZone transitions into ExamPreviewEditor once the
 * Worker returns a question set.
 */
export default function CreateExamPage() {
  const [extraction, setExtraction] = useState<ExtractionResponse | null>(null);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <ArrowLeft size={15} />
          Quay lại
        </Link>
        <h1 className="text-lg font-bold text-slate-900">Tạo đề thi từ tệp DOCX</h1>
      </div>

      {extraction ? (
        <ExamPreviewEditor
          questions={extraction.data}
          engineUsed={extraction.engine_used ?? 'rule'}
          mode={extraction.meta?.mode ?? 'auto'}
          sourceFilename={extraction.meta?.filename ?? 'de-thi.docx'}
          correctSpansDetected={extraction.meta?.correct_spans_detected ?? 0}
          fallbackReason={extraction.meta?.fallback_reason ?? null}
          missedTrueFalse={extraction.meta?.missed_true_false ?? false}
          onReset={() => setExtraction(null)}
        />
      ) : (
        <UploadZone onExtracted={setExtraction} />
      )}
    </main>
  );
}
