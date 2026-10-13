# Change Report: Server-Anchored Session Time Recovery, Re-Grant Attempt RPCs, Question Image Lightbox & PWA Standalone Setup

- **Date:** 2026-10-13
- **Scope:** Major Change
- **Author/Agent:** Antigravity Pair Programming Agent
- **Status:** Verified (1,127 passed E2E assertions, 0 failures; Clean TypeScript & Next.js production builds)

---

## 1. Context & Rationale
- **Objective:**
  Implement the four operational pillars of Exam System Phase 11.3 across Supabase Database, Student SPA, and Teacher Web:
  1. **Server-Anchored Session Time & F5 Recovery:** Make student exam duration durable against page reloads and clock manipulation by calculating remaining time on the server from `public.exam_sessions(started_at, ends_at, is_completed)`.
  2. **Teacher Attempt Management & Proctor Actions:** Expose teacher-owned RPCs (`reset_student_exam_attempt` and `reopen_student_exam_session`) with live action buttons and confirmation dialogs on candidate cards in the Proctor Dashboard.
  3. **Question Image Rendering & Safe Lightbox:** Render markdown `![alt](url)` and HTML `<img>` with centered click-to-zoom modal `#imageLightboxModal`, temporarily bypassing multi-touch security triggers while zooming diagrams.
  4. **PWA Standalone Setup:** Configure `manifest.webmanifest`, zero-cache pass-through service worker `sw.js`, and Apple web app meta tags for installable standalone exam experiences on mobile and tablet devices.
- **Root Cause / Motivation:**
  Previously, exam timer state lived predominantly on the student client (`state.durationSeconds * 60`). An F5 reload reset the countdown or could trigger concurrency issues, while candidate lockout or network dropouts required manual database intervention. Candidates viewing diagrams in STEM questions also suffered false-positive multi-touch warnings when pinch-zooming.

---

## 2. Technical Implementation Details
- **Database & Architecture:**
  1. **Table `public.exam_sessions`:**
     - Created with columns `id UUID`, `exam_id UUID REFERENCES exams(id) ON DELETE CASCADE`, `exam_code VARCHAR(10)`, `student_code VARCHAR(50)`, `started_at TIMESTAMPTZ`, `ends_at TIMESTAMPTZ`, `is_completed BOOLEAN`, `submitted_at TIMESTAMPTZ`.
     - Unique constraint on `(exam_id, student_code)`.
     - RLS enabled with `ALL` policy for exam owners (`e.id = exam_sessions.exam_id AND e.user_id = auth.uid()`).
  2. **RPC `verify_and_acquire_session`:**
     - Checks existing row in `public.exam_sessions` for `(v_exam.id, student_code)`.
     - If completed: returns `{ success: false, code: 'EXAM_ALREADY_SUBMITTED', message: 'ALREADY_SUBMITTED' }`.
     - Computes `v_remaining_seconds := GREATEST(0, EXTRACT(EPOCH FROM (v_exam_session.ends_at - v_now))::INT)`.
     - If `v_remaining_seconds <= 0`: marks `is_completed = true, submitted_at = v_now` and returns `{ success: false, code: 'EXAM_TIME_EXPIRED', message: 'EXAM_TIME_EXPIRED' }`.
     - On initial acquisition: creates `exam_sessions` anchored to `v_now + (duration_minutes || ' minutes')::interval`.
     - Returns `time_remaining_seconds`, `started_at`, and `ends_at` in JSONB payload.
  3. **RPC `reset_student_exam_attempt(p_exam_code, p_student_code, p_reason)`:**
     - Enforces authenticated teacher ownership (`v_exam.user_id = auth.uid()`).
     - Atomically wipes prior records from `public.active_sessions`, `public.exam_results`, and `public.exam_sessions`.
     - Logs `TEACHER_RESET_ATTEMPT` with `proctor_id` metadata into `public.exam_audit_logs`.
  4. **RPC `reopen_student_exam_session(p_exam_code, p_student_code, p_extra_minutes)`:**
     - Enforces authenticated teacher ownership.
     - Extends session `ends_at := GREATEST(now(), ends_at) + (p_extra_minutes || ' minutes')::interval`, unsets `is_completed`, clears `submitted_at`, wipes any stale `exam_results` and `active_sessions` records to permit re-entry.
     - Logs `TEACHER_REOPEN_SESSION` with `new_ends_at` into `public.exam_audit_logs`.
