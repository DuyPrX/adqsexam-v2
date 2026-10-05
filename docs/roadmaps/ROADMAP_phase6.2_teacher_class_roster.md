# Roadmap: Teacher Web — Class Roster, CSV Template & Exam PIN Config (Phase 6.2)

- **Created:** 2026-10-05
- **Last Updated:** 2026-10-05 (UTC+7)
- **Overall Status:** `COMPLETED` (`PLANNING` | `IN_PROGRESS` | `BLOCKED` | `COMPLETED`)

## 1. Objective
Give the teacher a real UI for the Phase 6.1 backend: manage classes and their
rosters, download a CSV import template, import a class into an exam
(`import_class_to_exam`), and configure the per-exam PIN policy
(`NONE` / `GLOBAL` / `INDIVIDUAL`).

Completion criteria:
- `ExamRow` + `EXAM_COLUMNS` carry `pin_mode` / `global_pin`; the save paths persist them.
- `studentTemplate.ts` generates a BOM-prefixed CSV with the exact Vietnamese headers.
- A `/classes` route manages classes + members (create, import file, delete).
- Exam creation and editing both expose the PIN policy control; editing can import classes.
- `npm run build` exits 0; e2e Step 26 green; suite stays green.

---

## 2. Execution Phases

### Phase 1: Types, Columns & Persistence `[x]`
- [x] `ExamRow.pin_mode` / `ExamRow.global_pin`; `ClassRow` / `ClassMemberRow`.
- [x] `EXAM_COLUMNS` += `pin_mode, global_pin`.
- [x] `saveExam` / `saveExamVariants` / `updateExamMetadata` accept + persist them.
- [x] New `lib/classes.ts` CRUD + `importClassToExam`.

### Phase 2: CSV Template & Parser `[x]`
- [x] `lib/studentTemplate.ts` — pure `buildStudentCsvTemplate` + DOM download wrapper.
- [x] `parseStudentRosterFile` in `lib/excel.ts`.

### Phase 3: Class Management UI `[x]`
- [x] `app/classes/page.tsx` (server) + `ClassRosterManager` (client).
- [x] `ClassPickerModal` (reused by both exam flows).
- [x] Nav link `Lớp học` alongside `Đề thi`.

### Phase 4: Exam Creation & Editing Integration `[x]`
- [x] `ExamPreviewEditor`: PIN policy control + class import on save.
- [x] `ExamEditor`: PIN policy control + class import via RPC.

### Phase 5: Verification & Audit `[x]`
- [x] e2e Step 26; `npm run build`; full suite.
- [x] Roadmap + change-reporter ledger/report; commit `web/ tests/`.

---

## 3. Chronological Progress Log
- **2026-10-05:** Roadmap initialized after reconnaissance of `web/src`.
- **2026-10-05:** Phase 1 — `types.ts` + `exams.ts` (PIN columns, `buildPinFields`,
  partial-patch `updateExamMetadata`) + new `lib/classes.ts`.
- **2026-10-05:** Phase 2 — `studentTemplate.ts` (BOM CSV) and
  `parseStudentRosterFile` + `normalizeDob` + `deriveDobPin` in `excel.ts`.
- **2026-10-05:** Phase 3 — `/classes` route, `ClassRosterManager`,
  `ClassPickerModal`, `Lớp học` nav link.
- **2026-10-05:** Phase 4 — `PinPolicyControl` shared by both exam components;
  class import wired into creation (post-save, per code) and editing (immediate RPC).
- **2026-10-05:** Phase 5 — `npm run build` exit 0; e2e **307/307** (+41 Step 26
  assertions); report + ledger written.

## 3.1 Deviations From The Spec (and why)

