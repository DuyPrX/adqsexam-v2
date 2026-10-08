# Change Report: Tree Arena — group_number Assignment Priority & Hidden Brainstorm Target UI

- **Date:** 2026-10-08
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Two Phase 9.2 follow-ups:
  1. `buildInitialAssignments` must read `group_number` (1..8) BEFORE the legacy `team_number`
     (1..4). `group_number` is the field the teacher maintains in the class roster, so it is the
     current source of truth; a class partitioned 12/12/12/10 by groups must be preserved exactly,
     not collapsed to 12/12/11/11 by a stale `team_number`.
  2. The "Điểm mục tiêu" (target score) field must be HIDDEN entirely in BRAINSTORM mode (only
     rendered for SPEED_QUIZ), and no target-score badge may appear in the lobby, the projector's
     per-team status cards, or the student SPA.
- **Root Cause / Motivation:** Phase 9.2's resolver preferred `team_number`, which the roster no
  longer maintains, so a `group_number` layout was silently mis-mapped whenever the legacy arena
  values disagreed. And the BRAINSTORM target, being derived, was shown as a read-only badge — a
  control the teacher cannot act on invites confusion.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - `web/src/lib/tree.ts` → `buildInitialAssignments`: priority is now `group_number` (1..8) →
    `((group_number - 1) % 4) + 1` → `team_number` (1..4) → 1. A group of 1..4 maps directly onto
    Tổ 1..4, a group of 5..8 wraps back onto 1..4, preserving the exact 12/12/12/10 partition.
  - `TreeRosterPlanner.tsx` → `teamOf`: mirrors the same priority so a member not yet in
    `config.assignments` lands in the column the seeded config would put them in.
  - `CreateTreeSessionModal.tsx`: the target-score block is now wrapped in `{isSpeedQuiz && (...)}`,
    so BRAINSTORM renders no field at all. The `useEffect` still derives
    `brainstormAutoTarget = max(1, max(activeTeamCounts))` and `handleSubmit` still sends
    `target_score: targetScore`, satisfying the DB's `target_score > 0` CHECK silently.
  - `TreeProjector.tsx`: the per-team status pill is mode-aware — `${done}/${rawTotal} đã nộp`
    in BRAINSTORM (answers over present headcount) and `${done}/${rawTotal} điểm` in SPEED_QUIZ
    (points over the explicit target).
  - `student/app.js`: the mode badge shows the target only for SPEED_QUIZ; BRAINSTORM reads
    `💡 Bão não từ khóa`.
- **Data Model:** No schema change. `target_score` is still written in BRAINSTORM (derived), so the
  existing CHECK constraint and the Phase 9.1/9.2 completion math are unaffected.
- **Key Decisions:**
  - `TreeLobby.tsx` required no change — it never rendered a target-score badge (verified: no
    `target_score` reference). Asserted in Step 46c as a regression guard.
  - The completion denominator in BRAINSTORM remains each team's own present headcount
    (Phase 9.2), so a 10-member Tổ completes at 10 regardless of the derived session target.

## 3. Impacted Files

- `web/src/lib/tree.ts`: `buildInitialAssignments` priority flipped to `group_number`-first.
- `web/src/components/tree/TreeRosterPlanner.tsx`: `teamOf` mirrors the new priority.
- `web/src/components/tree/CreateTreeSessionModal.tsx`: target-score field gated on SPEED_QUIZ.
- `web/src/components/tree/TreeProjector.tsx`: mode-aware per-team progress label (`đã nộp` / `điểm`).
- `student/app.js`: mode badge shows the target only for SPEED_QUIZ.
- `tests/e2e_flow_verification.mjs`: **Step 46** (14 assertions); Step 45 fixtures made
  self-consistent with the new priority (group and team agree, plus new priority/fallback cases).

## 4. Verification & Testing

- **Test Commands Executed:**
  - `npx tsc --noEmit` in `v2/web` → exit 0.
  - `npm run build` in `v2/web` → compiled successfully (9 routes).
  - `node --check tests/e2e_flow_verification.mjs` and `node --check student/app.js` → exit 0.
  - `node tests/e2e_flow_verification.mjs` → **992 passed, 0 failed** (twice, back-to-back).
- **Results:** Step 46 proves a 46-member fixture partitioned `[12,12,12,10]` by `group_number` with
  CONFLICTING legacy `team_number` values resolves to exactly 12/12/12/10 (not 12/12/11/11); the
  auto brainstorm target is 12 (the largest Tổ); Tổ 4 (10 present) reaches `progress: 1.0` and
  `isFinished: true` at `acceptedCount === 10` while 9/10 does not finish and Tổ 1 finishes at its
  own 12; and the target-score input is gated on SPEED_QUIZ in the modal, absent from the lobby, and
  mode-aware in the projector and SPA. Step 45 was updated so its fixture's `group_number` agrees
  with the intended Tổ, plus explicit priority + fallback cases.
- **Rollback Strategy:** `git revert` the Phase 9.3 commit. No migration or data change is
  involved; only the teacher-web bundle and the student SPA need redeploying.
