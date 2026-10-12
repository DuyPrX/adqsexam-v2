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
        {/* Atmospheric landscape background */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
        >
          {/* Soft-focus background image - clear, vivid, and recognizable */}
          <div
            className="absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{
              backgroundImage: 'url(/teacher-bg.jpg)',
              filter: 'blur(2.5px)',
              transform: 'scale(1.03)',
              opacity: 0.85,
            }}
          />
          {/* Delicate light wash for pristine UI contrast and legibility */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/30 via-white/15 to-white/35" />
        </div>

        {/* Interactive content layer */}
        <div className="relative z-10 min-h-screen">
          {children}
        </div>
      </body>
    </html>
  );
}
