# Change Report: Tree Arena — Lobby QR Waiting Room, Pre-Flight Roster Config & Game Modes

- **Date:** 2026-10-08
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Add a real lobby vertical to the Tree of Knowledge arena. A session is
  now created in a `LOBBY` state, shows a QR/PIN waiting room on the projector, and only
  accepts answers after the teacher presses **BẮT ĐẦU THI ĐẤU** (which atomically moves it
  to `ACTIVE`). The teacher can tune the roster before kickoff — mark students absent and
  move them between Tổ — and choose a game mode (`BRAINSTORM` free-text or `SPEED_QUIZ`).
- **Root Cause / Motivation:** Phases 7/8.4 shipped a working 2×2 arena, but a session was
  instantly submittable the moment it was created: no waiting room, no way to mark a
  student absent, and only one activity type. The competitive flow had no "ready" gate.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - `tree_sessions` gains `status` (`LOBBY|ACTIVE|FINISHED`), `session_code` (short
    uppercase PIN/QR join token), `game_mode` (`BRAINSTORM|SPEED_QUIZ`), `exam_id`,
    `target_score`, `participant_config` (JSONB), `started_at`, `ends_at`.
  - `status` is added **alongside** the pre-existing `is_active` boolean and kept in sync
    (`start_tree_session` writes both, `endTreeSession` closes both). For rows that predate
    this phase, `status` is backfilled from `is_active`, so a historical open session stays
    submittable instead of silently becoming an un-startable lobby.
  - `participant_config = {"absent_ids": [member uuid], "assignments": {member uuid: team}}`.
    An absent student is excluded from their Tổ's `team_counts` denominator (so the team's
    100% stays reachable) and cannot submit. An `assignments` override wins over the roster
    `team_number` everywhere the team is resolved — the tally, the candidate list, the
    public payload and `submit_tree_answer` — so the projector and the SPA never disagree.
- **Database Migrations:**
  - `supabase/migrations/20261008020000_tree_arena_lobby_roster_modes.sql`:
    1. Schema alterations (idempotent; `status` inside a `DO` block with a corrective
       backfill, so `add column ... default 'LOBBY'` cannot strand running sessions).
    2. `start_tree_session(p_session_id uuid)` — teacher-only, `SECURITY DEFINER` with an
       explicit `tree_sessions.user_id` ownership check; `INVALID_STATE` guard; stamps
       `status = 'ACTIVE'`, `is_active = true`, `started_at`, `ends_at`.
    3. `get_public_tree_session(p_session_code varchar, p_student_code varchar default null)`
       — signature changed (the old 1-arg form is dropped first, the documented anti-overload
       pattern). Accepts **either** the session uuid (legacy `?session=` links) **or** the
       short `session_code`. Returns `status`, `game_mode`, `exam_id`, `target_score`,
       `time_remaining_seconds`, `started_at`, `ends_at`, `is_absent`, `team_number`,
       `student_name`.
    4. `submit_tree_answer` — signature **unchanged** (only guards added): `NOT_STARTED`
       while in the lobby, `STUDENT_ABSENT` for an absent student, and the `assignments`
       team override.
  - `supabase/schema.sql` mirrors all four parts (§A.10 table, §C.15b `start_tree_session`,
    §C.17 `get_public_tree_session`, `submit_tree_answer`, and the ACL block).
  - Both teacher RPCs are `revoke … from public` **and** `from anon` (Supabase grants `anon`
    EXECUTE directly, so a PUBLIC-only revoke would leak), then `grant … to authenticated`.
- **API Contracts:**
  - `GET get_public_tree_session(p_session_code, p_student_code?)` — anon-callable; a LOBBY
    session is readable (the waiting room must load), only `FINISHED` / a closed `ACTIVE`
    session is refused. Expiry is anchored on `ends_at` once started, falling back to the
    legacy `created_at + time_limit_minutes` while still in the lobby.
  - `start_tree_session(p_session_id)` — teacher-only; returns `{ started_at, ends_at }`.

### Spec Drift (adapted to the real schema, deliberately)

The task draft assumed columns that do not exist in this codebase (`duration_minutes`,
`prompt_question`, `c.teacher_id`, `session_code` as the join key, and `status` as the only
submission gate). The intent was implemented **additively**:

1. `status` coexists with `is_active` rather than replacing it (replacing it would have been
   a high-blast-radius change for ~6 call sites for no functional gain).
2. `session_code` is a new unique short code; the RPC accepts either form, so no existing
   join link breaks.
3. `submit_tree_answer`'s signature is unchanged (changing it discards the ACL and breaks
   every caller); only the two new gates plus the team override were inserted.
