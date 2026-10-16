# Change Report: AI Vision Gesture Quiz Game ("Đấu Trường Cử Chỉ AI") — Maximum Customization Edition

- **Date:** 2026-10-16
- **Scope:** Major Change
- **Author/Agent:** Antigravity
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Introduce an interactive, AI-powered Computer Vision Gesture Quiz game ("Đấu Trường Cử Chỉ AI") into the Classroom Game Hub (`ClassRosterManager.tsx`), allowing students to stand before the webcam and answer multiple-choice questions by showing fingers (1-2-3-4 -> A-B-C-D) or posing (both hands raised, crossed on chest, left arm up, right arm up) in both Single Player (1P) and Head-to-Head Duel (2P) modes without requiring individual student smartphones.
- **Root Cause / Motivation:** Enhances classroom engagement and gamification during lessons and reviews, providing teachers with an accessible AI camera activity alongside Tug of War and Tree of Knowledge.

## 2. Technical Implementation Details
- **Architecture & Domain Isolation:**
  - `web/src/lib/types.ts`: Defined strongly-typed `VisionQuizConfig`, `DEFAULT_VISION_QUIZ_CONFIG`, `VisionPlayerMode` (`SINGLE` | `DUEL`), `VisionExamDistribution` (`SHARED_SYNC` | `SAME_EXAM_SHUFFLED` | `DUAL_EXAMS`), `VisionDetectionMode` (`HAND_FINGERS` | `BODY_POSE`), `VisionAdvanceMode` (`AUTO` | `MANUAL_TEACHER`), and `VisionQuizQuestionItem`.
  - `web/src/lib/visionEngine.ts`:
    - `countExtendedFingers`: Pure geometric algorithm evaluating 21 MediaPipe hand landmarks (Thumb, Index, Middle, Ring, Pinky) mapping 1->A, 2->B, 3->C, 4/5->D, 0->null.
    - `classifyBodyPose`: Evaluates upper-body landmarks (shoulders, elbows, wrists) classifying both hands up (A), hands crossed on chest (B), left arm up (C), right arm up (D), or neutral posture (null).
    - `assignDetectionsToPlayers`: Spatial zone divider mapping detections to Blue/Red players respecting custom `splitRatio` (0.30 to 0.70) and `swapSides` toggle.
    - `HoldConfirmationTracker`: Anti-flicker dwell-time state machine computing linear hold progress (0..100%), respecting custom `holdDurationMs` (0.5s - 3.0s) and `graceWindowMs` (tolerance window before dropping selection), triggering lock event on completion.
    - `buildVisionQuizQuestions` & `shuffleQuestionOptions`: Generates synchronized questions for `SHARED_SYNC`, independent permutations for `SAME_EXAM_SHUFFLED`, or disjoint exam pools for `DUAL_EXAMS`, while preserving correct option keys under option permutation.
    - `VisionSoundEffects`: Zero-dependency Web Audio oscillator engine providing pleasant audio cues for correct (C5-E5-G5 chime), wrong (sawtooth buzz), freeze (triangle ramp), lock tick, and victory fanfare.
    - `drawVisionOverlay`: High-performance 2D Canvas renderer drawing the vertical zone divider, AR skeleton lines/dots, and circular SVG-style dwell progress HUD indicators with lock badges.
  - `web/src/components/games/vision-quiz/CreateVisionQuizModal.tsx`:
    - 4-section configuration modal with smart defaults:
      1. Player mode toggle (1P vs 2P), roster pickers, `[ 🎲 Chọn ngẫu nhiên ]` caller, `[ ⇄ Đổi bên ]`.
      2. 3 Exam Distribution modes (`SHARED_SYNC`, `SAME_EXAM_SHUFFLED`, `DUAL_EXAMS`), question and option shuffle toggles.
      3. Timing, Knock-out victory rules (`winGap`), freeze penalty duration, and auto vs manual advance modes.
      4. Collapsible advanced calibration: detection mode (`HAND_FINGERS` vs `BODY_POSE`), `splitRatio` slider, `minConfidence` slider, point bonus/deductions, camera mirror toggle, and fallback keyboard bindings.
  - `web/src/components/games/vision-quiz/VisionQuizArena.tsx`:
    - Interactive classroom projector arena with top control bar (countdown timer, pause/resume, skip/advance, quick settings drawer, mute, fullscreen, exit).
    - In-game live settings drawer enabling teachers to adjust `holdDurationMs`, `splitRatio`, `minConfidence`, `wrongPenaltySeconds`, and advance mode in real-time during a live match without reloading.
    - Webcam viewport (~44% height) + glowing AR skeleton canvas overlay.
    - Bottom question stage with responsive 2x2 colored options (`🟥 A`, `🟦 B`, `🟨 C`, `🟩 D`) or dual 50/50 split-screen columns, freeze overlays, and knock-out victory celebration.
  - `web/src/app/games/vision-quiz/page.tsx`:
    - Dedicated Next.js client route reading session payload from `sessionStorage` with built-in educational demo question fallback.
  - `web/src/components/ClassRosterManager.tsx`:
    - Added the `📷 Đấu Trường Cử Chỉ AI (Camera Quiz)` active game card in the `🎮 Trò chơi lớp học` tab.

## 3. Impacted Files
- `web/src/lib/types.ts`: Added Vision Quiz configuration types and constants.
- `web/src/lib/visionEngine.ts`: Core Computer Vision classification, tracking, question building, and audio engine.
- `web/src/components/ClassRosterManager.tsx`: Added AI Camera Quiz game card in Game Hub grid and modal launcher.
- `web/src/components/games/vision-quiz/CreateVisionQuizModal.tsx`: Setup modal with granular teacher customization.
- `web/src/components/games/vision-quiz/VisionQuizArena.tsx`: Interactive camera quiz arena and live settings drawer.
- `web/src/app/games/vision-quiz/page.tsx`: Page route serving the arena.
- `web/src/lib/supabase/session.ts`: Whitelisted `/games/vision-quiz` in `isPublicRoute`.
- `tests/e2e_flow_verification.mjs`: Added Step 55 verifying gestures, zone splitting, dwell tracker, question builders, and component wiring.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npm run typecheck` in `web/`: TypeScript compilation passed with zero errors (`tsc --noEmit`).
  - `npm run build` in `web/`: Next.js 16.3.8 Turbopack production build compiled successfully in 2.2s.
  - `node tests/e2e_flow_verification.mjs`: Ran all 55 steps against the local Supabase Docker stack.
- **Results:**
  - **1,212 passed, 0 failed** across all 55 steps (100% pass rate, 0 regressions).
- **Rollback Strategy:**
  - Revert changes via git restore (`git restore web/src/ tests/ && rm -rf web/src/components/games/vision-quiz web/src/app/games/vision-quiz web/src/lib/visionEngine.ts`).
