# ADQS EXAM v2 — ARCHITECTURE FREEZE

> **Status:** FROZEN — pre-flight baseline. v1 is READ-ONLY.
> **Generated:** 2026-10-01 (Asia/Saigon)
> **Scope:** Authoritative snapshot of the v1 baseline, the five verified architectural
> invariants (F1–F5), the four approved architectural decisions (D1–D4), and the
> Phase 0 readiness verdict.

---

## 1. Executive Summary & Git Commit Anchors

ADQS Exam v1 is a multi-runtime, server-bound Vietnamese online exam platform. Its
operational shape depends on four always-on processes (Spring Boot JVM, Next.js server,
nginx reverse proxy, Cloudflare Tunnel) plus a Firebase Realtime Database. v2 replaces
this with a 100% serverless, zero-fixed-cost stack: Cloudflare Worker (extractor) +
Vercel (teacher web) + Cloudflare Pages (student SPA) + Supabase PostgreSQL.

The single most consequential v1 discovery is that **Firebase RTDB is the exam *delivery*
channel, not a mirror** — the student runtime never reads exams from SQL. This makes the
Supabase migration a data-plane replacement, not a persistence swap.

### 1.1 Verified baseline anchors

| Anchor | Value |
|---|---|
| Parent repo root | `D:\code\adqsexam` |
| Parent branch | `master` |
| Parent HEAD | `4eb1a1c9d074d916534fe723dfd27f6ad07d26ae` |
| Parent HEAD date | 2026-07-31 22:44:58 +0700 |
| Parent HEAD subject | `Scope RTDB exam read to per-code; harden presence writes` |
| Parent remote | `github → https://github.com/DuyPrX/adqsexam.git` |
| Parent vs remote | 0 ahead / 0 behind (in sync with `github/master`) |
| Student repo root | `D:\code\adqsexam\student` |
| Student branch | `master` |
| Student HEAD | `4a81725ca4466a67af533e47472c31cbe8643f01` |
| Student HEAD date | 2026-07-31 22:02:08 +0700 |
| Student HEAD subject | `Harden student page against backend validation guards` |
| Student remote | `origin → https://github.com/DuyPrX/student.git` |
| Working tree | Clean at freeze time (only `.gitignore` modified by this pre-flight) |

### 1.2 Verified v1 surface inventory

| Surface | Path | Stack (verified) | Role |
|---|---|---|---|
| Backend | `backend/` | Spring Boot 4.0.6, Java 21, Apache POI 5.2.5, openhtmltopdf 1.0.10, firebase-admin 9.3.0 | REST API, DOCX parse, exports, auth, persistence, RTDB sync |
| Teacher web | `web-frontend/` | Next.js 16.2.4, React 19.2.4, Tailwind v4, TypeScript 5, axios, firebase ^12 | Teacher/admin dashboard |
| Student page | `student/` | Vanilla JS (1,465-line `app.js`), Tailwind CDN, Firebase compat SDK 9.23.0 | Exam-taking client |
| Mobile | `frontend/` | Flutter, Riverpod 3, go_router 16, Dio 5 | Teacher companion (legacy, secondary) |
| Deploy | `deploy/` | PowerShell (`adqs.ps1`), nginx :8890, cloudflared tunnel | Launch control + proxy + tunnel |

Backend: ~13 controllers / ~40 endpoints on port `18081` (loopback-bound), Flyway V1–V9
over H2 (dev) / PostgreSQL (prod), 257 passing tests.

### 1.3 v1 runtime topology (verified)

```
Cloudflare Tunnel (edu.hldmulti.site)
  -> nginx :8890
       -> /api/*  -> Spring Boot :18081  (H2 file ./data/examdb)
       -> /*      -> Next.js :3107
student.hldmulti.site (CF Workers static assets, project tracnghiemtvg)
   -> Firebase RTDB webtracnghiem-65d9c   [exam definition + presence + alerts]
   -> backend /api                        [submit result, proctor snapshot]
```

---

## 2. Architectural Invariants F1–F5 (verified against v1 source)

