# Change Report: Tree Arena — Natural Roster Assignment & Adaptive Brainstorm Target Score

- **Date:** 2026-10-08
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Fix two regressions introduced by the Phase 9.1 pre-flight planner:
  1. Opening the creation modal must PRESERVE the class's existing `team_number` layout, not
     silently re-partition it into a modulo-4 split. Auto-balancing must be an explicit
     teacher action.
  2. In `BRAINSTORM`, the target score must be DERIVED from the present roster (the largest
     team's headcount) rather than typed, and each team's completion/vitality must be
     normalised against its OWN present headcount so 100% (the Golden Latch) stays reachable.
- **Root Cause / Motivation:** Phase 9.1's planner seeded its columns but balanced eagerly, and
  the projector divided by the raw `team_counts` (which includes absentees). A class with a
  deliberate team layout was re-shuffled on every modal open, and a team with an absentee could
  never reach 100%.

## 2. Technical Implementation Details

- **Architecture / Core Logic:** Four new PURE, DOM-free helpers in `web/src/lib/tree.ts`, so the
  exact code the UI runs is exercised headless by the e2e suite (a `.tsx` cannot be imported
  under plain Node):
  - `buildInitialAssignments(members)` — natural-team seeding: `team_number` (1..4) →
    `((group_number - 1) % 4) + 1` → 1. NOT a distribution.
  - `balanceTeamAssignments(members, absentIds, current)` — the explicit round-robin over the
    PRESENT members only; absent members keep their prior value.
  - `countActiveMembersPerTeam(roster, config)` — per-team present headcount, applying
    `participant_config` (absentees removed, overrides honoured) exactly as
    `get_public_tree_session` does server-side.
  - `brainstormTargetScore(activeCounts)` → `max(1, max(activeTeamCounts))`.
  - `computeTeamProgress({ gameMode, acceptedCount, activeMembersCount, targetScore })` — the
    mode-aware denominator: BRAINSTORM divides by the team's present headcount (and latches at
    `accepted >= active && active > 0`); SPEED_QUIZ divides by `target_score`.
- **UI Wiring:**
  - `CreateTreeSessionModal.tsx` seeds `config.assignments` from `buildInitialAssignments` when
    the roster loads; `activeTeamCounts` / `brainstormAutoTarget` are `useMemo`s keyed on the
    roster + config, and a `useEffect` binds `target_score` to the derived value in BRAINSTORM.
    The target control is a read-only informational badge in BRAINSTORM ("Tự động theo sĩ số
    tổ: N điểm" / "🎯 1 câu/học sinh") and the editable number input in SPEED_QUIZ.
  - `TreeRosterPlanner.tsx` delegates its balance button to `balanceTeamAssignments` (the only
    caller) and mirrors the natural fallback chain in its `teamOf`.
  - `TreeProjector.tsx` derives `activeMembersPerTeam` from `session.roster` +
    `session.participant_config`, uses each team's own denominator for BOTH the completion
    progress and the tree's growth ratio (so BLOOM coincides exactly with the Golden Latch), and
    anchors vitality on `started_at ?? created_at`.
- **Data Model:** No schema change. The change is purely how the client derives a session's
  pre-flight config and per-team denominators.
- **Key Decisions:**
  - The helpers live in `lib/tree.ts`, not the `.tsx`, so the e2e suite asserts the real shipped
    logic rather than a copy (repo convention).
  - The tree's growth denominator and the completion denominator are the SAME value, so a team
    that reaches 100% is also in BLOOM — no drift when a team is uneven or has absentees.
  - Absent members keep their assignment value (inert, but a toggle absent→present round-trip
    does not lose their natural team).

## 3. Impacted Files

- `web/src/lib/tree.ts`: +5 pure helpers (`buildInitialAssignments`, `balanceTeamAssignments`,
  `countActiveMembersPerTeam`, `brainstormTargetScore`, `computeTeamProgress`) + `ClassMemberRow`
  import.
- `web/src/components/tree/CreateTreeSessionModal.tsx`: natural seeding on load, `activeTeamCounts`
  / `brainstormAutoTarget` memos + sync effect, mode-conditional target control.
- `web/src/components/tree/TreeRosterPlanner.tsx`: balance delegates to the pure helper; natural
  fallback chain in `teamOf`; re-export for discoverability.
- `web/src/components/tree/TreeProjector.tsx`: `activeMembersPerTeam` memo, per-team denominator
  via `computeTeamProgress`, `started_at` vitality anchor.
- `tests/e2e_flow_verification.mjs`: **Step 45** (22 assertions); five new helper imports.

## 4. Verification & Testing

- **Test Commands Executed:**
  - `npx tsc --noEmit` in `v2/web` → exit 0.
  - `npm run build` in `v2/web` → compiled successfully (9 routes).
  - `node --check tests/e2e_flow_verification.mjs` → exit 0.
  - `node tests/e2e_flow_verification.mjs` → **977 passed, 0 failed** (twice, back-to-back).
- **Results:** Step 45 proves: the natural split `3/1/2/0` is preserved and NOT modulo-4 distributed;
  the `group_number` fallback chain; an explicit balance produces `2/2/1/1` (max−min ≤ 1) over the
  present members only with an absent member untouched; the brainstorm target tracks
  `max(activeTeamCounts)` and reacts to both reassignment (3 → 2) and absentee marking (3 → 2); a
  3-present team reaches 100% at 3 answers and is not finished at 2/3; a 4-present + 1-absent team
  finishes at 4; an entirely-absent team divides by 1 and never finishes; SPEED_QUIZ uses the
  explicit target. Step 45e additionally asserts the wiring in all three components.
- **Rollback Strategy:** `git revert` the Phase 9.2 commit. No migration or data change is involved,
  so the DB is unaffected; only the teacher-web bundle needs redeploying.
