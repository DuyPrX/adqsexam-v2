import * as XLSX from 'xlsx';
import type {
  CorrectedAnswer,
  ExamResultRow,
  ExamRow,
  QuestionBankRow,
  RosterEntry,
} from './types';

/**
 * Client-side SheetJS (D4).
 *
 * v1 performed roster parsing and the graded-workbook round-trip on the server
 * via Apache POI (PortalIntegrationService). That service is decommissioned;
 * both directions now run in the browser against the same header vocabulary so
 * existing school spreadsheets keep working.
 */

/* -------------------------------------------------------------------------- */
/* Roster import                                                              */
/* -------------------------------------------------------------------------- */

/** Accepted header spellings, verified against v1 PortalIntegrationService. */
const STUDENT_ID_HEADERS = [
  'mã học sinh',
  'ma hoc sinh',
  'mã hs',
  'ma hs',
  'mã số hs',
  'ma so hs',
  'sbd',
  'số báo danh',
  'so bao danh',
  'mã định danh',
  'ma dinh danh',
  'mã học sinh (vnedu)',
  'student_code',
  'student code',
];

const FULL_NAME_HEADERS = [
  'họ và tên',
  'ho va ten',
  'họ tên',
  'ho ten',
  'tên học sinh',
  'ten hoc sinh',
  'họ và tên học sinh',
  'ho va ten hoc sinh',
  'full_name',
  'fullname',
  'name',
];

const CLASS_HEADERS = ['lớp', 'lop', 'class', 'class_name', 'tên lớp', 'ten lop'];

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** Locates the header row within the first 20 rows (v1 scanned the same range). */
function findHeaderRow(rows: unknown[][]): number {
  const limit = Math.min(rows.length, 20);
  for (let r = 0; r < limit; r++) {
    const headers = (rows[r] ?? []).map(normalizeHeader);
    const hasId = headers.some((h) => STUDENT_ID_HEADERS.includes(h));
    const hasName = headers.some((h) => FULL_NAME_HEADERS.includes(h));
    if (hasId && hasName) return r;
  }
  return -1;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Parses a roster spreadsheet (.xlsx / .xls / .csv) into whitelist entries.
 * Rows missing a student code or a full name are skipped rather than inserted,
 * because `students` requires both (full_name is NOT NULL).
 */
export async function parseRosterFile(file: File): Promise<RosterEntry[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Tệp Excel không có sheet nào.');

  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, {
    header: 1,
    blankrows: false,
    defval: '',
  });

  const headerRowIndex = findHeaderRow(rows);
  if (headerRowIndex === -1) {
    throw new Error('Không tìm thấy dòng tiêu đề chứa "Mã học sinh" và "Họ tên".');
  }

  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const idCol = headers.findIndex((h) => STUDENT_ID_HEADERS.includes(h));
  const nameCol = headers.findIndex((h) => FULL_NAME_HEADERS.includes(h));
  const classCol = headers.findIndex((h) => CLASS_HEADERS.includes(h));

  const entries: RosterEntry[] = [];
  const seen = new Set<string>();

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const studentCode = cellText(row[idCol]);
    const fullName = cellText(row[nameCol]);
    if (!studentCode || !fullName) continue;
    // A duplicate code would violate students_code_exam_uniq on insert.
    if (seen.has(studentCode)) continue;
    seen.add(studentCode);

    entries.push({
      student_code: studentCode,
      full_name: fullName,
      class_name: classCol === -1 ? '' : cellText(row[classCol]),
    });
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* 3-sheet result export                                                      */
/* -------------------------------------------------------------------------- */

function percentage(score: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((score / total) * 1000) / 10;
}

function autoWidth(rows: unknown[][]): XLSX.ColInfo[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const length = String(cell ?? '').length + 2;
      widths[index] = Math.max(widths[index] ?? 10, length);
    });
  }
  return widths.map((wch) => ({ wch: Math.min(wch, 48) }));
}

