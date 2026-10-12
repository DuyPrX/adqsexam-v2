'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogIn } from 'lucide-react';
import { signInWithPassword } from '@/lib/supabase/auth';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await signInWithPassword(email, password);
      router.push('/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200/90 bg-white/95 p-6 shadow-md backdrop-blur-sm"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-bold text-slate-900">ADQS Exam</h1>
          <p className="text-sm text-slate-500">Đăng nhập dành cho giáo viên</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Email
          </label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Mật khẩu
          </label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-slate-400"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {isSubmitting ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
          {isSubmitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </main>
  );
}
