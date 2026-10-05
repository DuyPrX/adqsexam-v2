import * as XLSX from 'xlsx';
import type {
  ClassMemberInput,
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
  'ma_hoc_sinh',
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
  'ho_va_ten',
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

/** Phase 6.2 — date-of-birth column (feeds the DDMM PIN fallback). */
const DOB_HEADERS = [
  'ngày sinh',
  'ngay sinh',
  'ngay_sinh',
  'ngày tháng năm sinh',
  'ngay thang nam sinh',
  'sinh ngay',
  'dob',
  'date of birth',
];

/** Phase 6.2 — explicit PIN column. */
const PIN_HEADERS = [
  'mã pin',
  'ma pin',
  'ma_pin',
  'pin',
  'mã bảo vệ',
  'ma bao ve',
  'mật khẩu',
  'mat khau',
];

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
/* Class-roster import (Phase 6.2)                                            */
/* -------------------------------------------------------------------------- */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Normalises a DOB cell to ISO `YYYY-MM-DD`, returning null when it cannot be
 * understood.
 *
 * Three representations reach this function depending on the source file:
 *   - a `.csv` cell  -> the string exactly as the teacher typed it
 *   - an `.xlsx` date cell -> an Excel serial number (SheetJS is read WITHOUT
 *     `cellDates`, so dates arrive as numbers, not `Date` objects)
 *   - a defensive native `Date`
 *
 * All three must collapse to the same ISO string, otherwise the DDMM PIN
 * fallback silently yields different digits for the same student depending on
 * which template the teacher used.
 */
export function normalizeDob(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }

  // Excel serial: day 1 is 1900-01-01, offset from the 1899-12-30 epoch.
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100000) {
    const days = Math.floor(value);
    const utc = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
    return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
  }

  const text = cellText(value);
  if (!text) return null;

  // DD/MM/YYYY or D/M/YY (the Vietnamese convention; NOT MM/DD).
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    let [, day, month, year] = dmy;
    if (year.length === 2) year = Number(year) > 50 ? `19${year}` : `20${year}`;
    const d = Number(day);
    const m = Number(month);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${year}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }

  // Already ISO: YYYY-MM-DD (optionally with a time component).
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad2(Number(iso[2]))}-${pad2(Number(iso[3]))}`;

  return null;
}

/** Derives the DDMM PIN fallback from an ISO DOB (`2008-09-05` -> `0509`). */
export function deriveDobPin(isoDob: string | null): string | null {
  if (!isoDob) return null;
  const match = isoDob.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, month, day] = match as [string, string, string];
  return `${day}${month}`;
}

/**
 * Parses an RFC 4180 CSV document into rows.
 *
 * `.csv` is read as TEXT rather than handed to SheetJS because `XLSX.read`
 * eagerly coerces date-like strings into Excel serials using the US `MM/DD`
 * convention: `05/09/2008` (5 September, Vietnamese) becomes 9 May 2008, which
 * would silently produce the wrong `DDMM` PIN. Text parsing keeps the teacher's
 * literal `DD/MM/YYYY` intact.
 */
function parseCsvRows(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True when the file should be treated as a delimited text document. */
function isCsvFile(file: File): boolean {
  return /\.csv$/i.test(file.name) || file.type === 'text/csv';
}

/**
 * Parses a class-roster file (.csv and optionally .xlsx) into `class_members`
 * rows (Phase 6.2).
 *
 * `.csv` goes through `parseCsvRows` (see the date-coercion note there); every
 * other extension goes through SheetJS, which covers `.xlsx`/`.xls`.
 *
 * Auto-fill rules (per the Phase 6.2 spec):
 *   - blank `student_code` -> `${className}_${String(index + 1).padStart(2, '0')}`
 *   - blank `pin` with a DOB -> the DOB's `DDMM`
 */
export async function parseStudentRosterFile(
  file: File,
  className: string,
): Promise<ClassMemberInput[]> {
  let rows: unknown[][];

  if (isCsvFile(file)) {
    rows = parseCsvRows(await file.text());
  } else {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('Tệp không có sheet nào.');
    rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: true,
    });
  }

  const headerRowIndex = findHeaderRow(rows);
  if (headerRowIndex === -1) {
    throw new Error('Không tìm thấy dòng tiêu đề chứa "Mã học sinh" và "Họ và tên".');
  }

  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const idCol = headers.findIndex((h) => STUDENT_ID_HEADERS.includes(h));
  const nameCol = headers.findIndex((h) => FULL_NAME_HEADERS.includes(h));
  const dobCol = headers.findIndex((h) => DOB_HEADERS.includes(h));
  const pinCol = headers.findIndex((h) => PIN_HEADERS.includes(h));

  const members: ClassMemberInput[] = [];
  const seen = new Set<string>();

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const fullName = cellText(row[nameCol]);
    // full_name is NOT NULL inside class_members, so a nameless row is skipped.
    if (!fullName) continue;

    const rawCode = idCol === -1 ? '' : cellText(row[idCol]);
    // The ordinal is of the ACCEPTED members, not of the sheet row, so a
    // nameless row in the middle does not leave a gap in the auto numbering.
    const studentCode =
      rawCode || `${className}_${String(members.length + 1).padStart(2, '0')}`;
    // A duplicate code inside one file would make the upsert hit the same row
    // twice, which Postgres rejects outright.
    if (seen.has(studentCode)) continue;
    seen.add(studentCode);

    const dob = dobCol === -1 ? null : normalizeDob(row[dobCol]);
    const rawPin = pinCol === -1 ? '' : cellText(row[pinCol]);
    const pin = rawPin || deriveDobPin(dob);

    members.push({ student_code: studentCode, full_name: fullName, dob, pin });
  }

  if (members.length === 0) {
    throw new Error('Không đọc được học sinh nào từ tệp (thiếu Họ và tên?).');
  }

  return members;
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
