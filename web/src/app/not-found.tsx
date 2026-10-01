import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Không tìm thấy trang</h1>
      <p className="text-sm text-slate-500">
        Đường dẫn không tồn tại, hoặc bạn không có quyền truy cập đề thi này.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
      >
        Về bảng điều khiển
      </Link>
    </main>
  );
}