/** Sheet 1 — exam metadata and aggregate statistics. */
function buildSummarySheet(
  exam: ExamRow,
  questions: QuestionBankRow[],
  results: ExamResultRow[],
): XLSX.WorkSheet {
  const avgScore =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgPercent =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + percentage(r.score, r.total_questions), 0) /
        results.length;

  const rows: unknown[][] = [
    ['Tên đề thi', exam.title],
    ['Mã đề', exam.code],
    ['Thời gian (phút)', exam.duration_minutes],
    ['Số câu hỏi', questions.length],
    ['Số bài nộp', results.length],
    ['Điểm trung bình', Math.round(avgScore * 100) / 100],
    ['Phần trăm trung bình', `${Math.round(avgPercent * 10) / 10}%`],
    ['Số bài cần chấm tự luận', results.filter((r) => r.needs_grading).length],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 26 }, { wch: 46 }];
  return sheet;
}

/** Sheet 2 — one row per submission (the scoreboard). */
function buildScoreboardSheet(results: ExamResultRow[]): XLSX.WorkSheet {
  const headers = [
    'STT',
    'Mã HS',
    'Họ và tên',
    'Lớp',
    'Điểm',
    'Tổng số câu',
    'Phần trăm',
    'Thời gian (giây)',
    'Số lần rời tab',
    'Thoát toàn màn hình',
    'Cần chấm tự luận',
    'Nộp lúc',
  ];

  const rows: unknown[][] = [
    headers,
    ...results.map((r, index) => [
      index + 1,
      r.student_code,
      r.student_name,
      r.class_name,
      r.score,
      r.total_questions,
      `${percentage(r.score, r.total_questions)}%`,
      r.elapsed_seconds,
      r.blur_count,
      r.fullscreen_exit_count,
      r.needs_grading ? 'Có' : 'Không',
      new Date(r.submitted_at).toLocaleString('vi-VN'),
    ]),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = autoWidth(rows);
  return sheet;
}

/** Renders one answer cell, mirroring the v1 display conventions. */
function answerCell(answer: CorrectedAnswer | undefined, type: string): string {
  if (!answer) return '—';

  if (type === 'TRUE_FALSE') {
    if (answer.type !== 'TRUE_FALSE') return '—';
    const size = Math.min(answer.selectedAnswers.length, answer.correctAnswers.length);
    let correct = 0;
    for (let i = 0; i < size; i++) {
      if (answer.selectedAnswers[i] === answer.correctAnswers[i]) correct++;
    }
    return `${correct}/4`;
  }

  if (type === 'SHORT_ANSWER') {
    const text = answer.type === 'SHORT_ANSWER' || answer.type === 'ESSAY' ? answer.selectedAnswerText : '';
    return text.trim() === '' ? '—' : text;
  }

  if (type === 'ESSAY') {
    if (answer.type !== 'ESSAY') return '—';
    return answer.selectedAnswerText.trim() === '' ? '—' : '(tự luận)';
  }

  if (answer.type !== 'MCQ' || answer.selectedIndex === null) return '—';
  return String.fromCharCode(65 + answer.selectedIndex);
}

/** Sheet 3 — a student x question matrix of submitted answers. */
function buildAnswerMatrixSheet(
  results: ExamResultRow[],
  questions: QuestionBankRow[],
): XLSX.WorkSheet {
  const ordered = questions
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((q, index) => ({ ...q, label: `Câu ${index + 1}` }));

  const headers = ['Mã HS', 'Họ và tên', ...ordered.map((q) => q.label)];

  const rows: unknown[][] = [
    headers,
    ...results.map((r) => {
      const byIndex = new Map<number, CorrectedAnswer>();
      (r.answers_json ?? []).forEach((a) => byIndex.set(a.questionIndex, a));

      return [
        r.student_code,
        r.student_name,
        ...ordered.map((q) => answerCell(byIndex.get(q.position - 1), q.question_type)),
      ];
    }),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = autoWidth(rows);
  return sheet;
}

/** Builds the workbook and triggers the browser download. */
export function exportResultsWorkbook(
  exam: ExamRow,
  questions: QuestionBankRow[],
  results: ExamResultRow[],
): void {
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, buildSummarySheet(exam, questions, results), 'Tổng quan');
  XLSX.utils.book_append_sheet(workbook, buildScoreboardSheet(results), 'Bảng điểm');
  XLSX.utils.book_append_sheet(
    workbook,
    buildAnswerMatrixSheet(results, questions),
    'Ma trận đáp án',
  );

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `KetQua_${exam.code}_${stamp}.xlsx`);
}
