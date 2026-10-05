# Change Report: Tree of Knowledge — 4-Team Competition Arena (Phase 8.4)

- **Date:** 2026-10-06
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Turn the single class-wide "Tree of Knowledge" into a gamified
  4-team classroom competition (Tổ 1–4). Each Tổ grows its OWN deterministic
  tree, the first team to reach 100% roster participation is crowned champion
  with a latched 🏆 trophy, and the student SPA shows only the student's own
  team tree plus a live mini-leaderboard.
- **Root Cause / Motivation:** Phase 7.3/8.2 rendered one tree for the whole
  class, so a single 30-student roster diluted any sense of team competition and
  a student could not tell how their own group was doing. Splitting the class
  into four independently-seeded trees (a) makes progress legible at a glance on
  the projector, (b) motivates peer-to-peer participation, and (c) reuses the
  existing engine unchanged by deriving a per-team seed rather than adding new
  drawing code.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - **Database:** `team_number SMALLINT NOT NULL DEFAULT 1 CHECK (team_number BETWEEN 1 AND 4)`
    added to `class_members`, `students` and `tree_submissions`, plus a
    `(session_id, team_number)` index for the arena's per-team filters.
  - **Seed derivation:** `getTeamSeed(baseSeed, teamNumber) = (baseSeed + teamNumber * 7919) >>> 0`.
    The prime keeps the four derived seeds independent while `>>> 0` guarantees
    an unsigned 32-bit integer the Mulberry32 PRNG accepts. `clampTeamNumber()`
    folds any out-of-range/garbage input back into 1..4.
  - **Projector:** the stage became a 2×2 grid of `TeamCard`s, each with its own
    `TreeCanvas` (`seed = getTeamSeed(session.tree_seed, team)` and only that
    team's submissions). A `firstFinishedRef` + `firstFinishedTeam` latch crowns
    the FIRST team to reach `rawTotal > 0 && done >= rawTotal`, paints a golden
    `ring-4 ring-amber-400` frame plus the `🏆 QUÁN QUÂN: TỔ X VỀ ĐÍCH ĐẦU TIÊN!`
    banner, and fires `playBloomFanfare()` exactly once. `isFinished` is guarded
    on the RAW team count so an empty team can never be crowned.
  - **Student SPA:** `state.studentTeam` (resolved at check-in),
    `state.treeTeamCounts` and `state.treeChampionTeam`; `renderTree()` filters
    every Realtime row down to the student's own Tổ, uses that Tổ's roster size
    as the denominator, and seeds from `getTeamSeed()`. `renderLeaderboard()`
    writes a sticky 4-badge strip with `.is-my-team` / `.is-champion` styling.
- **Database Migrations:**
  - `supabase/migrations/20261006000000_tree_team_competition.sql` (new, applied
    locally twice — idempotent, `CREATE INDEX IF NOT EXISTS` + `ADD COLUMN IF
    NOT EXISTS` + `DROP FUNCTION IF EXISTS` before each recreation).
  - `supabase/schema.sql` mirrored: inline + idempotency DDL, §A.7 index,
    rewritten §C.16 `submit_tree_answer` and §C.17 `get_public_tree_session`.
- **API Contracts:**
  - `get_public_tree_session(uuid)` — unchanged signature and result set PLUS
    `team_counts: { "1": n1, ... "4": n4 }` and a `team_number` on every
    candidate (ordered `team_number ASC, student_code ASC`). Still returns
    neither `pin` nor `dob`.
  - `submit_tree_answer(uuid, varchar, varchar, text)` — unchanged signature;
    resolves the author's team from `class_members` (round-robin `((count % 4)+1)`
    fallback for an unassigned student), records it on INSERT and on the upsert,
    and returns `team_number` in the payload.
  - **Correction to the supplied draft (a):** the draft returned a freshly
    computed `MAX(fruit_index) + 1`, but `ON CONFLICT DO UPDATE` deliberately
    leaves `fruit_index` unchanged — so a resubmission would have appeared to
    move the fruit. Phase 7.1's `RETURNING id, fruit_index` (pinned by Step 28f)
    was preserved; only `team_number` was added to the upsert.
  - **Correction (b):** the draft's `generate_series(1,4) team_num` became the
    explicit `generate_series(1, 4) AS g(team_num)` alias to remove ambiguity.