### F1 — Firebase RTDB is the exam delivery channel (not a mirror)

**Evidence:** `student/app.js` lines 334–370 — `startQuiz()` executes
`db.ref('exams/{code}').once('value')` and consumes `data.questions`,
`data.examMode`, `data.startTime`, `data.endTime` directly from RTDB. The student
runtime never queries the SQL database for exam content.

**Corroborating evidence:** `ExamController.create()` writes the question set to RTDB
`exams/{code}` synchronously after the SQL save, and tracks success via the
`firebaseSynced` / `firebaseSyncedAt` columns. Those columns exist solely to monitor the
mirror — they are meaningless once RTDB is gone.

**Consequence for v2:** Migrating to Supabase requires a **student-facing retrieval
mechanism**, because there is no longer a client-readable exam document. Answer: an RPC
`get_student_exam_payload(p_exam_code, p_session_token)` that returns the sanitized
question set (see F2/D1). A plain RLS `SELECT` on `exams` is insufficient — the exam row
contains the answer key, so retrieval and sanitization must be fused into one
`SECURITY DEFINER` function.

**F1 also invalidates the "SQL is the source of truth" reading of the docs.** For
teacher-owned metadata, SQL is authoritative. For the student runtime, RTDB was.

---

### F2 — Answer-key exposure risk (confirmed; v2 must eliminate)

**Evidence:** `student/app.js` loads and uses answer keys in the browser:

| Line | Usage |
|---|---|
| L799 | `userAnswers[i] === sub.correctAnswer` — T/F grading |
| L814 | `correctAnswers: q.subQuestions.map(s => s.correctAnswer \|\| "")` — payload |
| L820 | `const correctAns = (q.correctAnswer \|\| "")` — short-answer grading |
| L853 | `isCorrect = idx === q.correctIndex` — MCQ grading |
| L935 | `correctBox.innerHTML = 'Đáp án đúng: ' + escapeHtml(q.correctAnswer)` — renders key in DOM |
| L1084/L1090 | T/F review renders the key per sub-item |
| L1153 | `const correctAns = q.correctIndex` — MCQ review |

These are 18 distinct references to `correctAnswer` / `correctIndex` /
`correctAnswers` across `app.js`.

**Root cause chain:** F1 (the whole exam document, key included, is shipped to the
browser) → the client must therefore grade locally → the key is necessarily present →
`showResult()` renders it into the DOM.

**Consequence for v2:** The student payload must be **stripped of every answer
field** at the database boundary, not the UI boundary. Concretely, the sanitized DTO
omits `correctIndex`, `correctAnswer`, `subQuestions[].correctAnswer`, and
`explanation`. Grading moves server-side (see F3/D1). Review mode becomes a
server-mediated read that is only reachable *after* submission, via a separate RPC that
gates on a completed `exam_results` row.

---

### F3 — Server-authoritative scoring (exact rules to preserve)

**Evidence:** `backend/.../service/ExamResultService.java` —
`recomputeResult()` (L215–244) and `gradeAnswer()` (L247–283). The client's submitted
`score` is discarded whenever the exam has a parseable question set; score, total, and
per-answer `isCorrect` are recomputed from the stored key. Falls back to submitted values
only for legacy exams with no parseable questions (returns `null` → caller trusts input).

**Authoritative scoring rules (mirror exactly in v2):**

| Type | Rule | Points |
|---|---|---|
| `MCQ` | `selectedIndex === correctIndex` | `1.0` / else `0.0` |
| `TRUE_FALSE` | count sub-items where `key === selected[i]` | 4 → `1.0`; 3 → `0.5`; 2 → `0.25`; 1 → `0.1`; 0 → `0.0` |
| `SHORT_ANSWER` | normalize both, then exact equality | `1.0` / else `0.0` |
| `ESSAY` | never auto-graded | `0.0`, and `needs_grading = true` |
| *(default branch)* | treated as MCQ | as MCQ |

**Normalization for `SHORT_ANSWER`** (`normalizeShort`, L286–289): `s.trim().toLowerCase(Locale.ROOT).replace(",", ".")`
— i.e. trim whitespace, lowercase, comma→dot. Null-safe to `""`.

