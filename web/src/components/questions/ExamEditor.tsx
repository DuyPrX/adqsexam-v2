'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Plus, Save, ShieldAlert } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  PersistenceError,
  updateExamMetadata,
  updateExamQuestionsSafe,
} from '@/lib/exams';
import type { ExamRow, ExtractedQuestion, QuestionBankRow, QuestionType } from '@/lib/types';
import { cn, hasResolvedAnswer } from '@/lib/utils';
import { QuestionCard } from './QuestionCard';

interface ExamEditorProps {
  exam: ExamRow;
  initialQuestions: QuestionBankRow[];
  /** Number of submitted results; > 0 locks the question structure. */
  submissionCount: number;
}

/** ISO timestamp -> value accepted by <input type="datetime-local"> (local time). */
function toDateTimeLocal(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** datetime-local value -> ISO string, or null when cleared. */
function fromDateTimeLocal(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A blank MULTIPLE_CHOICE template appended by "Thêm câu hỏi mới". */
function blankQuestion(position: number): ExtractedQuestion {
  return {
    position,
    question_type: 'MULTIPLE_CHOICE',
    question_text: '',
    options: ['', '', '', ''],
    correct_answer: null,
    explanation: null,
  };
}

function toEditable(rows: QuestionBankRow[]): ExtractedQuestion[] {
  return rows.map((row, index) => ({
    position: index + 1,
    question_type: row.question_type as QuestionType,
    question_text: row.question_text,
    options: Array.isArray(row.options) ? row.options : [],
    correct_answer: row.correct_answer,
    explanation: row.explanation,
  }));
}

/**
 * ExamEditor — Phase 5.4 post-creation editor.
 *
 * General metadata is written straight to `exams`; the question list is saved
 * through `update_exam_questions_safe`, which enforces the submissions guard
 * server-side. When `submissionCount > 0` the UI additionally locks the
 * structural actions (add / delete) so the teacher is not led into a rejected
 * save.
 */
export function ExamEditor({ exam, initialQuestions, submissionCount }: ExamEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(exam.title);
  const [durationMinutes, setDurationMinutes] = useState(exam.duration_minutes);
  const [isActive, setIsActive] = useState(exam.is_active);
  const [startsAt, setStartsAt] = useState(toDateTimeLocal(exam.starts_at));
  const [endsAt, setEndsAt] = useState(toDateTimeLocal(exam.ends_at));
  const [questions, setQuestions] = useState<ExtractedQuestion[]>(() =>
    toEditable(initialQuestions),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const locked = submissionCount > 0;

  const unresolved = useMemo(
    () => questions.filter((question) => !hasResolvedAnswer(question)).length,
    [questions],
  );

  // A starts_at later than ends_at is always a mistake; catch it client-side too.
  const windowInvalid =
    startsAt.trim() !== '' && endsAt.trim() !== '' && new Date(startsAt) > new Date(endsAt);

  const updateQuestion = (index: number, patch: Partial<ExtractedQuestion>) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const addQuestion = () => {
    setQuestions((prev) => [...prev, blankQuestion(prev.length + 1)]);
  };

  const deleteQuestion = (index: number) => {
    setQuestions((prev) =>
      prev.filter((_, i) => i !== index).map((q, i) => ({ ...q, position: i + 1 })),
    );
  };

  const handleSave = async () => {
    setError(null);

    if (windowInvalid) {
      setError('Thời gian bắt đầu phải trước thời gian kết thúc.');
      return;
    }

    setIsSaving(true);
    try {
      const supabase = createClient();

      await updateExamMetadata(supabase, exam.code, {
        title,
        durationMinutes,
        isActive,
        startsAt: fromDateTimeLocal(startsAt),
        endsAt: fromDateTimeLocal(endsAt),
      });

      await updateExamQuestionsSafe(supabase, exam.code, questions);

      setSavedAt(Date.now());
      router.refresh();
    } catch (err) {
      setError(
        err instanceof PersistenceError ? err.message : 'Không lưu được thay đổi. Vui lòng thử lại.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* General info */}
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Thông tin đề thi
        </h2>

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

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Mở từ (tuỳ chọn)
            </label>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Đến (tuỳ chọn)
            </label>
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          Để trống nghĩa là không giới hạn ở mốc đó. Học sinh chỉ đăng nhập được trong khoảng thời
          gian này.
        </p>

        <label className="flex items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="accent-slate-900"
          />
          <span className={cn('font-semibold', isActive ? 'text-emerald-700' : 'text-slate-500')}>
            {isActive ? 'Đang mở nhận thí sinh' : 'Đang đóng'}
          </span>
        </label>
      </div>

      {/* Submission guard notice */}
      {locked && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            Đề thi đã có <strong>{submissionCount}</strong> lượt nộp bài, chỉ có thể sửa nội dung
            câu hỏi.
          </p>
        </div>
      )}

      {/* Question list */}
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Danh sách câu hỏi ({questions.length})
          </h2>
          <button
            type="button"
            onClick={addQuestion}
            disabled={locked}
            title={locked ? 'Không thể thêm câu hỏi sau khi đã có bài nộp.' : undefined}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={15} />
            Thêm câu hỏi mới
          </button>
        </div>

        {unresolved > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800">
              Còn <strong>{unresolved}</strong> câu chưa có đáp án.
            </p>
          </div>
        )}

        {questions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            Đề thi chưa có câu hỏi nào. Hãy thêm câu hỏi mới.
          </p>
        ) : (
          <div className="space-y-2">
            {questions.map((question, index) => (
              <QuestionCard
                key={index}
                question={question}
                index={index}
                expanded={expandedIndex === index}
                onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
                onChange={(patch) => updateQuestion(index, patch)}
                onDelete={() => deleteQuestion(index)}
                deleteDisabled={locked}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      {savedAt && !error && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Đã lưu thay đổi.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(`/exams/${exam.code}/results`)}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Xem kết quả
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {isSaving ? 'Đang lưu…' : 'Lưu thay đổi'}
        </button>
      </div>
    </div>
  );
}