- **Cross-team plagiarism:** the similarity check still spans the WHOLE session
  (`student_code <> author`, no team filter), so one Tổ cannot copy another's
  answer — asserted by Step 35f.

## 3. Impacted Files
- `supabase/migrations/20261006000000_tree_team_competition.sql`: New migration
  (team columns, index, both arena RPCs).
- `supabase/schema.sql`: Mirrored columns/index + rewritten §C.16 / §C.17.
- `student/tree-engine.js`: Added `TEAM_NUMBERS`, `getTeamSeed`, `clampTeamNumber`.
- `web/src/lib/tree-engine.js`: Byte-identical mirror of the above.
- `web/src/lib/tree-engine.d.ts`: Declared the three new engine exports.
- `web/src/lib/tree.ts`: `TREE_SUBMISSION_COLUMNS` + `team_number`,
  `tallyTeamCounts()`, `team_counts` from `getTreeSession`, re-exports.
- `web/src/lib/types.ts`: `TeamNumber` / `TeamCounts`; `team_number` on the
  member/roster/submission rows; `TreeSessionDetail.team_counts`.
- `web/src/lib/studentTemplate.ts`: `To_nhom` header + team-aware sample rows.
- `web/src/lib/excel.ts`: `TEAM_HEADERS`, `normalizeTeamNumber()`, round-robin
  assignment when `To_nhom` is blank/invalid.
- `web/src/lib/classes.ts`: `MEMBER_COLUMNS` + `saveClassMembers` thread
  `team_number`.
- `web/src/components/tree/TreeCanvas.tsx`: New optional `seed` prop.
- `web/src/components/tree/TreeProjector.tsx`: Rewritten into the 2×2 arena with
  the first-to-finish champion latch and per-team `TeamCard`/`FruitTooltip`.
- `student/app.js`: Team-scoped `renderTree`, `latchTreeChampion()`,
  `renderLeaderboard()`, `studentTeam`/`treeTeamCounts` state, `team_number` in
  the submissions select.
- `student/index.html`: `#treeTeamLeaderboard` markup.
- `student/styles.css`: `.tree-leaderboard` + `.is-my-team` / `.is-champion`.
- `tests/e2e_flow_verification.mjs`: New Step 35 (arena); updated Steps 26b/26c,
  30c/30d/30e, 31b and 33e for the new team fields.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `Get-Content -Raw -Encoding UTF8 supabase/migrations/20261006000000_tree_team_competition.sql | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1` (twice — idempotency).
  - `node --check v2/student/app.js` and `node --check v2/student/tree-engine.js`.
  - `npm run build` in `v2/web/`.
  - `node v2/tests/e2e_flow_verification.mjs`.
- **Results:**
  - Migration: second run logs `NOTICE: … already exists, skipping` on every
    object and exits 0 (idempotent).
  - `node --check`: both files clean.
  - `npm run build`: exit 0 (TypeScript included — two initial type errors,
    a missing `clampTeamNumber` import in `tree.ts` and a `number`→`TeamNumber`
    mismatch in the projector, were fixed).
  - Full suite: **588 passed, 0 failed** (previous baseline 553 → **+35**),
    including the new Step 35 (25 assertions): 8-member / 2-per-Tổ class,
    `team_counts = {1:2,2:2,3:2,4:2}`, valid per-candidate `team_number`, four
    distinct `getTeamSeed` values, Team 1 reaching BLOOM at 2/2 while 2–4 stay
    at SEED, the unique-finisher champion rule, and the cross-team
    `SIMILARITY_EXCEEDED` refusal.
- **Rollback Strategy:** revert the commit and re-run
  `supabase/migrations/20261005120000_tree_of_knowledge_core.sql` +
  `20261005130000_get_public_tree_session_rpc.sql` (plus `20261005140000` for
  the Phase 8.1 signature changes) after dropping the three `team_number`
  columns and `idx_tree_submissions_session_team`; the previous RPC bodies are
  preserved verbatim in `schema.sql`'s git history. No data loss: the columns are
  additive with a `DEFAULT 1`.
