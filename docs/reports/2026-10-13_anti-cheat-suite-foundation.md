# Change Report: Anti-Cheat Suite — Client Defense Shield & Security Config (Phase 11.0)

- **Date:** 2026-10-13
- **Scope:** Major Change
- **Author/Agent:** Antigravity Pairing Assistant
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Implement the foundation of the exam anti-cheat system across Supabase Database, Teacher Web, and Student SPA to protect exam integrity against unauthorized clipboard operations, multi-touch gestures, tab switching, and screenshots.
- **Root Cause / Motivation:** Online exams require active defense mechanisms on candidate devices:
  1. Preventing copy/cut/paste and text selection prevents question leaks.
  2. Multi-touch gesture detection (≥3 fingers) intercepts OS-level screenshot shortcuts on mobile and tablet devices.
  3. Window blur and tab visibility tracking enforces candidate focus and logs violations.
  4. Forensic watermarking imprints candidate identity and exam code directly onto the viewport to deter mobile photography and unauthorized redistribution, backed by a self-healing DOM observer.
  5. Teacher control allows toggling specific defenses per exam depending on exam setting (e.g., practice vs official).

## 2. Technical Implementation Details
- **Database Schema & Migrations (`supabase/migrations/20261013010000_anti_cheat_phase_1.sql` and `supabase/schema.sql`):**
  - Added `security_config` JSONB column to `public.exams` with default `'{"prevent_copy": true, "detect_multitouch": true, "blur_on_leave": true, "watermark": true, "max_violations": 3}'::jsonb`.
  - Created `public.exam_audit_logs` table for storing proctoring events with index `idx_exam_audit_logs_lookup (exam_code, student_code, occurred_at desc)`.
  - Configured RLS on `public.exam_audit_logs` granting SELECT to owning teachers (`user_id = auth.uid()`) and revoking direct table privileges from `anon`.
  - Created public RPC `public.log_exam_violation(p_exam_code, p_student_code, p_violation_type, p_message, p_metadata)` callable by anon/authenticated candidates.
  - Updated `verify_and_acquire_session` and `get_exam_roster` to return `security_config` in JSONB payload.
- **Teacher Web UI (`web/`):**
  - Updated `web/src/lib/types.ts`: Defined `ExamSecurityConfig` interface, `DEFAULT_SECURITY_CONFIG`, and updated `ExamRow`.
  - Updated `web/src/lib/exams.ts`: Added `security_config` to `EXAM_COLUMNS`, updated `insertExamWithFreshCode`, `saveExam`, `saveExamVariants`, and `updateExamMetadata`.
  - Created `web/src/components/questions/SecurityPolicyControl.tsx`: Collapsible "Bảo mật phòng thi (Anti-Cheat)" panel with 4 feature switches (`prevent_copy`, `detect_multitouch`, `blur_on_leave`, `watermark`).
  - Integrated `SecurityPolicyControl` into `ExamPreviewEditor.tsx` and `ExamEditor.tsx`.
- **Student SPA (`student/`):**
  - `styles.css`: Added `.security-locked` (callout and user-select disabled), `body.security-blur` (blur 28px grayscale), `#securityBlurOverlay` warning backdrop, and `.watermark-overlay`.
  - `index.html`: Added `#securityBlurOverlay` warning shield with resume button `#btnResumeSecurityBlur`.
  - `app.js`: Added `state.securityConfig`, restored from session and RPCs, implemented `reportViolation` (3s throttling to `log_exam_violation`), `setupForensicWatermark` (canvas generator protected by `MutationObserver`), `initAntiCheat(cfg)` / `bindAntiCheat(cfg)`, and `unbindAntiCheat()`.

## 3. Impacted Files
- `supabase/migrations/20261013010000_anti_cheat_phase_1.sql`: Migration script for `security_config`, `exam_audit_logs`, `log_exam_violation`, and RPC updates.
- `supabase/schema.sql`: Authoritative schema mirroring Phase 11.0 Anti-Cheat schema, policies, RPCs, and privilege hardening.
- `web/src/lib/types.ts`: Added `ExamSecurityConfig`, `DEFAULT_SECURITY_CONFIG`, and updated `ExamRow`.
- `web/src/lib/exams.ts`: Added `security_config` to `EXAM_COLUMNS` and persistence handlers.
- `web/src/components/questions/SecurityPolicyControl.tsx`: Collapsible anti-cheat settings UI with 4 feature toggles.
- `web/src/components/questions/ExamPreviewEditor.tsx`: Integrated `SecurityPolicyControl` and persisted configuration during exam creation.
- `web/src/components/questions/ExamEditor.tsx`: Integrated `SecurityPolicyControl` and persisted updates for existing exams.
- `student/styles.css`: Defined classes for locked selection, blur shields, blur overlay, and forensic watermark.
- `student/index.html`: Added `#securityBlurOverlay` modal warning dialog.
- `student/app.js`: Anti-cheat initialization, multi-touch detection, blur triggers, watermark observer, and audit logging RPC dispatcher.
- `tests/e2e_flow_verification.mjs`: Added Step 49 testing schema defaults, RLS audit log access, violation RPC, session payloads, and UI/script assertions.
- `docs/modified_files.md`: Change ledger update.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npx supabase migration up --local`: Applied migration successfully to local Postgres.
  - `npm run typecheck` in `web/`: 0 errors.
  - `npm run build` in `web/`: Next.js production build succeeded with Turbopack.
  - `node --check student/app.js`: Syntax check clean.
  - `node tests/e2e_flow_verification.mjs`: All 1,075 assertions passed cleanly (0 failures).
- **Rollback Strategy:**
  - Database: Drop column `security_config` from `exams`, drop table `exam_audit_logs`, drop function `log_exam_violation`, revert `verify_and_acquire_session` and `get_exam_roster`.
  - Frontend: Revert `SecurityPolicyControl.tsx` and modifications to `ExamPreviewEditor.tsx`, `ExamEditor.tsx`, and `student/app.js`.
