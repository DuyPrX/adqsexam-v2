import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ADQS Exam — Bảng điều khiển giáo viên',
  description: 'Tạo đề, quản lý học sinh và xem kết quả thi trực tuyến.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className="relative min-h-screen bg-slate-50 text-slate-900 antialiased selection:bg-rose-500 selection:text-white">
        {/* Atmospheric blurred landscape background */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
        >
          {/* Blurred background image with scale to avoid edge clipping */}
          <div
            className="absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{
              backgroundImage: 'url(/teacher-bg.jpg)',
              filter: 'blur(12px)',
              transform: 'scale(1.06)',
              opacity: 0.22,
            }}
          />
          {/* Subtle luminous warm overlay for text legibility and function clarity */}
          <div className="absolute inset-0 bg-gradient-to-b from-slate-50/75 via-slate-50/60 to-slate-50/85" />
        </div>

        {/* Interactive content layer */}
        <div className="relative z-10 min-h-screen">
          {children}
        </div>
      </body>
    </html>
  );
}
