'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { VisionQuizArena } from '@/components/games/vision-quiz/VisionQuizArena';
import type { VisionQuizConfig, VisionQuizQuestionItem } from '@/lib/types';
import { DEFAULT_VISION_QUIZ_CONFIG } from '@/lib/types';

// Sample fallback questions in case page is opened directly
const DEMO_QUESTIONS: VisionQuizQuestionItem[] = [
  {
    id: 'demo-q1',
    question_text: 'Thủ đô của Việt Nam là thành phố nào?',
    options: ['Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng'],
    correct_option: 0,
    explanation: 'Hà Nội là thủ đô của nước CHXHCN Việt Nam.',
  },
  {
    id: 'demo-q2',
    question_text: 'Số nào sau đây là số nguyên tố chẵn duy nhất?',
    options: ['0', '1', '2', '4'],
    correct_option: 2,
    explanation: 'Số 2 là số nguyên tố chẵn duy nhất.',
  },
  {
    id: 'demo-q3',
    question_text: 'Đâu là công thức hóa học của nước?',
    options: ['CO2', 'H2O', 'NaCl', 'O2'],
    correct_option: 1,
    explanation: 'H2O là công thức phân tử của nước.',
  },
  {
    id: 'demo-q4',
    question_text: 'Hành tinh nào gần Mặt Trời nhất trong Hệ Mặt Trời?',
    options: ['Sao Hỏa', 'Sao Kim', 'Sao Thủy', 'Trái Đất'],
    correct_option: 2,
    explanation: 'Sao Thủy (Mercury) là hành tinh gần Mặt Trời nhất.',
  },
  {
    id: 'demo-q5',
    question_text: 'Tập hợp các số tự nhiên được ký hiệu bằng chữ cái nào?',
    options: ['Z', 'Q', 'R', 'N'],
    correct_option: 3,
    explanation: 'Tập hợp số tự nhiên ký hiệu là N.',
  },
];

export default function VisionQuizPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<VisionQuizConfig>(DEFAULT_VISION_QUIZ_CONFIG);
  const [blueQuestions, setBlueQuestions] = useState<VisionQuizQuestionItem[]>(DEMO_QUESTIONS);
  const [redQuestions, setRedQuestions] = useState<VisionQuizQuestionItem[]>(DEMO_QUESTIONS);
  const [className, setClassName] = useState<string>('Lớp học mẫu');
  const [primaryTitle, setPrimaryTitle] = useState<string>('Đấu trường Cử chỉ AI');

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('adqs_vision_quiz_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.config) setConfig(parsed.config);
        if (parsed.blueQuestions && parsed.blueQuestions.length > 0) {
          setBlueQuestions(parsed.blueQuestions);
        }
        if (parsed.redQuestions && parsed.redQuestions.length > 0) {
          setRedQuestions(parsed.redQuestions);
        }
        if (parsed.className) setClassName(parsed.className);
        if (parsed.primaryExamTitle) setPrimaryTitle(parsed.primaryExamTitle);
      }
    } catch (e) {
      console.warn('Failed to parse vision quiz session storage', e);
    } finally {
      setLoading(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-white">
        <Loader2 size={32} className="animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <VisionQuizArena
      initialConfig={config}
      blueQuestions={blueQuestions}
      redQuestions={redQuestions}
      className={className}
      primaryExamTitle={primaryTitle}
      onExit={() => router.push('/classes')}
    />
  );
}
