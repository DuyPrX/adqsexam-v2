/**
 * Student roster CSV template generator (Phase 6.2).
 *
 * Deliberately dependency-free: the e2e harness resolves bare specifiers against
 * the Worker's `package.json` (which has no SheetJS), so this module must not
 * import `xlsx`. The parsing side lives in `lib/excel.ts`, which already owns
 * SheetJS.
 *
 * The BOM is not cosmetic: Vietnamese diacritics stored as raw UTF-8 without a
 * BOM are decoded as the system ANSI code page by MS Excel, corrupting names
 * ("Nguyễn" -> "Nguyá»…n"). Excel honours a leading U+FEFF and reads UTF-8.
 */

/** Exported so the e2e template assertions can pin the contract. */
export const STUDENT_TEMPLATE_HEADERS = [
  'STT',
  'Ho_va_ten',
  'Ngay_sinh',
  'Ma_hoc_sinh',
  'Ma_PIN',
  'To_nhom',
] as const;

/**
 * Three illustrative rows exercising every column combination the parser
 * supports, plus the Phase 8.4 `To_nhom` team column:
 *   1. Name + DOB only   -> code auto-generated, PIN derived from DOB (DDMM),
 *                           team omitted (the parser assigns it round-robin)
 *   2. Name + code + PIN -> both used verbatim, explicit team 2
 *   3. Name only         -> code auto-generated, no PIN, explicit team 3
 */
export const STUDENT_TEMPLATE_SAMPLE_ROWS: readonly (readonly string[])[] = [
  ['1', 'Nguyễn Văn An', '05/09/2008', '', '', ''],
  ['2', 'Trần Thị Bình', '12/03/2008', 'HS001', '123456', '2'],
  ['3', 'Lê Văn Cường', '', '', '', '3'],
];

/** RFC 4180 cell: quote when the value contains a delimiter, quote or newline. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The download filename, sanitising the class name into a filesystem-safe token. */
export function studentTemplateFilename(className?: string): string {
  const safe = (className ?? '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
  return `Mau_Danh_Sach_Hoc_Sinh_${safe || 'Lop'}.csv`;
}

/**
 * Builds the template as a CSV string, BOM included.
 *
 * CRLF line endings are used because the file targets MS Excel on Windows.
 */
export function buildStudentCsvTemplate(): string {
  const lines: string[] = [
    STUDENT_TEMPLATE_HEADERS.join(','),
    ...STUDENT_TEMPLATE_SAMPLE_ROWS.map((row) => row.map(csvCell).join(',')),
  ];

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Triggers an instant client-side download of the CSV template.
 *
 * No server round-trip: the payload is built in memory and handed to the browser
 * through an object URL, which is revoked on the next tick so the Blob is not
 * retained.
 */
export function downloadStudentCsvTemplate(className?: string): void {
  const blob = new Blob([buildStudentCsvTemplate()], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = studentTemplateFilename(className);
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Defer the revoke so the click has committed to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
