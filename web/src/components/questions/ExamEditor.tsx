'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, BookOpen, Loader2, Plus, Save, Share2, ShieldAlert, UserCheck } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  PersistenceError,
  updateExamMetadata,
  updateExamQuestionsSafe,
} from '@/lib/exams';
import { importClassToExam } from '@/lib/classes';
import {
  DEFAULT_SECURITY_CONFIG,
  type ExamRow,
  type ExamSecurityConfig,
  type ExtractedQuestion,
  type PinMode,
  type QuestionBankRow,
  type QuestionType,
} from '@/lib/types';
import { cn, hasResolvedAnswer } from '@/lib/utils';
import { toLocalDatetimeString, toUtcIsoString } from '@/lib/date';
import { DeleteExamDialog } from '@/components/DeleteExamDialog';
import { ClassPickerModal } from '@/components/ClassPickerModal';
import { ExamShareModal } from '@/components/ExamShareModal';
import { QuestionCard } from './QuestionCard';
import { PinPolicyControl } from './PinPolicyControl';
import { SecurityPolicyControl } from './SecurityPolicyControl';
import { ExamCandidatesManager } from './ExamCandidatesManager';

interface ExamEditorProps {
  exam: ExamRow;
  initialQuestions: QuestionBankRow[];
  /** Number of submitted results; > 0 locks the question structure. */
  submissionCount: number;
}

