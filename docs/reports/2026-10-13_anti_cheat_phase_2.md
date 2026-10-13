# Change Report: Anti-Cheat Suite Phase 11.1 — Fullscreen Enforcement, Split-Screen Detection, Device Motion Guard & Violation Limit Auto-Submit

- **Date:** 2026-10-13
- **Scope:** Major Change
- **Author/Agent:** Antigravity AI
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Extend the exam security architecture across Database, Teacher Web, and Student SPA to deter candidate malpractice through mandatory fullscreen lock, split-screen/floating-app detection, accelerometer device motion guards, visual violation badge tracking, and automatic exam submission upon exceeding violation limits.
- **Root Cause / Motivation:** Candidates on mobile and desktop could bypass standard screen locks by exiting fullscreen, opening floating split windows, or picking up/moving devices during tests. Additionally, teachers needed granular control over violation thresholds (`max_violations`) with automated enforcement (`auto_submit_on_limit`).

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Database & Schema:**
    - Migration `20261013020000_anti_cheat_phase_2.sql` updates `public.exams.security_config` default to 9 keys:
      * `prevent_copy`: `true`
      * `detect_multitouch`: `true`
      * `blur_on_leave`: `true`
      * `watermark`: `true`
      * `enforce_fullscreen`: `true`
      * `detect_split_screen`: `true`
      * `detect_motion`: `false`
      * `max_violations`: `3`
      * `auto_submit_on_limit`: `false`
    - Backfills all existing exams preserving pre-existing keys with safe COALESCE fallbacks.
    - Updated `supabase/schema.sql` table defaults and RPC coalesces in `verify_and_acquire_session` and `get_exam_roster`.
  - **Teacher Web UI:**
    - `web/src/lib/types.ts`: Extended `ExamSecurityConfig` interface and `DEFAULT_SECURITY_CONFIG` with all 9 properties.
    - `web/src/components/questions/SecurityPolicyControl.tsx`: Added toggles for:
      * `enforce_fullscreen` (Bắt buộc toàn màn hình)
      * `detect_split_screen` (Phát hiện chia đôi màn hình / cửa sổ nổi)
      * `detect_motion` (Cố định thiết bị trên bàn - Cảm biến di chuyển)
      * `auto_submit_on_limit` (Tự động nộp bài khi vượt ngưỡng vi phạm)
      * Numeric input for `max_violations` (1..10 lần cảnh báo).
      * Active status pill dynamically displays `{activeCount}/8 đang bật`.
  - **Student SPA:**
    - `student/styles.css`: Added styles for `.security-violation-badge` (`is-clean`, `is-warning`, `is-danger` with pulsing animation) and `#btnEnterFullscreen` (`.security-btn-fullscreen`).
    - `student/index.html`:
      * Added `#examContainer` wrapper.
      * Added `#securityViolationBadge` in `#examHeader__right`.
      * Added `#btnEnterFullscreen` in `#securityBlurOverlay`.
      * Added `#btnRequestMotion` button for iOS motion sensor permission.
    - `student/app.js`:
      * Fullscreen enforcement (`cfg.enforce_fullscreen`): automatically triggers `requestFullscreen()` on exam start; listens to `fullscreenchange` and applies `.security-blur` + logs `FULLSCREEN_EXIT` on exit; resumes via `#btnEnterFullscreen`.
      * Split-screen detection (`cfg.detect_split_screen`): tracks viewport height delta; triggers `.security-blur` and logs `SPLIT_SCREEN_DETECTED` when viewport height drops below 65% of baseline height without focusing an `<input>` or `<textarea>`.
      * Motion guard (`cfg.detect_motion`): listens to `devicemotion` measuring acceleration magnitude against gravity (`|sqrt(x^2 + y^2 + z^2) - 9.81| > 4.5 m/s²`), throttled every 3 seconds to log `PHONE_MOVED`. Provides iOS `DeviceMotionEvent.requestPermission` handling via `#btnRequestMotion`.
      * Violation badge & Auto-Submit: tracks `state.violationCount` and `state.maxViolations`; updates `#securityViolationBadge` text (`⚠️ Vi phạm: X/Y lần`); automatically triggers `submitExam({ forcedReason: 'AUTO_VIOLATION_LIMIT' })` when `cfg.auto_submit_on_limit` is enabled and violation threshold is reached.
  - **E2E Test Verification:**
    - Added Step 50 in `tests/e2e_flow_verification.mjs` verifying schema defaults, RPC payload delivery, TypeScript types, SecurityPolicyControl toggles, SPA styles, SPA markup, and client logic.

## 3. Impacted Files
- `supabase/migrations/20261013020000_anti_cheat_phase_2.sql`: Schema default and backfill migration for Phase 11.1 properties.
- `supabase/schema.sql`: Mirrored Phase 11.1 security_config defaults and RPC fallbacks.
- `web/src/lib/types.ts`: Extended `ExamSecurityConfig` type and default constant.
- `web/src/components/questions/SecurityPolicyControl.tsx`: Added 4 new toggles, number input for `max_violations`, and active counter.
- `student/styles.css`: Added `.security-violation-badge` and `.security-btn-fullscreen` styles.
- `student/index.html`: Added `#examContainer`, `#securityViolationBadge`, `#btnEnterFullscreen`, and `#btnRequestMotion`.
- `student/app.js`: Added violation counter, badge updater, auto-submit branch, fullscreen enforcer, resize guard, and motion guard.
- `tests/e2e_flow_verification.mjs`: Added Step 50 assertion suite.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npx supabase migration up --local`: Succeeded.
  - `npm run typecheck` in `web/`: Succeeded (zero TypeScript errors).
  - `npm run build` in `web/`: Succeeded (production build completed).
  - `node --check student/app.js`: Succeeded (zero syntax errors).
  - `node --check tests/e2e_flow_verification.mjs`: Succeeded.
  - `node tests/e2e_flow_verification.mjs`: **1,086 passed, 0 failed** across all 50 test steps.
- **Results:** 1,086/1,086 assertions passed without regressions.
- **Rollback Strategy:** Revert migration or execute rollback SQL restoring 5-key `security_config` default, and revert git commits on `main`.
