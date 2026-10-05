'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { PersistenceError } from '@/lib/exams';
import {
  createTreeSession,
  TREE_SESSION_DEFAULTS,
  TREE_SIMILARITY_MAX,
  TREE_SIMILARITY_MIN,
} from '@/lib/tree';
import type { ClassRow } from '@/lib/types';

interface CreateTreeSessionModalProps {
  klass: ClassRow;
  onClose: () => void;
}

/**
 * "🌱 Bắt đầu Cây Tri Thức" launcher (Phase 7.3).
 *
 * Submits then redirects straight to the projector: the teacher's next action
 * after creating a live activity is always to display it, so an intermediate
 * "created successfully" screen would only be a step to click through.
 */
export function CreateTreeSessionModal({ klass, onClose }: CreateTreeSessionModalProps) {
  const router = useRouter();
  const [title, setTitle] = useState(`Cây Tri Thức — ${klass.name}`);
  const [question, setQuestion] = useState('');
  const [minWords, setMinWords] = useState<number>(TREE_SESSION_DEFAULTS.minWords);
  const [timeLimit, setTimeLimit] = useState<number>(TREE_SESSION_DEFAULTS.timeLimitMinutes);
  // The slider works in whole percent; the DB stores a 0-1 numeric.
  const [similarityPercent, setSimilarityPercent] = useState(
    Math.round(TREE_SESSION_DEFAULTS.maxSimilarity * 100),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const created = await createTreeSession(createClient(), {
        class_id: klass.id,
        title,
        question_text: question,
        min_words: minWords,
        time_limit_minutes: timeLimit,
        max_similarity: similarityPercent / 100,
      });
      router.push(`/tree/${created.id}`);
    } catch (err) {
      setError(err instanceof PersistenceError ? err.message : 'Không tạo được hoạt động.');
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">🌱 Bắt đầu Cây Tri Thức</h2>
            <p className="text-xs text-slate-500">
              Lớp {klass.name} — {klass.member_count ?? 0} học sinh
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

        <div className="space-y-4 p-4">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Tiêu đề</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Câu hỏi thảo luận</span>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={4}
              placeholder="VD: Theo em, tri thức là gì và nó được hình thành như thế nào?"
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Số từ tối thiểu</span>
              <input
                type="number"
                min={1}
                value={minWords}
                onChange={(event) => setMinWords(Number(event.target.value))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">Thời gian (phút)</span>
              <input
                type="number"
                min={1}
                value={timeLimit}
                onChange={(event) => setTimeLimit(Number(event.target.value))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>Ngưỡng trùng lặp</span>
              <span className="font-mono text-slate-900">{similarityPercent}%</span>
            </span>
            <input
              type="range"
              min={Math.round(TREE_SIMILARITY_MIN * 100)}
              max={Math.round(TREE_SIMILARITY_MAX * 100)}
              step={5}
              value={similarityPercent}
              onChange={(event) => setSimilarityPercent(Number(event.target.value))}
              className="w-full accent-slate-900"
            />
            <span className="block text-xs text-slate-500">
              Câu trả lời giống hơn mức này sẽ bị coi là trùng lặp và từ chối.
            </span>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="text-sm text-rose-700">{error}</p>
            </div>
          )}
        </div>

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
            onClick={() => void handleSubmit()}
            disabled={isSaving || !title.trim() || !question.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {isSaving && <Loader2 size={15} className="animate-spin" />}
            {isSaving ? 'Đang tạo…' : 'Bắt đầu ngay'}
          </button>
        </div>
      </div>
    </div>
  );
}
