/**
 * Route-level loading fallback (Phase 5.3 §3).
 *
 * Deliberately neutral: this file wraps every top-level route including
 * /login, so it must not impersonate the dashboard. Its job is only to give the
 * browser something to paint the instant a navigation starts, instead of
 * holding the previous screen frozen during the server round-trip.
 *
 * Route-specific skeletons live next to their pages (e.g.
 * exams/[code]/results/loading.tsx).
 */
export default function Loading() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-700" />
        <p className="text-sm font-medium text-slate-500">Đang tải…</p>
      </div>
    </main>
  );
}
