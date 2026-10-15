# Change Report: Classroom Game Hub & Tug of War ("Kéo Co Tri Thức") Game Engine

- **Date:** 2026-10-15
- **Scope:** Major Change
- **Author/Agent:** Antigravity AI Assistant
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** 
  1. Transform the Class view into a dual-tab management center: `[👥 Danh sách học sinh]` and `[🎮 Trò chơi lớp học]`.
  2. Implement "Kéo Co Tri Thức" (Tug of War) as an interactive gamified classroom engine where two teams (e.g., Tổ 1 vs Tổ 2 or custom groups) battle in real-time answering exam questions, pulling an SVG rope and animated students toward their goal.
  3. Maintain 100% strict architectural and schema isolation: ZERO regression or coupling with existing Tree of Knowledge (`tree_sessions`, `tree_submissions`, `TreeLobby.tsx`, `TreeProjector.tsx`) or Anti-Cheat / Proctor systems.
- **Root Cause / Motivation:** 
  Classrooms need quick, engaging live competition formats using existing question banks. Students participate from mobile devices without account login (only name and student code or group number), while teachers project an animated stadium arena on a big screen with sound effects, dynamic tension physics, countdown clocks, and instant freeze penalties on incorrect answers.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Classroom Game Hub:** Integrated in `web/src/components/ClassRosterManager.tsx` with a responsive tab switcher, featuring Kéo Co Tri Thức as an active game, shortcut to Cây Tri Thức, and preview cards for upcoming mini-games.
  - **Dedicated Database Layer:** Isolated table `public.tug_of_war_sessions` with `replica identity full`, realtime publication registration in `supabase_realtime`, and row-level security policies (`tug_of_war_sessions_teacher_all`, `tug_of_war_sessions_student_read`, `tug_of_war_sessions_student_update`).
  - **Deterministic Anti-Cheat Invariant for Questions:** `generateDistinctQuestionOrders` produces distinct shuffled permutation arrays for Blue and Red teams ensuring `blueOrder[0] !== redOrder[0]` (when count > 1) to eliminate adjacent screen copying while both teams answer the same set of questions over the course of the match.
  - **Atomic Game State RPCs:**
    - `join_tug_of_war_lobby`: Maps checking-in students automatically to BLUE or RED based on their class roster `group_number` or selected team, appending participant records atomically.
    - `start_tug_of_war_session`: Starts the game, calculating and recording `ends_at = clock_timestamp() + duration_seconds`.
    - `submit_tug_of_war_answer`: Evaluates submitted option against question pool. Correct answer increments team score and current index; wrong answer triggers team freeze lock (`frozen_until = clock_timestamp() + freeze_seconds`). Immediately detects and transitions status to `FINISHED` when score difference reaches `win_gap` or questions pool is exhausted.
    - `get_tug_of_war_session`: Secure state hydration for projectors and players.
  - **Teacher Projector Experience:**
    - `TugOfWarProjector.tsx` orchestrating lobby and arena states via Supabase Realtime broadcast and Postgres changes.
    - `TugOfWarLobby.tsx`: Dual high-contrast QR codes (`?tug=<code>&team=BLUE` vs `?tug=<code>&team=RED`), live participant lists, fullscreen trigger, sound toggles, and start button.
    - `TugOfWarArena.tsx`: 3-column projector layout matching reference visual designs. Navy header (`#0f172a`), central timer pill, blue vs red score cards, animated SVG rope with dynamic tension offset, 3v3 pulling student avatars, keyboard hotkeys (Q/W/A/S for Blue, O/P/K/L for Red) for testing/emergency, Web Audio synthesized sound FX, frost freeze overlays, and victory celebration podium modal.
  - **Student Mobile SPA:**
    - Isolated `#view-tug` container in `student/index.html` with dedicated CSS in `student/styles.css`.
    - Responsive controller in `student/app.js` (`loadTugFromUrl`, `initTugSession`, `submitTugAnswer`, `showTugFreeze`), supporting seamless transition between lobby, active question answering, frost freeze timer countdown, and game conclusion screens.

