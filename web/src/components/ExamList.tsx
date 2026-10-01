'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileText, LogOut, Plus, Users } from 'lucide-react';
import { signOut } from '@/lib/supabase/auth';
import type { ExamRow } from '@/lib/types';

interface ExamListProps {
  exams: ExamRow[];
  counts: Record<string, number>;
  teacherEmail: string | null;
}

/**
 * Exam list table. Kept as a client component so the sign-out action and row
 * links can navigate without a full server round-trip.
 */
export function ExamList({ exams, counts, teacherEmail }: ExamListProps) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await signOut();
      router.push('/login');
      router.refresh();
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Bảng điều khiển</h1>
          <p className="text-sm text-slate-500">
            {teacherEmail ? `Đăng nhập với ${teacherEmail}` : 'Quản lý đề thi của bạn'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/create"
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus size={15} />
            Tạo đề mới
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <LogOut size={15} />
            Đăng xuất
          </button>
        </div>
      </div>

      {exams.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <FileText size={32} className="text-slate-300" />
          <div>
            <p className="font-semibold text-slate-700">Chưa có đề thi nào</p>
            <p className="text-sm text-slate-500">
              Bắt đầu bằng cách tải lên tệp .docx để trích xuất câu hỏi.
            </p>
          </div>
          <Link
            href="/create"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Tạo đề mới
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Mã đề</th>
                  <th className="px-3 py-2.5 font-semibold">Tên đề thi</th>
                  <th className="px-3 py-2.5 font-semibold">Thời gian</th>
                  <th className="px-3 py-2.5 font-semibold">Bài nộp</th>
                  <th className="px-3 py-2.5 font-semibold">Trạng thái</th>
                  <th className="px-3 py-2.5 font-semibold">Ngày tạo</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {exams.map((exam) => (
                  <tr key={exam.id} className="transition hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold">{exam.code}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{exam.title}</td>
                    <td className="px-3 py-2.5 text-slate-500">{exam.duration_minutes} phút</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1 text-slate-700">
                        <Users size={13} className="text-slate-400" />
                        {counts[exam.code] ?? 0}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={
                          exam.is_active
                            ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700'
                            : 'rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'
                        }
                      >
                        {exam.is_active ? 'Đang mở' : 'Đã đóng'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">
                      {new Date(exam.created_at).toLocaleDateString('vi-VN')}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        href={`/exams/${exam.code}/results`}
                        className="text-xs font-semibold text-slate-700 underline-offset-2 transition hover:text-slate-900 hover:underline"
                      >
                        Xem kết quả
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