4. `get_public_tree_session`'s signature **does** change (it needs `p_student_code` for the
   student-aware lobby screen); the old 1-arg form is dropped first.

## 3. Impacted Files

- `supabase/migrations/20261008020000_tree_arena_lobby_roster_modes.sql`: new migration (schema + 3 RPCs + ACLs).
- `supabase/schema.sql`: mirror of the table, RPCs and ACL block.
- `web/src/lib/types.ts`: `TreeSessionStatus`, `TreeGameMode`, `ParticipantConfig`, `EMPTY_PARTICIPANT_CONFIG`, `TreeRosterEntry`; `TreeSessionRow`/`TreeSessionDetail` extended.
- `web/src/lib/tree.ts`: `TREE_SESSION_COLUMNS` extended; `createTreeSession` forces `status: 'LOBBY'`/`is_active: false` and validates per mode; new `startTreeSession`; `getTreeSession` selects `class_members` and maps `roster`; `endTreeSession` also writes `status: 'FINISHED'`.
- `web/src/components/tree/TreeRosterPlanner.tsx`: **new** — 4 Cây columns + a "Vắng mặt" column, "Chia đều 4 cây" and "Tất cả có mặt" actions; emits `ParticipantConfig` only (never writes `class_members`).
- `web/src/components/tree/CreateTreeSessionModal.tsx`: **rewritten** — game-mode picker, target score, lazy exam selector for SPEED_QUIZ, the roster planner, submit label "Tạo phòng chờ".
- `web/src/components/tree/TreeLobby.tsx`: **new** — big QR, PIN (`session_code`), 4 team cards with member chips, "BẮT ĐẦU THI ĐẤU 🚀".
- `web/src/components/tree/TreeProjector.tsx`: imports `startTreeSession`/`TreeLobby`; `buildJoinUrl` prefers `session_code` (`?tree=<code>`); LOBBY early-return; `deadline` anchors on `endsAt`; `handleEndSession` sets `FINISHED`.
- `student/index.html`: `#treeSpectatorCard`, `#treeLobbyCard`, `#treeModeBadge`, `#treeTimeBadge`, `#treeQuizPrompt`.
- `student/app.js`: `?code=` link support; RPC switched to `p_session_code`/`p_student_code`; `renderTreeLobby`/`renderTreeSpectator`; a second Realtime subscription on `tree_sessions`; `applyTreeModePresentation` + local countdown; `NOT_STARTED`/`STUDENT_ABSENT` branch handling; vitality anchored on `started_at`.
- `student/styles.css`: `.tree-badge--time` (+ `.is-urgent`) and `.tree-quiz-prompt`.
- `tests/e2e_flow_verification.mjs`: **Step 44** (38 assertions); Steps 28/30/31/35 fixtures updated for the LOBBY default and the new RPC signature.

## 4. Verification & Testing

- **Test Commands Executed:**
  - `Get-Content -Raw -Encoding UTF8 <migration> | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1` (applied twice; idempotent — only "already exists, skipping" notices).
  - `npx tsc --noEmit` in `v2/web` → exit 0.
  - `npm run build` in `v2/web` → compiled successfully (5 routes).
  - `node --check student/app.js` → exit 0.
  - `node tests/e2e_flow_verification.mjs` → **955 passed, 0 failed** (twice, back-to-back).
- **Results:** Migration is idempotent; `information_schema` confirms all eight columns with
  the correct defaults/nullability; `pg_proc` confirms exactly one signature per RPC and the
  expected ACLs (`start_tree_session`: `anon=false`, `authenticated=true`;
  `get_public_tree_session`: `anon=true`). Step 44 proves the LOBBY read, the `NOT_STARTED`
  write refusal, the `is_absent` flag + `STUDENT_ABSENT` refusal, the `start_tree_session`
  transition (`ACTIVE` + `is_active` + `started_at`/`ends_at`), the `INVALID_STATE`
  double-start refusal, the assignment-override team routing, and anon's inability to start.
- **Rollback Strategy:**
  1. `git revert` the Phase 9.1 commit (or `git checkout` the previous `schema.sql`/migration set).
  2. The added columns are additive; to fully revert, `drop` the three RPCs and drop the
     `status`, `session_code`, `game_mode`, `exam_id`, `target_score`, `participant_config`,
     `started_at`, `ends_at` columns from `tree_sessions`. Note that `status` backfill is one
     directional — re-running the migration re-derives it from the current `is_active`.
  3. Redeploy the previous teacher web and student SPA bundles.
