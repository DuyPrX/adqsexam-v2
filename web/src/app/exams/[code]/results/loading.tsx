/**
 * Loading skeleton for the exam results route (Phase 5.3 §3).
 *
 * Mirrors the real layout (header, KPI strip, table) so the swap is visually
 * stable — no layout shift when the data lands.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl animate-pulse space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="h-9 w-24 rounded-lg bg-slate-100" />
        <div className="space-y-2">
          <div className="h-5 w-56 rounded bg-slate-200" />
          <div className="h-3 w-32 rounded bg-slate-100" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="h-3 w-24 rounded bg-slate-100" />
            <div className="mt-3 h-7 w-16 rounded bg-slate-200" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="h-10 bg-slate-50" />
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 border-t border-slate-100 px-3 py-3">
            <div className="h-4 w-12 rounded bg-slate-100" />
            <div className="h-4 flex-1 rounded bg-slate-100" />
            <div className="h-4 w-20 rounded bg-slate-100" />
            <div className="h-4 w-16 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </main>
  );
}
