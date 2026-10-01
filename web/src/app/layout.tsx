import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ADQS Exam — Bảng điều khiển giáo viên',
  description: 'Tạo đề, quản lý học sinh và xem kết quả thi trực tuyến.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