/**
 * A blank MULTIPLE_CHOICE template appended by "Thêm câu hỏi mới".
 */
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
  const [allowPractice, setAllowPractice] = useState(exam.allow_practice);
  // Phase 8.7 — paper-ordering policy, seeded from the stored value.
  const [shuffleQuestions, setShuffleQuestions] = useState(exam.shuffle_questions);
  // Phase 11.0 — anti-cheat policy, seeded from stored security_config.
  const [securityConfig, setSecurityConfig] = useState<ExamSecurityConfig>(
    () => exam.security_config ?? DEFAULT_SECURITY_CONFIG,
  );
  const [pinMode, setPinMode] = useState<PinMode>(exam.pin_mode);
  const [globalPin, setGlobalPin] = useState(exam.global_pin ?? '');
  const [isClassPickerOpen, setIsClassPickerOpen] = useState(false);
  /** Phase 8.1 — share/QR modal. */
  const [isShareOpen, setIsShareOpen] = useState(false);
  /**
   * Phase 8.1 — which section the editor shows. `questions` keeps the Phase 5.4
   * behaviour; `candidates` mounts the new thí sinh manager. A tab (rather than
   * a stacked section) keeps the page short: both lists can run long.
   */
  const [activeTab, setActiveTab] = useState<'questions' | 'candidates'>('questions');
  const [isImporting, setIsImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState(toLocalDatetimeString(exam.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalDatetimeString(exam.ends_at));
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

  /**
   * Imports additional class rosters into the EXISTING exam (Phase 6.2).
   *
   * Unlike the creation flow there is nothing to wait for: the exam code already
   * exists, so the RPC runs immediately. It upserts by `(student_code,
   * exam_code)`, so re-importing a class updates rather than duplicates.
   */
  const handleImportClasses = async (classIds: string[]) => {
    setImportMessage(null);
    setIsImporting(true);
    try {
      const count = await importClassToExam(createClient(), exam.code, classIds);
      setImportMessage(`Đã nạp ${count} học sinh từ ${classIds.length} lớp vào đề thi.`);
      setIsClassPickerOpen(false);
      router.refresh();
    } catch (err) {
      setImportMessage(
        err instanceof PersistenceError ? err.message : 'Không nạp được danh sách lớp.',
      );
    } finally {
      setIsImporting(false);
    }
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
        allowPractice,
        shuffleQuestions,
        securityConfig,
        pinMode,
        // Only sent in GLOBAL mode: in the other modes the stored value is
        // deliberately left untouched so toggling back restores it.
        globalPin: pinMode === 'GLOBAL' ? globalPin : undefined,
        startsAt: toUtcIsoString(startsAt),
        endsAt: toUtcIsoString(endsAt),
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

        <div className="space-y-2 border-t border-slate-100 pt-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
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

          {/* Phase 5.8: opt-in gate for practice-by-code. Off by default so an
              official sitting never exposes this exam's answer keys. */}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={allowPractice}
              onChange={(event) => setAllowPractice(event.target.checked)}
              className="accent-slate-900"
            />
            <span className={cn('font-semibold', allowPractice ? 'text-emerald-700' : 'text-slate-500')}>
              {allowPractice
                ? 'Cho phép luyện tập (học sinh xem được đáp án)'
                : 'Không cho phép luyện tập'}
            </span>
          </label>

          {/* Phase 8.7 — paper-ordering policy. ON (the default) lets the student
              runtime reorder the paper and group every Đúng/Sai item at the end;
              OFF preserves the authored order verbatim. */}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={shuffleQuestions}
              onChange={(event) => setShuffleQuestions(event.target.checked)}
              className="accent-slate-900"
            />
            <span className={cn('font-semibold', shuffleQuestions ? 'text-emerald-700' : 'text-slate-500')}>
              {shuffleQuestions
                ? 'Xáo trộn câu hỏi (câu Đúng/Sai xếp cuối)'
                : 'Giữ nguyên thứ tự câu hỏi'}
            </span>
          </label>
        </div>

        {/* Phase 6.2 — admission policy for this exam. */}
        <PinPolicyControl
          mode={pinMode}
          globalPin={globalPin}
          onModeChange={setPinMode}
          onGlobalPinChange={setGlobalPin}
          disabled={isSaving}
        />

        {/* Phase 11.0 — anti-cheat policy for this exam. */}
        <SecurityPolicyControl
          config={securityConfig}
          onChange={setSecurityConfig}
          disabled={isSaving}
        />

        {/* Phase 6.2 — import additional class rosters into this exam. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={() => setIsClassPickerOpen(true)}
            disabled={isImporting}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {isImporting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <BookOpen size={15} />
            )}
            📚 Nạp từ Lớp học
          </button>
          {importMessage && (
            <span className="text-xs font-semibold text-slate-600">{importMessage}</span>
          )}
        </div>
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

      {/* Phase 8.1 — questions vs candidates. */}
      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        <button
          type="button"
          onClick={() => setActiveTab('questions')}
          className={cn(
            'flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition',
            activeTab === 'questions'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100',
          )}
        >
          Câu hỏi ({questions.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('candidates')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition',
            activeTab === 'candidates'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100',
          )}
        >
          <UserCheck size={14} />
          Danh sách thí sinh dự thi
        </button>
      </div>

      {activeTab === 'candidates' && <ExamCandidatesManager examCode={exam.code} />}

      {/* Question list */}
      <div className={cn('space-y-3 rounded-xl border border-slate-200 bg-white p-4', activeTab !== 'questions' && 'hidden')}>
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
          onClick={() => setIsShareOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <Share2 size={15} />
          Chia sẻ đề thi
        </button>
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

      {/* Destructive action lives apart from the save flow (Phase 5.5 §3.3). */}
      <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50/50 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-rose-800">Xóa đề thi</p>
          <p className="text-xs text-rose-700">
            {locked
              ? `Đề thi đã có ${submissionCount} bài nộp nên sẽ được chuyển vào thùng rác 7 ngày.`
              : 'Đề thi chưa có bài nộp nên sẽ bị xóa vĩnh viễn.'}
          </p>
        </div>
        <DeleteExamDialog
          examCode={exam.code}
          examTitle={exam.title}
          submissionCount={submissionCount}
          onDeleted={() => router.push('/')}
        />
      </div>

      {isClassPickerOpen && (
        <ClassPickerModal
          isBusy={isImporting}
          onClose={() => setIsClassPickerOpen(false)}
          onConfirm={(classIds) => void handleImportClasses(classIds)}
        />
      )}

      <ExamShareModal
        exam={{ code: exam.code, title: exam.title }}
        isOpen={isShareOpen}
        onClose={() => setIsShareOpen(false)}
      />
    </div>
  );
}
