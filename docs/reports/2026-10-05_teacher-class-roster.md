# Change Report: Teacher Web — Class Roster, CSV Template & Exam PIN Config

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Ship the teacher-facing UI for the Phase 6.1 backend: manage
  classes and their student rosters, download/import a CSV roster template, import
  a class into an exam (`import_class_to_exam`), and configure the per-exam PIN
  policy (`NONE` / `GLOBAL` / `INDIVIDUAL`) at both creation and edit time.
- **Root Cause / Motivation:** Phase 6.1 added `classes`, `class_members`,
  `exams.pin_mode` / `exams.global_pin`, and the PIN gate inside
  `verify_and_acquire_session` — but with **no way for a teacher to reach any of
  it**. A configured PIN policy that cannot be set, and a roster table that cannot
  be filled, is dead schema. This change is the last mile between the Phase 6.1
  API and the teacher.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Types contract.** `ExamRow` gained `pin_mode: PinMode` and `global_pin:
    string | null`; new `PinMode`, `ClassRow`, `ClassMemberRow`, and
    `ClassMemberInput` exports.
  - **`EXAM_COLUMNS`** now selects `pin_mode, global_pin`. This constant is the
    single column list every `ExamRow` consumer reads, so omitting a column there
    leaves the field `undefined` at runtime while TypeScript still believes it is
    a valid `PinMode`.
  - **Persistence.** `buildPinFields(pinMode, globalPin)` is the single validation
    point for the create paths (`saveExam`, `saveExamVariants`) and defaults the
    mode to `INDIVIDUAL`. `updateExamMetadata` uses partial-patch semantics: a
    caller may update only `pin_mode` and leave `global_pin` untouched, but
    switching **to** GLOBAL without supplying a PIN is rejected — Phase 6.1's RPC
    fails **closed** on a NULL shared PIN, so writing one would lock out the room
    with no diagnosable cause. The stored PIN is deliberately retained when
    leaving GLOBAL so toggling back is lossless.
  - **New `lib/classes.ts`.** `listClasses` (folds the PostgREST nested aggregate
    `class_members(count)` into `member_count`, avoiding an N+1 per class),
    `createClass`, `deleteClass`, `listClassMembers`, `saveClassMembers`
    (`onConflict: 'class_id,student_code'` upsert), `deleteClassMember`, and
    `importClassToExam` (translates the RPC's `UNAUTHORIZED_OR_EXAM_NOT_FOUND`
    RAISE into a Vietnamese `PersistenceError`).
  - **Template generator (`lib/studentTemplate.ts`).** Dependency-free by design:
    the e2e harness resolves bare specifiers against the Worker's `package.json`,
    which has no SheetJS, so a module importing `xlsx` would be unloadable from the
    test. `buildStudentCsvTemplate()` emits `\uFEFF` + `STT,Ho_va_ten,Ngay_sinh,
    Ma_hoc_sinh,Ma_PIN` + 3 sample rows with CRLF endings (the BOM is what stops MS
    Excel decoding the Vietnamese diacritics as the ANSI code page).
    `downloadStudentCsvTemplate(className?)` performs the client-side Blob
    download as `Mau_Danh_Sach_Hoc_Sinh_${safe || 'Lop'}.csv`.
  - **Parser (`parseStudentRosterFile` in `lib/excel.ts`).** Normalises
    `DD/MM/YYYY` / Excel serial / `Date` to ISO `YYYY-MM-DD`, auto-generates a
    blank `student_code` as `${className}_${String(index + 1).padStart(2, '0')}`,
    and derives a blank `pin` as `DDMM` from the DOB. `.csv` is read as literal
    text (see §5); `.xlsx` goes through the existing SheetJS path.
  - **UI.** New `/classes` route (server component) + `ClassRosterManager` client
    component (class list with member-count badge, create-class modal, member
    table, `📥 Tải file mẫu (.CSV)`, `📄 Nhập từ file`, member/class deletion).
    `ClassPickerModal` is a pure selector shared by both exam flows. A new
    `PinPolicyControl` renders the `Loại mã bảo vệ` segmented control and the
    conditional `global_pin` input. Both `ExamPreviewEditor` (creation) and
    `ExamEditor` (editing) consume it; the creation flow imports the selected
    classes **after** the save returns codes, and the editing flow calls the RPC
    immediately. The dashboard header gained the `Lớp học` nav link.
