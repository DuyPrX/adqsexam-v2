'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Loader2,
  Save,
  Shuffle,
  Sparkles,
  Zap,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  PersistenceError,
  saveExam,
  saveExamVariants,
  type SaveExamVariantsResult,
} from '@/lib/exams';
import { generateExamVariants, shuffleExam } from '@/lib/shuffle';
import type {
  EngineUsed,
  ExtractedQuestion,
  ExtractionMode,
  QuestionType,
} from '@/lib/types';
import { QUESTION_TYPE_META, cn, hasResolvedAnswer } from '@/lib/utils';
import { QuestionCard } from './QuestionCard';

interface ExamPreviewEditorProps {
  questions: ExtractedQuestion[];
  engineUsed: EngineUsed;
  mode: ExtractionMode;
  sourceFilename: string;
  correctSpansDetected: number;
  fallbackReason: string | null;
  /** Phase 5.6: the document declares a True/False section but none was parsed. */
  missedTrueFalse: boolean;
  onReset: () => void;
}

/** Human-readable explanation of a Phase 5.6 linter trigger. */
const FALLBACK_REASON_LABELS: Record<string, string> = {
  NO_QUESTIONS_FOUND: 'không tìm thấy câu hỏi',
  LOW_ANSWER_RATIO: 'quá ít đáp án được nhận diện',
  MISSED_TRUE_FALSE_SECTION: 'bỏ sót phần Đúng/Sai',
  ANSWER_TEXT_LEAK: 'lộ nội dung đáp án',
};

/** Selectable variant counts (Phase 5.4). */
const VARIANT_COUNT_OPTIONS = [1, 2, 4, 8] as const;

/**
 * ExamPreviewEditor — the Phase 3 critical deliverable.
 *
 * Shows every extracted question with a type badge, allows inline editing of the
 * text / options / explanation, and provides per-type answer-key overrides so a
 * teacher can repair questions the engines could not resolve. Saving generates
 * the exam code and bulk-inserts into `exams` + `question_bank`.
 */