### X-A. `parseStudentRosterFile` reads `.csv` as TEXT, not through SheetJS
The spec allowed "standard text line parsing or PapaParse". SheetJS was the first
choice, but a local probe proved `XLSX.read` coerces the string `05/09/2008` into
the Excel serial `39577.0003` using the **US `MM/DD`** convention — i.e. it reads
5 September as 9 May. The derived DDMM PIN would then have been `0509` for a
`.xlsx` but a wrong `0905`-derived value for a `.csv`. The CSV branch therefore
uses a small RFC 4180 text parser (`parseCsvRows`) that preserves the literal
`DD/MM/YYYY`; `.xlsx` still goes through SheetJS.

### X-B. `ClassMemberInput` added to `types.ts`
The spec listed only `ClassRow` / `ClassMemberRow`. `parseStudentRosterFile`
returns pre-`id` rows destined for an upsert, which is neither shape, so a third
narrow interface was added rather than widening `ClassMemberRow` with optional
fields.

### X-C. `updateExamMetadata` refuses a mode-only switch to GLOBAL
The spec implies `pin_mode` / `global_pin` are independent fields. Making them
fully independent would let a caller set `pin_mode = 'GLOBAL'` with no
`global_pin`; Phase 6.1's RPC fails **closed** on a NULL shared PIN, so that exam
would admit nobody with no diagnosable cause. The write path therefore requires
the PIN to accompany a switch to GLOBAL (the editor always resends it). Partial
patches in the *other* modes are still independent, and the stored PIN is
deliberately retained so switching back is lossless.

### X-D. `ClassPickerModal` only selects; the caller runs the RPC
The spec describes the button as loading members "into the exam's candidates list
(or call `import_class_to_exam` upon exam creation)". Because the RPC needs an
exam code, the modal is a pure selector and the two callers decide when to import
(post-save for creation, immediately for editing). Import failures after a
successful save are surfaced as an inline warning instead of throwing, so the
teacher still receives the generated codes.


## 4. Blockers & Architectural Decisions

### D-A. The template generator must stay import-free (testability)
The e2e harness resolves bare specifiers against the **Worker's** `package.json`,
which has no `xlsx`. A `studentTemplate.ts` that did `import * as XLSX from 'xlsx'`
would therefore be unloadable from the test. Split:
- `studentTemplate.ts` → dependency-free pure CSV builder (+ a thin DOM download wrapper).
- `parseStudentRosterFile` → lives in the existing `lib/excel.ts`, which already
  imports SheetJS and already owns `parseRosterFile`.

SheetJS `XLSX.read` parses CSV as well as XLSX, so `.xlsx` stays on the existing
D4 dependency. `.csv` is instead read as literal text (see X-A): trusting SheetJS
with the CSV would have silently mis-parsed `DD/MM/YYYY` as US `MM/DD`.

### D-B. There is no shared navbar
Each page renders its own header; only `ExamList` has the dashboard chrome. The
`Lớp học` link is therefore added to the dashboard header (beside `Tạo đề mới`),
and the `/classes` page links back to `Đề thi`. Introducing a global layout nav
would touch every page for no functional gain.

### D-C. `import_class_to_exam` cannot run before the exam exists
In the creation flow the exam code does not exist until `saveExam` /
`saveExamVariants` returns. The class picker therefore only *selects* classes
during authoring; the RPC is called **after** a successful save, once per created
code (multi-variant saves loop over `codes`). Editing an existing exam calls it
immediately.

### D-D. `member_count` via PostgREST aggregate
`classes` has no counter column. `select('*, class_members(count)')` returns the
nested count in one round-trip, avoiding an N+1 per-class count query.

### D-E. `ClassRow.academic_year` typed `string` (per spec)
The DB column is nullable (`DEFAULT '2026-2027'`, no NOT NULL). The spec mandates
`academic_year: string`, and every insert from this UI supplies a value, so the
narrower type is what the app actually relies on. Noted rather than silently
widened.

### D-F. CSV date normalisation must be defensive
A `.csv` yields `05/09/2008` as a **string**, while an `.xlsx` date cell yields an
Excel serial number (or a JS `Date`). `normalizeDob` collapses all three shapes to
`YYYY-MM-DD` before deriving the DDMM PIN, so the fallback cannot silently produce
different digits depending on the file format.