- **Database Migrations:** None. Phase 6.1's migration already defines every
  column, table, RLS policy, and RPC this change consumes.
- **API Contracts:** Consumes `import_class_to_exam(p_exam_code varchar,
  p_class_ids uuid[])` unchanged. No new endpoints.

## 3. Impacted Files
- `web/src/lib/types.ts`: `ExamRow` PIN fields; `PinMode`, `ClassRow`,
  `ClassMemberRow`, `ClassMemberInput`.
- `web/src/lib/exams.ts`: `EXAM_COLUMNS` + `pin_mode`/`global_pin`;
  `buildPinFields`; PIN threading through `saveExam`, `saveExamVariants`,
  `updateExamMetadata`.
- `web/src/lib/classes.ts` (**new**): class/member CRUD + `importClassToExam`.
- `web/src/lib/studentTemplate.ts` (**new**): BOM CSV template builder + download.
- `web/src/lib/excel.ts`: `parseStudentRosterFile`, `normalizeDob`,
  `deriveDobPin`, `parseCsvRows`; `ma_hoc_sinh` / `ho_va_ten` header aliases.
- `web/src/app/classes/page.tsx` (**new**): `/classes` server route.
- `web/src/components/ClassRosterManager.tsx` (**new**): roster management UI.
- `web/src/components/ClassPickerModal.tsx` (**new**): shared class picker.
- `web/src/components/questions/PinPolicyControl.tsx` (**new**): PIN policy control.
- `web/src/components/questions/ExamPreviewEditor.tsx`: PIN policy + post-save
  class import.
- `web/src/components/questions/ExamEditor.tsx`: PIN policy + immediate class import.
- `web/src/components/ExamList.tsx`: `Lớp học` nav link.
- `tests/e2e_flow_verification.mjs`: Step 26 (41 assertions).

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npm run build` in `v2/web` — exit 0, TypeScript clean, `/classes` present in
    the route table.
  - `node v2/tests/e2e_flow_verification.mjs` against the local Supabase stack.
- **Results:** `RESULT: 307 passed, 0 failed` (was 266; **+41** from Step 26).
  Step 26 asserts: `EXAM_COLUMNS` contains both PIN columns; the template starts
  with a real U+FEFF BOM with the exact header line, 3 sample rows, and both
  filename variants; the app's own template round-trips through the app's own
  parser (DD/MM preserved, `12A1_01` auto-code, `0509` DDMM PIN); class CRUD +
  `member_count` via the client SDK; `importClassToExam` lands both members with
  the class name and DOB/PIN intact; unknown exams raise the translated
  `PersistenceError`; `updateExamMetadata` persists GLOBAL, rejects a blank PIN and
  a mode-only switch, retains the stored PIN on NONE, and restores GLOBAL; and the
  saved PIN actually gates `verify_and_acquire_session`.
- **Rollback Strategy:** Revert the commit. There is no migration, so no database
  state must be unwound — the new files are additive and the edits are confined to
  the teacher web plus the e2e test.

## 5. Notable Deviations
1. **`.csv` is parsed as text, not through SheetJS.** A local probe proved
   `XLSX.read` coerces the string `05/09/2008` into the Excel serial
   `39577.0003` using the US `MM/DD` convention — reading 5 September as 9 May.
   The DDMM PIN would then have differed between a `.csv` and an `.xlsx` of the
   same roster. `parseCsvRows` (RFC 4180) preserves the literal `DD/MM/YYYY`.
2. **`ClassMemberInput` added.** The parser returns pre-`id` rows for an upsert,
   which is neither `ClassRow` nor `ClassMemberRow`.
3. **A mode-only switch to GLOBAL is refused** (see §2), trading strict field
   independence for a fail-closed guarantee. The editor always resends the PIN.
4. **`ClassPickerModal` only selects.** The RPC needs an exam code, so the two
   callers own the timing. A post-save import failure is surfaced as an inline
   warning rather than thrown, so the teacher still sees the generated codes.