- **Student SPA (`student/`):**
  - **Timer Anchoring & F5 Recovery:**
    - Adopts `time_remaining_seconds` and computes `state.endsAt = Date.now() + (time_remaining_seconds * 1000)`.
    - `tickTimer()` computes remaining seconds via `Math.max(0, Math.round((state.endsAt - Date.now()) / 1000))`.
    - `tryResumeSession()` restores `ends_at` from `localStorage` and synchronizes with the server's live `time_remaining_seconds`.
  - **Question Images & Lightbox:**
    - `formatQuestionContent(rawText)` transforms markdown images `![alt](url)` and marks `<img>` with `.question-img`.
    - Clicking any `.question-img` displays `#imageLightboxModal` and sets `state.isViewingImage = true`.
    - Closing via `&times;` button, backdrop click, or Escape key resets `state.isViewingImage = false`.
    - Touch handlers `onSecurityTouch` and `onSecurityTouchEnd` bypass multi-touch violation detection while `state.isViewingImage === true`.
  - **PWA Standalone Setup:**
    - Added `student/manifest.webmanifest` with standalone display mode, orientation, theme colors, and icons.
    - Added `student/sw.js` (pass-through zero-cache service worker) registered in `app.js`.
    - Added Apple mobile web app meta tags and manifest link in `student/index.html`.
- **Teacher Web Dashboard (`web/src/components/exams/LiveProctorDashboard.tsx`):**
  - Added `TEACHER_RESET_ATTEMPT` and `TEACHER_REOPEN_SESSION` to `VIOLATION_LABELS`.
  - Added action buttons `[ 🔄 Cấp lại lượt ]` and `[ 🔓 Mở khóa (+5p) ]` on candidate cards.
  - Added confirmation modals with Vietnamese messaging before invoking `reset_student_exam_attempt` and `reopen_student_exam_session`.
  - Updates local state optimistically upon success.

---

## 3. Impacted Files
- `supabase/migrations/20261013040000_session_recovery_and_proctor_actions.sql`: Migration introducing `exam_sessions`, teacher attempt reset & session reopen RPCs, and updated `verify_and_acquire_session`.
- `supabase/schema.sql`: Authoritative schema mirroring `exam_sessions`, RLS policies, and RPC definitions.
- `student/manifest.webmanifest`: PWA standalone web app manifest.
- `student/sw.js`: Zero-cache pass-through service worker.
- `student/icons/icon-192.png`: 192x192 PNG application icon.
- `student/icons/icon-512.png`: 512x512 PNG application icon.
- `student/index.html`: PWA links, Apple mobile meta tags, and `#imageLightboxModal` markup.
- `student/styles.css`: Styles for `.question-img`, `#imageLightboxModal`, `.lightbox-close-btn`, `.lightbox-content`.
- `student/app.js`: Server-anchored countdown target, F5 recovery, markdown image formatting, lightbox zoom, multi-touch suppression while viewing images, and SW registration.
- `web/src/components/exams/LiveProctorDashboard.tsx`: Reset attempt & reopen session RPC integration, card buttons, and confirmation dialogs.
- `tests/e2e_flow_verification.mjs`: Added Step 52 asserting session creation, decremented countdown on F5, session expiry, teacher reset/reopen RPCs, markdown image parsing, and PWA assets.
- `docs/modified_files.md`: Updated modified files ledger.

---

## 4. Verification & Testing
- **Test Commands Executed:**
  - `node --check student/app.js` -> Exit code 0 (clean JavaScript syntax).
  - `npm run typecheck` in `web/` -> Exit code 0 (clean TypeScript build).
  - `npm run build` in `web/` -> Exit code 0 (Next.js production build succeeded).
  - `node tests/e2e_flow_verification.mjs` -> Result: **1,127 passed, 0 failed**.
- **Results:**
  All 52 test steps (including 17 detailed assertions in Step 52) passed completely against the local Supabase environment.
- **Rollback Strategy:**
  - Database: `DROP FUNCTION IF EXISTS reset_student_exam_attempt`, `DROP FUNCTION IF EXISTS reopen_student_exam_session`, `DROP TABLE IF EXISTS public.exam_sessions CASCADE`.
  - Client / Web: Revert git commits on `student/`, `web/`, and `tests/`.
