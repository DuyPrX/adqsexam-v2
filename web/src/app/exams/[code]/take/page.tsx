import { redirect } from 'next/navigation';
import { resolveStudentAppBaseUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ code: string }>;
}

/**
 * Public student test-taking redirect route (/exams/[code]/take).
 * Redirects the browser directly to the student quiz-taking interface with ?code=.
 */
export default async function ExamsTakeRedirectPage({ params }: PageProps) {
  const { code } = await params;
  const studentBase = resolveStudentAppBaseUrl();
  const target = studentBase
    ? `${studentBase}/?code=${encodeURIComponent(code)}`
    : `/?code=${encodeURIComponent(code)}`;
  redirect(target);
}
