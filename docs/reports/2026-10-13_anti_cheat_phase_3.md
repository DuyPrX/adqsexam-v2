# Change Report: Anti-Cheat Suite — Deterministic Option Shuffling & Live Proctoring Dashboard (Phase 11.2)

- **Date:** 2026-10-13
- **Scope:** Major Change
- **Author/Agent:** Antigravity Pair Programmer
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Extend the ADQS anti-cheat system across Supabase database, Teacher Web UI, and Student SPA:
  1. Add deterministic option shuffling for single and multiple choice questions in Student SPA so candidates sitting adjacent to each other receive different permutations of option choices (A, B, C, D) while preserving canonical indices and answer evaluation.
  2. Implement real-time live proctoring dashboard (`LiveProctorDashboard.tsx`) with Realtime subscription on `exam_audit_logs`, candidate status calculation (Normal, Warning, Critical, Submitted), audit log timeline modal, and teacher-forced session submission RPC (`proctor_force_submit_exam`).
  3. Ensure Realtime publication includes `exam_audit_logs` and defaults in `public.exams.security_config` include `shuffle_options: true`.
- **Root Cause / Motivation:** Option predictability allows adjacent screen peeking during live exams. Additionally, teachers previously lacked real-time visibility into violation alerts and had no mechanism to force-submit a violating student's exam session directly from the monitoring dashboard.

## 2. Technical Implementation Details
- **Database Schema & Migrations (`20261013030000_anti_cheat_phase_3.sql` & `supabase/schema.sql`):**
  - Updated `public.exams.security_config` default JSONB to include `"shuffle_options": true`.
  - Backfilled existing exam rows with `jsonb_set` setting `shuffle_options` to `true` if null.
  - Added table `public.exam_audit_logs` to `supabase_realtime` publication with `REPLICA IDENTITY FULL`.
  - Created teacher-owned SECURITY DEFINER RPC `public.proctor_force_submit_exam(p_exam_code, p_student_code, p_reason)`:
    * Validates teacher ownership of the exam (`user_id = auth.uid()`).
    * Inserts audit log with `violation_type = 'PROCTOR_FORCE_SUBMIT'` and metadata `{ forced: true, proctor_id: auth.uid() }`.
    * Cleans up `active_sessions` row and marks `exam_sessions` as completed.
    * Granted execute permissions exclusively to `authenticated`.
- **Student SPA (`student/app.js`):**
  - Implemented `hashStringToSeed(str)` hashing `student_code + '_' + question_id` into a 32-bit integer seed.
  - Implemented `createMulberry32(seed)` PRNG generator.
  - Implemented `shuffleOptionsDeterministically(options, studentCode, questionId)` using Fisher-Yates with Mulberry32.
  - Wrapped options to retain `originalIndex: idx` and `value: opt`.
  - Displayed options labeled A, B, C, D while saving `item.originalIndex` in `state.answers[q.id]` so official scoring matches canonical keys with zero server-side reverse mapping needed.
  - Skipped shuffling for `TRUE_FALSE` questions or if `security_config.shuffle_options === false`.
