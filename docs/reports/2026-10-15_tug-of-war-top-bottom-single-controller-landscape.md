# Change Report: Refactor Tug of War to Top-Bottom Layout, Single-Device Controller Lock & 4-Color Landscape Gamepad

- **Date:** 2026-10-15
- **Scope:** Major Change
- **Author/Agent:** Antigravity
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Upgrade the Tug of War ("Kéo Co Tri Thức") classroom game with:
  1. Top-Bottom Split Layout on the Teacher Projector arena to maximize readability during classroom projection.
  2. Independent shuffling of both question order and option order for Blue vs Red, tracking re-mapped `correct_option` indices.
  3. Customizable shortcut keybindings for both Blue (`Q, W, A, S`) and Red (`O, P, K, L`) teams.
  4. Single-Device Controller Lock per team with teacher reset functionality to prevent race conditions or confusion in team play.
  5. Mobile 4-Color Landscape Gamepad on student mobile SPA without question text (students look together at the classroom projector screen and tap the representative colored buttons).
- **Root Cause / Motivation:**
  - 3-column projector layout was cramped horizontally and made large option text harder to read at distance.
  - Allowing arbitrary devices on the same team to tap simultaneously led to accidental double submissions and reduced group deliberation.
  - Presenting question text on phones broke group collaboration because students stared down at their individual phones instead of looking at the board together.

## 2. Technical Implementation Details
- **Architecture & Core Logic:**
  - `TugOfWarArena.tsx` refactored from 3 columns into a Top-Bottom split layout:
    - **Top Stage (~32% height):** Full-width animated horizontal stadium banner with SVG rope, center dashed line, victory flags, and 3v3 pulling avatars with dynamic rope tension offset.
    - **Bottom Stage (50% / 50% split):** Left = Blue Team Question & Options; Right = Red Team Question & Options.
    - **Option Box Styling:** Bold prefixes (`A.`, `B.`, `C.`, `D.`), keyboard shortcut badges, and 4 vibrant themes (`#ef4444` Coral Red, `#3b82f6` Royal Blue, `#f59e0b` Amber Gold, `#10b981` Emerald Green).
    - **Feedback & Transitions:** Flash classes `.is-correct-flash` (green 450ms) and `.is-wrong-flash` (red). When wrong, the option container freezes under an icy overlay countdown (`ĐÓNG BĂNG! Xs`), advancing to the next question only after the freeze penalty completes.
  - `web/src/lib/tugOfWar.ts`:
    - `shuffleQuestionOptions(q)`: Shuffles the 4 options independently and computes the new `correct_option` index.
    - `buildTeamQuestions(pool, order)`: Produces per-team question sequence with independently shuffled options.
    - `createTugOfWarSession`: Persists `blue_questions`, `red_questions`, and customizable `keybindings`.
    - `resetTugOfWarController`: Invokes teacher RPC to unlock a team's controller slot.
  - Single-Device Controller Lock in Supabase RPCs:
    - `join_tug_of_war_lobby`: Acquires `FOR UPDATE` lock, checks existing `blue_controller` or `red_controller`. If taken, returns `{ success: false, code: 'TEAM_SLOT_TAKEN' }` unless the caller provides the matching `controller_token` (allowing F5 refresh / reload recovery).
    - `reset_tug_of_war_controller`: Teacher-only RPC that sets `blue_controller` or `red_controller` to NULL.
    - `submit_tug_of_war_answer`: Grades against team-specific questions (`blue_questions` / `red_questions`) with re-mapped `correct_option`.
  - Student Mobile SPA:
    - Dedicated `#view-tug` container with auto-landscape mode (`screen.orientation.lock('landscape')` and CSS portrait fallback with `transform: rotate(90deg)`).
    - Fullscreen 2x2 grid (`.tug-gamepad-grid`, `.tug-pad-grid`) with 4 massive colored buttons (`🟥 A`, `🟦 B`, `🟨 C`, `🟩 D`). No question text is rendered on the phone.
    - Tactile vibration (`navigator.vibrate`), full-screen green flash overlay on correct answers, and freeze countdown timer with disabled pad buttons during penalty.

## 3. Impacted Files
- `supabase/migrations/20261015020000_tug_of_war_v2_refinements.sql`: Migration adding columns (`keybindings`, `blue_questions`, `red_questions`, `blue_controller`, `red_controller`), updated `join_tug_of_war_lobby` with single-device lock, added `reset_tug_of_war_controller`, and updated `submit_tug_of_war_answer`.
- `supabase/schema.sql`: Mirrored new columns, check constraints, and RPC definitions.
- `web/src/lib/types.ts`: Added `TugOfWarKeybindings`, `TugOfWarControllerInfo`, and updated `TugOfWarSessionRow`.
- `web/src/lib/tugOfWar.ts`: Added `shuffleQuestionOptions`, `buildTeamQuestions`, `resetTugOfWarController`, updated `createTugOfWarSession` and `joinTugOfWarLobby`.
- `web/src/components/games/tug-of-war/CreateTugOfWarModal.tsx`: Added customizable shortcut key inputs for Blue and Red teams.
- `web/src/components/games/tug-of-war/TugOfWarLobby.tsx`: Added controller status indicators and `[ 🔄 Đổi thiết bị ]` reset button.
- `web/src/components/games/tug-of-war/TugOfWarArena.tsx`: Refactored to Top-Bottom split layout, 4-color options, flash classes, and delayed question advance during freeze penalty.
- `student/index.html`: Replaced active screen with 4-color gamepad `#tugOptionsGrid` and `#tugSlotTakenAlert`.
- `student/styles.css`: Added auto-landscape media queries with 90deg portrait fallback and massive 2x2 button grid styles.
- `student/app.js`: Added controller token persistence, orientation lock, slot taken rejection handling, and 4-color gamepad logic.
- `tests/e2e_flow_verification.mjs`: Updated Step 53 testing single-device lock, slot-taken rejection, reload recovery, teacher reset, independent option shuffling grading, and layout contracts.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npm run build` in `web/`: Next.js Turbopack production build succeeded cleanly with 0 TypeScript or lint errors.
  - `node --check student/app.js`: Verified student SPA syntax with exit code 0.
  - `node tests/e2e_flow_verification.mjs`: Complete end-to-end test suite executed across all 53 steps.
- **Results:**
  - `RESULT: 1156 passed, 0 failed` (100% pass rate).
  - All Step 53 contract tests passed: distinct permutations, option shuffling with answer tracking, top-bottom layout, customizable keybindings, controller lock & reset, and student landscape gamepad.
- **Rollback Strategy:**
  - Revert `supabase/migrations/20261015020000_tug_of_war_v2_refinements.sql` and run `git checkout` on the modified files.