**Score aggregation** (L242): `score = clamp(round(sum * 100) / 100, 0, total)` — i.e.
sum per-question points, round to 2 decimals, clamp into `[0, total]`.

**Out-of-range guard** (L233–235): an answer whose `questionIndex` is outside
`[0, questions.size())` is passed through and contributes **no** score.

**Essay re-grade safety** (L338–351): `newScore = clamp(score − oldEssaySum + newEssaySum, 0, total)`.
This makes grading idempotent — a teacher re-grading an essay replaces, rather than
adds to, the prior essay contribution. `percent` is then recomputed and
`needs_grading` cleared.

**Consequence for v2 (D1):** these rules become a plpgsql `SECURITY DEFINER` function.
Client-supplied `score` is ignored entirely; the function accepts only the candidate's
raw answers. Because `postgres` lacks `Locale.ROOT` semantics, use `lower()` (Postgres
lowercasing is locale-aware but stable for Vietnamese diacritics under the `vi_VN`/default
collation) plus explicit `trim()` and `replace(x, ',', '.')`.

---

### F4 — Essay parsing deficit (confirmed; v2 parser must add ESSAY)

**Evidence:** `QuestionTypeParser.parse()` (L28–35) dispatches on `SectionType` via a
`switch` with exactly three real branches:

```java
case MCQ          -> parseMCQBlock(block, answerKeys);
case TRUE_FALSE   -> parseTrueFalseBlock(block, answerKeys);
case SHORT_ANSWER -> parseShortAnswerBlock(block, answerKeys);
default           -> parseUnknownBlock(block, answerKeys);
```

A repository-wide grep for `setType(` in `backend/src/main/java` returns only
`"MCQ"`, `"TRUE_FALSE"`, and `"SHORT_ANSWER"`. **No code path in the v1 DOCX parser ever
produces `type = "ESSAY"`.** `SectionType` has only four values
(`MCQ, TRUE_FALSE, SHORT_ANSWER, UNKNOWN`) and `parseSectionType()` maps only
`I → MCQ`, `II → TRUE_FALSE`, `III → SHORT_ANSWER`.

**Yet `ESSAY` is a first-class type downstream:** `QuestionDTO.type` documents it,
`ExamResultService` detects it for `needsGrading`, V9 adds `essay_scores_json` +
`needs_grading`, `ExamPdfService` renders it, and the teacher UI has
`EssayGradingModal` / `QuestionAnswerEditor` branches. The feature is fully built but
**unreachable via parsing** — essays only ever exist if hand-authored or AI-shaped.

**Consequence for v2:** the Worker rule engine must add explicit ESSAY recognition:
section keywords (`Tự luận`, `PHẦN ... Tự luận`, `Câu hỏi tự luận`) and a structural
heuristic (a question block with no A/B/C/D options and no T/F sub-items, whose
instruction text requests a written response). Without this, the essay pipeline stays
dead in v2 as it was in v1.

---

### F5 — Correct-mark superset (bold OR underline OR red hex)

**Evidence — two divergent implementations exist in v1:**

| Implementation | Bold | Underline | Red detection |
|---|---|---|---|
| `DocxTextProcessor.processParagraph` (L43–58) | **YES** (`run.isBold()`) | YES | `startsWith("FF")` \|\| `startsWith("EE")` \|\| `equalsIgnoreCase("red")` \|\| `equalsIgnoreCase("c00000")` |
| `DocxParserService.processParagraph` (L215–228) | **NO** | YES | `equalsIgnoreCase("red")` \|\| `startsWith("FF")` \|\| `startsWith("EE")` \|\| `startsWith("C0")` |

Two concrete divergences:
1. `DocxTextProcessor` treats **bold** as a correctness marker; `DocxParserService` does not.
2. Color matching differs: `DocxTextProcessor` uses exact `c00000`; `DocxParserService` accepts the whole `C0*` prefix family.

