'use client';

import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { ExtractedQuestion } from '@/lib/types';
import { QUESTION_TYPE_META, cn, hasResolvedAnswer } from '@/lib/utils';
import { AnswerKeyEditor, AnswerStatusChip } from './AnswerKeyEditor';

interface QuestionCardProps {
  question: ExtractedQuestion;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ExtractedQuestion>) => void;
  onDelete: () => void;
  /** Set when the exam already has submissions — structure is immutable. */
  deleteDisabled?: boolean;
}

/** Max options per question type (TRUE_FALSE is fixed at the 4 sub-items a-d). */
const MAX_OPTIONS: Record<ExtractedQuestion['question_type'], number> = {
  MULTIPLE_CHOICE: 6,
  TRUE_FALSE: 4,
  SHORT_ANSWER: 0,
  ESSAY: 0,
};

export function QuestionCard({
  question,
  index,
  expanded,
  onToggle,
  onChange,
  onDelete,
  deleteDisabled = false,
}: QuestionCardProps) {
  const meta = QUESTION_TYPE_META[question.question_type];
  const resolved = hasResolvedAnswer(question);
  const maxOptions = MAX_OPTIONS[question.question_type];
  const canEditOptions = maxOptions > 0;

  const setOption = (optionIndex: number, value: string) => {
    const options = question.options.slice();
    options[optionIndex] = value;
    onChange({ options });
  };

  const addOption = () => {
    if (question.options.length >= maxOptions) return;
    onChange({ options: [...question.options, ''] });
  };

  const removeOption = (optionIndex: number) => {
    const options = question.options.filter((_, i) => i !== optionIndex);

    // The key is an INDEX: removing an option shifts every later index, so the
    // stored answer must be remapped or it would point at the wrong option.
    let correct_answer = question.correct_answer;
    if (typeof correct_answer === 'number') {
      if (correct_answer === optionIndex) correct_answer = null;
      else if (correct_answer > optionIndex) correct_answer = correct_answer - 1;
    }
    onChange({ options, correct_answer });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-start gap-3 p-3.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white">
          {index + 1}
        </span>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
                meta.badge,
              )}
            >
              {meta.label}
            </span>
            <AnswerStatusChip resolved={resolved} />
          </div>

          {!expanded && (
            <p className="line-clamp-2 text-sm text-slate-700">
              {question.question_text || <em className="text-slate-400">(chưa có nội dung)</em>}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onDelete}
            disabled={deleteDisabled}
            title={deleteDisabled ? 'Không thể xoá câu hỏi sau khi đã có bài nộp.' : 'Xoá câu hỏi'}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            onClick={onToggle}
            title={expanded ? 'Thu gọn' : 'Mở rộng'}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="space-y-3 border-t border-slate-100 p-3.5">
          {/* Question text */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Nội dung câu hỏi
            </label>
            <textarea
              value={question.question_text}
              onChange={(event) => onChange({ question_text: event.target.value })}
              rows={2}
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>

          {/* Options (MCQ + TRUE_FALSE only) */}
          {canEditOptions && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {question.question_type === 'TRUE_FALSE' ? 'Các ý a–d' : 'Phương án'}
                </label>
                {question.options.length < maxOptions && (
                  <button
                    type="button"
                    onClick={addOption}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100"
                  >
                    <Plus size={12} />
                    Thêm
                  </button>
                )}
              </div>

              {question.options.map((option, optionIndex) => (
                <div key={optionIndex} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-sm font-semibold text-slate-500">
                    {question.question_type === 'TRUE_FALSE'
                      ? String.fromCharCode(97 + optionIndex)
                      : String.fromCharCode(65 + optionIndex)}
                  </span>
                  <input
                    type="text"
                    value={option}
                    onChange={(event) => setOption(optionIndex, event.target.value)}
                    className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none transition focus:border-slate-400"
                  />
                  {question.options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeOption(optionIndex)}
                      title="Xoá phương án"
                      className="rounded-md p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Answer key */}
          <AnswerKeyEditor question={question} onChange={onChange} />

          {/* Explanation */}
          <div className="space-y-1.5 border-t border-slate-100 pt-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Giải thích (tuỳ chọn)
            </label>
            <textarea
              value={question.explanation ?? ''}
              onChange={(event) =>
                onChange({ explanation: event.target.value.trim() === '' ? null : event.target.value })
              }
              rows={2}
              placeholder="Không bắt buộc."
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
            />
          </div>
        </div>
      )}
    </div>
  );
}