- **Teacher Web UI (`web/`):**
  - `web/src/lib/types.ts`: Added `shuffle_options: boolean` to `ExamSecurityConfig` and `DEFAULT_SECURITY_CONFIG`, added `ExamAuditLogRow`.
  - `web/src/components/questions/SecurityPolicyControl.tsx`: Added toggle for `shuffle_options` ("Đảo thứ tự phương án A, B, C, D") with Shuffle icon and updated badge counter to `{activeCount}/9 đang bật`.
  - `web/src/components/exams/LiveProctorDashboard.tsx`: Built live proctoring dashboard with:
    * Metric counters (Tổng thí sinh, 🟢 An toàn, 🟡 Cảnh báo, 🔴 Vi phạm nặng, 📋 Đã nộp bài).
    * Realtime subscription on `exam_audit_logs` (`INSERT` events filtered by `exam_code`).
    * Search and status filter bar.
    * Candidate grid cards displaying name, code, class, status pill, and violation counter.
    * "Xem nhật ký" modal displaying chronological audit event log.
    * "Thu bài cưỡng chế" button with confirmation modal calling `proctor_force_submit_exam`.
  - `web/src/components/exams/ExamResultsContainer.tsx`: Provides tab switching between "Bảng kết quả & Thống kê" and "Giám sát trực tiếp 🛡️".
  - `web/src/app/exams/[code]/results/page.tsx`: Embedded `ExamResultsContainer` supporting `?view=proctor`.
  - `web/src/components/ExamList.tsx`: Added "Giám sát 🛡️" direct action link to `/exams/${exam.code}/results?view=proctor`.

## 3. Impacted Files
- `supabase/migrations/20261013030000_anti_cheat_phase_3.sql`: Migration script for default `shuffle_options`, realtime publication for `exam_audit_logs`, and RPC `proctor_force_submit_exam`.
- `supabase/schema.sql`: Authoritative schema mirroring migration defaults, publication, and RPC definitions.
- `student/app.js`: Deterministic PRNG option shuffling, canonical index preservation, and fallback configuration updates.
- `web/src/lib/types.ts`: Extended `ExamSecurityConfig` and `DEFAULT_SECURITY_CONFIG` with `shuffle_options`, defined `ExamAuditLogRow`.
- `web/src/components/questions/SecurityPolicyControl.tsx`: Toggle for `shuffle_options` with 9-switch badge.
- `web/src/components/exams/LiveProctorDashboard.tsx`: New component with realtime monitoring, candidate cards, audit timeline modal, and force-submit action.
- `web/src/components/exams/ExamResultsContainer.tsx`: New component providing tab navigation between Results and Live Proctoring.
- `web/src/app/exams/[code]/results/page.tsx`: Integrated `ExamResultsContainer` supporting `?view=proctor`.
- `web/src/components/ExamList.tsx`: Added direct link to Live Proctoring dashboard in exam table actions.
- `tests/e2e_flow_verification.mjs`: Added Step 51 verifying schema defaults, publication registration, PRNG determinism & canonical preservation, and teacher force-submit RPC authorization.
- `docs/modified_files.md`: Change ledger entry.
- `docs/reports/2026-10-13_anti_cheat_phase_3.md`: This audit report.

## 4. Verification & Testing
- **Test Commands Executed:**
  1. `node tests/e2e_flow_verification.mjs`:
     * Total assertions: **1,102 passed, 0 failed**.
     * Step 51 verified:
       - `shuffle_options` default in `exams.security_config` is `true`.
       - New exams inherit `shuffle_options = true`.
       - `exam_audit_logs` registered in `supabase_realtime` publication.
       - `proctor_force_submit_exam` rejects unauthenticated and non-owner calls with `FORBIDDEN` / error.
       - `proctor_force_submit_exam` succeeds for exam owner and inserts `PROCTOR_FORCE_SUBMIT` log entry with proctor ID metadata.
       - Pure PRNG functions produce identical permutations for same seed and different permutations for different seeds.
       - Canonical original indices are preserved after shuffling.
       - Empty and single-element options handled safely.
       - Web types and UI components validated.
  2. `node --check student/app.js`: Clean syntax validation.
  3. `npm run typecheck` in `web/`: 0 errors.
  4. `npm run build` in `web/`: Next.js Turbopack production build succeeded cleanly.
- **Rollback Strategy:**
  - Revert `student/app.js`, `web/src/components/exams/`, `web/src/app/exams/[code]/results/page.tsx`, and `web/src/components/ExamList.tsx`.
  - Roll back migration `20261013030000_anti_cheat_phase_3.sql` (`DROP FUNCTION IF EXISTS public.proctor_force_submit_exam`).