export function ExamPreviewEditor({
  questions: initialQuestions,
  engineUsed,
  mode,
  sourceFilename,
  correctSpansDetected,
  fallbackReason,
  missedTrueFalse,
  onReset,
}: ExamPreviewEditorProps) {
  const router = useRouter();
  const [questions, setQuestions] = useState<ExtractedQuestion[]>(initialQuestions);
  const [title, setTitle] = useState(sourceFilename.replace(/\.docx$/i, ''));
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCode, setSavedCode] = useState<string | null>(null);

  // Multi-variant generation (Phase 5.4).
  const [variantCount, setVariantCount] = useState<number>(1);
  const [questionsPerVariant, setQuestionsPerVariant] = useState<number>(
    initialQuestions.length,
  );
  const [shuffleDistractors, setShuffleDistractors] = useState(false);
  const [allowPractice, setAllowPractice] = useState(false);
  const [savedVariants, setSavedVariants] = useState<SaveExamVariantsResult | null>(null);

  const stats = useMemo(() => {
    const byType = new Map<QuestionType, number>();
    let unresolved = 0;
    for (const question of questions) {
      byType.set(question.question_type, (byType.get(question.question_type) ?? 0) + 1);
      if (!hasResolvedAnswer(question)) unresolved++;
    }
    return { byType, unresolved, total: questions.length };
  }, [questions]);

  // K can never exceed the pool, and it shrinks with it when a question is deleted.
  const effectiveK = Math.min(questionsPerVariant, questions.length || 1);

  const updateQuestion = (index: number, patch: Partial<ExtractedQuestion>) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const deleteQuestion = (index: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
    setExpandedIndex(null);
  };

  const handleShuffle = () => {
    setQuestions((prev) => shuffleExam(prev));
    setExpandedIndex(null);
  };

  const handleSave = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const supabase = createClient();

      if (variantCount > 1) {
        const variants = generateExamVariants(questions, {
          variantCount,
          questionCountPerExam: effectiveK,
          shuffleDistractors,
        });
        const result = await saveExamVariants(supabase, {
          durationMinutes,
          allowPractice,
          variants: variants.map((variant) => ({
            code: variant.code,
            title,
            questions: variant.questions,
          })),
        });
        setSavedVariants(result);
      } else {
        const { exam, savedQuestions } = await saveExam(supabase, {
          title,
          durationMinutes,
          allowPractice,
          questions,
        });
        setSavedCode(`${exam.code} (${savedQuestions} câu hỏi)`);
      }
    } catch (err) {
      setError(
        err instanceof PersistenceError ? err.message : 'Không lưu được đề thi. Vui lòng thử lại.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  /* ------------------------------------------------------- multi-variant success */
  if (savedVariants) {
    return (
      <div className="mx-auto max-w-lg space-y-4 rounded-xl border border-emerald-200 bg-white p-8 text-center shadow-sm">
        <Copy size={44} className="mx-auto text-emerald-500" />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Đã lưu {savedVariants.codes.length} mã đề
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Mỗi mã đề bốc {effectiveK}/{questions.length} câu hỏi
            {shuffleDistractors ? ', đảo thứ tự phương án' : ''}.
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {savedVariants.codes.map((code) => (
              <span
                key={code}
                className="rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-sm font-bold text-slate-900"
              >
                {code}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Hãy gửi các mã này cho học sinh. Tiếp theo, tải lên danh sách thí sinh được phép dự thi.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => router.push('/')}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Về bảng điều khiển
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Tạo đề khác
          </button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- success */
  if (savedCode) {
    return (
      <div className="mx-auto max-w-lg space-y-4 rounded-xl border border-emerald-200 bg-white p-8 text-center shadow-sm">
        <CheckCircle2 size={44} className="mx-auto text-emerald-500" />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Đã lưu đề thi</h2>
          <p className="mt-1 text-sm text-slate-600">
            Mã đề: <span className="font-mono text-base font-bold text-slate-900">{savedCode}</span>
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Hãy gửi mã này cho học sinh. Tiếp theo, tải lên danh sách thí sinh được phép dự thi.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => router.push('/')}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Về bảng điều khiển
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Tạo đề khác
          </button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- editor */
  return (
    <div className="space-y-4">
      {/* Extraction report */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
          {engineUsed === 'rule' ? <Zap size={12} /> : <Sparkles size={12} />}
          {engineUsed === 'rule'
            ? 'Engine 1 — Rule-based'
            : engineUsed === 'ai_fallback'
              ? 'Engine 2 — AI (tự động)'
              : 'Engine 2 — AI'}
        </span>
        {/* Phase 5.6 §3 — explain why the slow path ran on an `auto` upload. */}
        {engineUsed === 'ai_fallback' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2.5 py-1 font-semibold text-purple-700">
            <Sparkles size={12} />
            Đã tự động tối ưu hóa qua AI
            {fallbackReason
              ? ` (Lý do: ${FALLBACK_REASON_LABELS[fallbackReason] ?? fallbackReason})`
              : ''}
          </span>
        )}
        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
          Chế độ: {mode}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
          {stats.total} câu hỏi
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
          {correctSpansDetected} vùng đánh dấu đáp án
        </span>
        {Array.from(stats.byType.entries()).map(([type, count]) => (
          <span
            key={type}
            className={cn(
              'rounded-full px-2.5 py-1 font-semibold ring-1 ring-inset',
              QUESTION_TYPE_META[type].badge,
            )}
          >
            {QUESTION_TYPE_META[type].short}: {count}
          </span>
        ))}
        {/* The friendly ai_fallback badge already renders this reason; only show
            the raw code when the fallback was attempted but did NOT take over
            (e.g. the AI call failed and Engine 1's result was kept). */}
        {fallbackReason && engineUsed !== 'ai_fallback' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-700">
            <AlertTriangle size={12} />
            {fallbackReason}
          </span>
        )}
      </div>

      {/* Phase 5.6 §3 — actionable alert when a declared Đúng/Sai section was
          not recovered. Shown in every mode, since mode=rule never retries. */}
      {missedTrueFalse && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-800">
            <p className="font-semibold">Không tìm thấy câu hỏi Đúng/Sai nào.</p>
            <p className="mt-0.5">
              Nếu đề có Phần II, hãy thử quét lại bằng chế độ{' '}
              <strong>&lsquo;AI nâng cao&rsquo;</strong>.
            </p>
          </div>
        </div>
      )}

      {/* Exam metadata + action bar */}
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Tên đề thi
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Thời gian (phút)
            </label>
            <input
              type="number"
              min={1}
              max={300}
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(Math.max(1, Number(event.target.value) || 1))}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
        </div>

        {stats.unresolved > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800">
              Còn <strong>{stats.unresolved}</strong> câu chưa có đáp án. Hãy bổ sung đáp án đúng
              trước khi lưu, nếu không học sinh sẽ không được tính điểm cho các câu này.
            </p>
          </div>
        )}

        {/* Multi-variant generation */}
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex items-center gap-1.5">
            <Copy size={14} className="text-slate-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Sinh nhiều mã đề
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600">Số lượng mã đề</label>
              <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white">
                {VARIANT_COUNT_OPTIONS.map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setVariantCount(count)}
                    className={cn(
                      'flex-1 px-3 py-1.5 text-sm font-semibold transition',
                      variantCount === count
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100',
                    )}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-600">
                Số câu mỗi mã đề (K)
              </label>
              <input
                type="number"
                min={1}
                max={Math.max(1, questions.length)}
                value={effectiveK}
                onChange={(event) =>
                  setQuestionsPerVariant(
                    Math.min(
                      Math.max(1, Number(event.target.value) || 1),
                      Math.max(1, questions.length),
                    ),
                  )
                }
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none transition focus:border-slate-400"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={shuffleDistractors}
              onChange={(event) => setShuffleDistractors(event.target.checked)}
              className="accent-slate-900"
            />
            Đảo thứ tự phương án A/B/C/D (tự động đồng bộ đáp án đúng)
          </label>

          {/* Phase 5.8: opt-in only. An exam created for an official sitting must
              not hand its answer keys to the student runtime unless the teacher
              explicitly allows it here. */}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={allowPractice}
              onChange={(event) => setAllowPractice(event.target.checked)}
              className="accent-slate-900"
            />
            Cho phép dùng để luyện tập (học sinh xem được đáp án &amp; giải thích)
          </label>

          <p className="text-[11px] text-slate-500">
            {variantCount > 1
              ? `Mỗi mã đề sẽ bốc ngẫu nhiên ${effectiveK} trên tổng số ${questions.length} câu hỏi và tạo mã đề riêng.`
              : `Một mã đề duy nhất với toàn bộ ${questions.length} câu hỏi theo thứ tự hiện tại.`}
          </p>
        </div>

        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <ArrowLeft size={15} />
            Chọn tệp khác
          </button>

          <button
            type="button"
            onClick={handleShuffle}
            disabled={questions.length < 2}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Shuffle size={15} />
            Đảo câu hỏi & phương án
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {isSaving
              ? 'Đang lưu…'
              : variantCount > 1
                ? `Lưu ${variantCount} mã đề`
                : 'Lưu đề thi'}
          </button>
        </div>
      </div>

      {/* Question list */}
      {questions.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
          <p className="text-sm text-slate-600">
            Không còn câu hỏi nào. Hãy chọn tệp khác để trích xuất lại.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {questions.map((question, index) => (
            <QuestionCard
              key={`${question.position}-${index}`}
              question={question}
              index={index}
              expanded={expandedIndex === index}
              onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
              onChange={(patch) => updateQuestion(index, patch)}
              onDelete={() => deleteQuestion(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