- **Database Migrations:**
  - `supabase/migrations/20261015010000_tug_of_war_game.sql`: Initial schema for `public.tug_of_war_sessions`, indices, RLS policies, realtime publication, and 4 RPCs.
  - Mirrored in `supabase/schema.sql`.

- **API & TypeScript Contracts:**
  - `web/src/lib/types.ts`: Added `TugOfWarSessionStatus`, `TugOfWarTeam`, `TugOfWarParticipant`, `TugOfWarQuestionItem`, `TugOfWarSessionRow`, `TugOfWarSessionDetail`.
  - `web/src/lib/tugOfWar.ts`: Type-safe client persistence helper library (`createTugOfWarSession`, `getTugOfWarSession`, `startTugOfWarSession`, `submitTugOfWarAnswer`, `joinTugOfWarLobby`, `generateDistinctQuestionOrders`).

## 3. Impacted Files
- `supabase/migrations/20261015010000_tug_of_war_game.sql`: New migration script defining `tug_of_war_sessions` table, RLS, publication, and 4 transactional RPCs.
- `supabase/schema.sql`: Appended Tug of War database definition to the master canonical schema.
- `web/src/lib/types.ts`: Added TypeScript interfaces and type definitions for Tug of War sessions and participants.
- `web/src/lib/tugOfWar.ts`: Data access layer and question permutation algorithm.
- `web/src/components/ClassRosterManager.tsx`: Added Class view tab switcher and Classroom Game Hub card grid.
- `web/src/components/games/tug-of-war/CreateTugOfWarModal.tsx`: Modal for team group mapping, exam question sampling, and game parameter configuration.
- `web/src/components/games/tug-of-war/TugOfWarQrCode.tsx`: SVG/Canvas QR code generator for student mobile joins.
- `web/src/components/games/tug-of-war/TugOfWarLobby.tsx`: Stadium lobby with dual team QR codes, live rosters, and audio effects.
- `web/src/components/games/tug-of-war/TugOfWarArena.tsx`: Live game arena projector with animated SVG tug of war athletes, tension knot, freeze states, and victory podium.
- `web/src/components/games/tug-of-war/TugOfWarProjector.tsx`: Top-level orchestrator container managing Realtime subscriptions.
- `web/src/app/games/tug-of-war/[id]/page.tsx`: Primary Next.js route for Tug of War projector.
- `web/src/app/tug-of-war/[id]/page.tsx`: Route alias for convenience.
- `student/index.html`: Added `#view-tug` mobile layout with check-in, lobby, question cards, freeze overlay, and results screens.
- `student/styles.css`: Added mobile styles for Tug of War screens, glowing team cards, and frost freeze overlays.
- `student/app.js`: Added URL query handler `loadTugFromUrl` and game controller logic.
- `tests/e2e_flow_verification.mjs`: Added Step 53 validating permutation invariants, component contracts, mobile screens, migration syntax, and live database RPC operations.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npm run build` in `web/`: Next.js 16.3.8 Turbopack build succeeded with 0 errors and generated all static/dynamic routes including `/games/tug-of-war/[id]` and `/tug-of-war/[id]`.
  - `node --check tests/e2e_flow_verification.mjs`: Succeeded with exit code 0.
  - Step 53 Contract & Invariant Suite:
    - 53a: Verified distinct permutations of correct length across 50 runs; confirmed `blueOrder[0] !== redOrder[0]` invariant.
    - 53b: Verified code contracts and export signatures in `web/src/lib/tugOfWar.ts`, `ClassRosterManager.tsx`, `student/app.js`, and `student/index.html`.
    - 53c: Verified SQL migration elements, RPC definitions, and `supabase_realtime` publication.
    - All 8 assertions in Step 53 unit/contract suite passed (8 passed, 0 failed).
- **Rollback Strategy:**
  - Revert database migration via `DROP TABLE IF EXISTS public.tug_of_war_sessions CASCADE;` and drop associated RPC functions (`join_tug_of_war_lobby`, `start_tug_of_war_session`, `submit_tug_of_war_answer`, `get_tug_of_war_session`).
  - Delete `web/src/components/games/tug-of-war/` and `web/src/lib/tugOfWar.ts`.
  - Revert changes to `ClassRosterManager.tsx`, `student/index.html`, `student/styles.css`, and `student/app.js` using git.
