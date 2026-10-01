'use client';

import { Check, CircleSlash, Info } from 'lucide-react';
import type { ExtractedQuestion, QuestionType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Per-type answer-key override controls.
 *
 * Extraction is best-effort: the rule engine cannot resolve a question whose
 * options carry no bold/underline/red marking, and the AI fallback may return
 * `null` when it is unsure. The teacher is the final authority, so every type
 * gets an explicit manual key editor — including a "no correct answer" state.
 */

export const TRUE_FALSE_ITEMS = ['Đ', 'S'] as const;
export type TrueFalseValue = (typeof TRUE_FALSE_ITEMS)[number];

interface Props {
  question: ExtractedQuestion;
  onChange: (patch: Partial<ExtractedQuestion>) => void;
}

/* -------------------------------------------------------------------------- */

/** MCQ: radio buttons over the option list, plus an "unanswered" reset. */
function McqKeyEditor({ question, onChange }: Props) {
  const current = typeof question.correct_answer === 'number' ? question.correct_answer : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Đáp án đúng
        </span>
        <button
          type="button"
          onClick={() => onChange({ correct_answer: null })}
          disabled={current === null}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
        >
          <CircleSlash size={12} />
          Bỏ đáp án
        </button>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {question.options.map((option, index) => {
          const selected = current === index;
          const letter = String.fromCharCode(65 + index);
          return (
            <label
              key={index}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-sm transition',
                selected
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
              )}
            >
              <input
                type="radio"
                name={`mcq-${question.position}`}
                className="mt-0.5 accent-emerald-600"
                checked={selected}
                onChange={() => onChange({ correct_answer: index })}
              />
              <span className="flex-1 leading-snug">
                <span className="mr-1 font-semibold">{letter}.</span>
                {option || <em className="text-slate-400">(trống)</em>}
              </span>
            </label>
          );
        })}

        {question.options.length === 0 && (
          <p className="text-sm text-amber-700">
            Câu hỏi chưa có phương án nào. Hãy thêm phương án ở phần nội dung.
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** TRUE_FALSE: a Đ/S toggle per sub-item (a-d). */
function TrueFalseKeyEditor({ question, onChange }: Props) {
  const answers = Array.isArray(question.correct_answer)
    ? (question.correct_answer as string[])
    : [];
  const itemCount = Math.max(question.options.length, 4);

  const setItem = (index: number, value: TrueFalseValue) => {
    const next = Array.from({ length: itemCount }, (_, i) => answers[i] ?? '');
    // Toggle off when the same value is clicked twice.
    next[index] = next[index] === value ? '' : value;
    onChange({ correct_answer: next.every((v) => v === '') ? null : next });
  };

  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Đáp án Đúng / Sai cho từng ý
      </span>

      <div className="space-y-1.5">
        {Array.from({ length: itemCount }, (_, index) => {
          const statement = question.options[index] ?? '';
          const value = answers[index] ?? '';
          return (
            <div
              key={index}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
            >
              <span className="w-4 shrink-0 text-sm font-semibold text-slate-500">
                {String.fromCharCode(97 + index)}
              </span>
              <span className="flex-1 text-sm leading-snug text-slate-700">
                {statement || <em className="text-slate-400">(chưa có nội dung ý)</em>}
              </span>
              <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-200">
                {TRUE_FALSE_ITEMS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setItem(index, item)}
                    className={cn(
                      'px-3 py-1 text-xs font-bold transition',
                      value === item
                        ? item === 'Đ'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-rose-600 text-white'
                        : 'bg-white text-slate-500 hover:bg-slate-100',
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** SHORT_ANSWER: a free-text accepted answer (normalized at grading time). */
function ShortAnswerKeyEditor({ question, onChange }: Props) {
  const current = typeof question.correct_answer === 'string' ? question.correct_answer : '';

  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Đáp án được chấp nhận
      </span>
      <input
        type="text"
        value={current}
        onChange={(event) =>
          onChange({ correct_answer: event.target.value.trim() === '' ? null : event.target.value })
        }
        placeholder="Ví dụ: 1.5"
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
      />
      <p className={cn('text-[11px] text-slate-500')}>
        Hệ thống so khớp sau khi chuẩn hoá: bỏ khoảng trắng, chữ thường, dấu phẩy → dấu chấm.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** ESSAY: informational only — never auto-graded (F3). */
function EssayKeyNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2">
      <Info size={15} className="mt-0.5 shrink-0 text-purple-600" />
      <p className="text-sm text-purple-800">
        Tự luận — Chấm thủ công sau khi thi. Bài làm sẽ được lưu lại và đánh dấu
        “cần chấm” cho giáo viên.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function AnswerKeyEditor({ question, onChange }: Props) {
  const type: QuestionType = question.question_type;

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      {type === 'MULTIPLE_CHOICE' && <McqKeyEditor question={question} onChange={onChange} />}
      {type === 'TRUE_FALSE' && <TrueFalseKeyEditor question={question} onChange={onChange} />}
      {type === 'SHORT_ANSWER' && <ShortAnswerKeyEditor question={question} onChange={onChange} />}
      {type === 'ESSAY' && <EssayKeyNotice />}
    </div>
  );
}

/** Small status chip shown in the editor header. */
export function AnswerStatusChip({ resolved }: { resolved: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        resolved ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700',
      )}
    >
      {resolved ? <Check size={11} /> : <Info size={11} />}
      {resolved ? 'Đã có đáp án' : 'Chưa có đáp án'}
    </span>
  );
}