`DocxTextProcessor` is the **superset** (bold ⊃ nothing) and is the implementation used
by the modern `QuestionTypeParser` path; `DocxParserService` is the legacy basic path
(surfaced on the student page's "tự luyện" `handleFile` route).

**Consequence for v2:** the Worker parser adopts the **superset**, matching the frozen
decision:

> Wrap a text run in `[CORRECT]...[/CORRECT]` when the run is marked by
> **Bold (`w:b`) OR Underline (`w:u`) OR Red hex in {`FF*`, `EE*`, `C0*`, `c00000`, `red`}**.

This is an intentional, documented behavior change relative to the legacy basic path: the
student self-practice route will now mark *more* options as correct (bold-marked options
previously ignored). This is a fidelity gain, not a regression, but it must be noted so
the difference is not mistaken for a bug during v1↔v2 comparison.

---

## 3. Approved Architectural Decisions D1–D4

### D1 — Zero client-side answer-key transmission + server-side scoring

Answer keys never reach the student browser during an active assessment. The student
payload is served by `get_student_exam_payload`, which returns a sanitized question set
with `correctIndex`, `correctAnswer`, `subQuestions[].correctAnswer`, and `explanation`
**removed**. Scoring is executed exclusively in PostgreSQL inside `submit_exam_result`
(`SECURITY DEFINER`), implementing the F3 rules verbatim. Client-supplied `score` fields
are ignored. Review/answer-key reveal is a separate, post-submission-gated read.

### D2 — Supabase Realtime replaces Firebase RTDB

`postgres_changes` subscriptions replace `onValue` listeners; Supabase Broadcast replaces
the RTDB `exam-presence` presence channel and the push-based `alerts` stream. Mappings:

| v1 RTDB path | v2 replacement |
|---|---|
| `exams/{code}` (exam definition) | `get_student_exam_payload` RPC (D1) |
| `exams/{code}` (teacher analytics reads option text) | `question_bank`/`exams` RLS select |
| `exam-presence/{code}/{studentId}` | `active_sessions` row + Realtime `postgres_changes` |
| `exam-presence/{code}/{studentId}/alerts` | `proctoring_alerts` table (insert-only) + Broadcast |
| `exam-results/{code}` (teacher live refresh) | Realtime on `exam_results` |
| `teacher-presence/{uid}` | `teacher_presence` table + Realtime |

### D3 — Hard-decommission of server-side rendering

Permanently removed: `OpenHTMLtoPDF`, the four bundled Tinos TTF font resources,
the OMR bubble-sheet generator, the multi-variant DOCX/PDF server-side pack generators,
the loopback admin/ops API, local nginx, and the Cloudflare Tunnel config. Shuffle
*logic* is retained and reimplemented client-side (`shuffle.ts`); shuffle *rendering*
is out of scope for v2 (browser-print CSS is a possible future follow-up, not committed).

### D4 — Client-side SheetJS (`xlsx`) for roster in/out

`PortalIntegrationService` (VnEdu/SMAS gradebook sync, POI-based column detection, graded
XLSX emission) is decommissioned. Roster import and the 3-sheet result export are
performed in the browser with SheetJS. The teacher-only gradebook *round-trip*
(reading a school's spreadsheet and writing scores back into a specific column) is not
preserved; equivalent export capability remains.

### 3.5 Parsing engine decision — Dual-Engine Pipeline

**Engine 1 — Rule-based (primary default).** Pure TypeScript regex + stream XML parsing
over `word/document.xml`. Handles the standard Vietnamese exam formats. No API calls,
no tokens.

**Engine 2 — Google AI Studio (fallback / on-demand).** Gemini / Gemma, invoked with a
strict `responseSchema`. The default model is `gemini-3.5-flash-lite`
(`worker/src/ai/ai-engine.ts` — `DEFAULT_MODEL`, overridable via the Worker's
`AI_MODEL_NAME` binding); the teacher may also pick `gemini-3.8-flash` /
`gemma-4-31b-it` or type a custom id (`UploadZone.tsx`, whose shortlist and default
label are built from `NEXT_PUBLIC_AI_MODEL_NAME` / `AI_PROVIDER` — see `web/src/lib/ai.ts`).
All shipped model ids were validated against Google AI Studio. Triggered only when
`mode=ai` is requested explicitly, **or** when Engine 1 yields zero questions, **or**
when Engine 1 produces questions with unresolved answer keys. Defaulting to Engine 1
keeps the overwhelming majority of requests at zero token cost and inside the Worker CPU
budget.

### 3.6 Data integrity & multi-tenancy

All teacher-owned tables (`exams`, `question_bank`, `tags`) carry
`user_id UUID REFERENCES auth.users(id)` with RLS enforced via `auth.uid() = user_id`.
`correct_answer` is typed `JSONB` so the same column can hold a scalar string
(SHORT_ANSWER), an integer index (MCQ), or an ordered boolean/`Đ`-`S` map (TRUE_FALSE
sub-items). Fractional scores use `numeric(5,2)`.

### 3.7 Concurrency, anti-cheat & reload tolerance

- Heartbeat interval: **20 s**; session considered dead after **60 s** without a pulse.
- Session token: persisted in `localStorage` on the student device and re-presented on
  page reload, so an accidental F5 **extends** the existing session rather than tripping
  the single-device lock. This is the F5-referenced reload-tolerance requirement and the
  mitigation for the lockout risk.
- A different device presenting an unknown/foreign token while an active session holds
  a fresh heartbeat is **rejected**.
- `verify_and_acquire_session` performs candidate whitelist verification (Student Code +
  Full Name + Class Name), completed-submission detection, and atomic token issuance.
- Existing browser anti-cheat is preserved verbatim: fullscreen enforcement with exit
  counter, tab-blur counter, and context-menu/copy/paste/cut blocking.

---

## 4. v1 → v2 Feature Disposition Summary

| Action | Count | Notable items |
|---|---|---|
| `PORT_WORKER` | 3 endpoints + 8 parser classes | `/api/docx/parse`, `/parse-intelligent`, parser/answer-key engine |
| `PORT_FRONTEND` | ~8 endpoints | shuffle logic, CSV/XLSX export, roster import (SheetJS) |
| `PORT_SUPABASE` | ~20 endpoints | exams CRUD, question bank, tags, results, proctoring, roster |
| `DECOMMISSION` | ~9 endpoints + all `deploy/` | OpenHTMLtoPDF, OMR, portal sync, admin ops, nginx, tunnel, Firestore/RTDB, Flutter client |

**Capabilities intentionally lost:** server-rendered exam booklet PDF, OMR bubble-sheet
PDF, and the VnEdu/SMAS gradebook round-trip. All three are accepted trade-offs of the
D3/D4 decisions and are recorded here so they are not re-discovered as defects.

---

## 5. Phase 0 Readiness

See the readiness table in the accompanying pre-flight report. All isolation,
toolchain, and baseline checks pass; the workspace is clear to proceed to Phase 1.

### 5.1 Known constraints carried into Phase 1

| Constraint | Impact |
|---|---|
| Supabase free-tier connection limits | Use the pooled connection string; prefer RPC-first over chatty selects |
| Cloudflare Worker 10 ms CPU budget | Decompress only `word/document.xml`; never inflate media |
| Google AI Studio free-tier RPM ceiling (≈15 RPM) | Dual-engine default to rule-based keeps AI calls rare |
| No `Locale.ROOT` in plpgsql | Use `lower()` + explicit `trim()`/`replace()` to mirror `normalizeShort` |
| `localStorage` token is user-editable | Treat as a session *convenience*, never as authorization; all authority stays in the RPC |

### 5.2 Frozen artifact list (Phase 1 inputs)

- `v2/ROADMAP.md` — phased execution plan (pre-existing, now git-ignored)
- `v2/ARCHITECTURE_FREEZE.md` — this document
- v1 read-only references: `backend/.../ExamResultService.java`, `DocxTextProcessor.java`,
  `DocxParserService.java`, `QuestionTypeParser.java`, `AnswerKeyExtractor.java`,
  `QuestionBlockExtractor.java`, `student/app.js`, `sample/test2.docx`
