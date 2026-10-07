# Change Report: Class Member Group Management & Auto-Balancing (Phase 8.11)

- **Date:** 2026-10-08
- **Scope:** Major Change (DB schema + 2 RPCs + web lib/UI + tests)
- **Author/Agent:** TraeCode agent
- **Status:** Verified

## 1. Context & Rationale

- **Objective:** Give teachers a classroom grouping ("Tổ / Nhóm") for a class roster —
  a per-student group number with an inline editor, colour-coded badges, group filter
  pills, and two one-click auto-balance actions (random shuffle, or an ordered split).
- **Root Cause / Motivation:** The roster could already carry a competition **team**
  (`class_members.team_number` 1..4, Phase 8.4), but that field is an **arena** concept:
  `submit_tree_answer` reads it, `get_public_tree_session` exposes it to anon clients,
  and it is capped at four. A teacher also needs an ordinary seat-work grouping — up to
  8 groups, freely reshuffled between lessons, with no effect on the arena. Reusing
  `team_number` would have failed in both directions: it caps at 4 (so "chia 6 tổ" is
  impossible) and reshuffling seat groups would silently re-partition the arena's trees.

## 2. Technical Implementation Details

- **Architecture / Core Logic:**
  - **`class_members.group_number smallint NOT NULL DEFAULT 1 CHECK (1..8)`** — a new
    column, deliberately **independent** of `team_number`. A `(class_id, group_number)`
    index backs the filter. `not null default 1` backfills in one pass.
  - **`update_class_member_group(p_member_id, p_group_number)`** — moves one member.
    Validates the range in-body (`INVALID_GROUP`) rather than letting a raw 23514 reach
    the teacher untranslated.
  - **`auto_balance_class_groups(p_class_id, p_num_groups DEFAULT 4, p_randomize DEFAULT true)`**
    — re-partitions the whole class. Round-robin over a `row_number()`-ranked list, so
    group sizes differ by **at most 1 for any member count** (13 over 4 ⇒ 4/3/3/3).
    `case when p_randomize then random() end` (no `ELSE`) yields NULL for all rows when
    randomising is off, so the sort falls through to `full_name` — the ordered split is a
    deterministic alphabetical partition, reproducible run to run. `id` is the final
    tie-break for identically-named students.
  - **Authorization.** Both RPCs are `SECURITY DEFINER` (the house pattern, e.g.
    `import_class_to_exam`), so RLS is **bypassed inside the body** — each therefore
    re-checks ownership **explicitly** against `classes.user_id`. They are then
    `revoke`d from PUBLIC **and from `anon`** (Supabase's database default privileges
    grant EXECUTE to `anon` directly, so a PUBLIC-only revoke is insufficient) and
    granted to `authenticated` alone.
  - **CSV import.** `To_nhom`/`tổ`/`team` still route to `team_number`; a new
    `group`/`nhóm`/`group_number` header routes to `group_number`. `group_number` is
    **optional** in `ClassMemberInput`: a blank cell leaves it `undefined` so a
    re-import does not scatter a group layout the teacher arranged with the auto-balance
    buttons. The template ships both columns.
  - **Web UI.** `ClassRosterManager` gains a group toolbar (🎲 random / 📋 ordered
    buttons + `Tất cả`/`Tổ 1..4` filter pills with live counts), a `Tổ / Nhóm` column
    with colour-coded badges (blue/green/amber/purple for 1..4, four more for 5..8), and
    an invisible `<select>` layered over each badge for instant switching. Edits are
    optimistic via an override map and revert individually on failure.
- **Database Migrations:** `20261008010000_class_member_groups.sql`
  - `alter table public.class_members add column if not exists group_number ...`
  - `create index if not exists idx_class_members_group ...`
  - `create or replace function public.update_class_member_group(uuid, int)`
  - `create or replace function public.auto_balance_class_groups(uuid, int, boolean)`
  - Collateral: the constraint is auto-named `class_members_group_number_check` by
    Postgres's `<table>_<column>_check` convention.
- **API Contracts:**
  - `update_class_member_group(uuid, integer) → {success, member_id, group_number}`,
    error codes `UNAUTHORIZED` / `INVALID_GROUP` / `NOT_FOUND`.
  - `auto_balance_class_groups(uuid, integer, boolean) → {success, class_id, total_assigned, num_groups}`,
    error codes `UNAUTHORIZED` / `INVALID_GROUP_COUNT` / `NOT_FOUND`.

## 3. Impacted Files

- `supabase/migrations/20261008010000_class_member_groups.sql` *(new)*
- `supabase/schema.sql` — the column + idempotency ALTER + index + comments; §C.18/C.19
  RPCs; ACL revoke/grant pairs (including the `from anon` revoke).
- `web/src/lib/types.ts` — `ClassMemberRow.group_number`; `GroupNumber`; `GROUP_NUMBERS`;
  optional `ClassMemberInput.group_number`.
- `web/src/lib/excel.ts` — `GROUP_HEADERS` (disjoint from `TEAM_HEADERS`),
  `normalizeGroupNumber`, group column parsing.
- `web/src/lib/classes.ts` — `MEMBER_COLUMNS`; optional `group_number` in
  `saveClassMembers`; new `updateMemberGroup` / `autoBalanceClassGroups`.
- `web/src/lib/studentTemplate.ts` — ships a `Nhom` column and sample values.
- `web/src/components/ClassRosterManager.tsx` — `GROUP_BADGE_CLASSES`, group state,
  optimistic handlers, toolbar (auto-balance + pills), `Tổ / Nhóm` column.
- `tests/e2e_flow_verification.mjs` — Step 43 (27 assertions); template/parser
  assertions updated for the new column.

## 4. Verification & Testing

- **Test Commands Executed:**
  - Migration applied locally → `ALTER TABLE / COMMENT / CREATE INDEX / CREATE FUNCTION ×2 / REVOKE ×4 / GRANT ×2`
  - **Re-applied** (idempotency) → only `NOTICE: column "group_number" of relation
    "class_members" already exists, skipping` and the matching index notice.
  - `information_schema` → `group_number | smallint | default 1 | NO`
  - `pg_constraint` → `class_members_group_number_check => CHECK (((group_number >= 1) AND (group_number <= 8)))`
    (auto-named exactly as predicted)
  - ACL probe → `anon:false, auth:true`
  - `npx tsc --noEmit` → exit 0; `npm run build` → 5/5 static pages
  - `node tests/e2e_flow_verification.mjs` → **905 passed, 0 failed** (run twice)
- **Results:** Baseline 867 → **+38** net. Step 43 covers:
  - 43a: column type/default/nullability, the CHECK constraint, the index, both RPCs'
    ACLs (`anon` refused, `authenticated` allowed) and single-signature discipline.
  - 43b: a 13-member class; an insert **omitting** the column defaults to group 1.
  - 43c: the constraint rejects `group_number = 9` and `= 0`.
  - 43d: `total_assigned = 13`, `num_groups = 4`, all members in groups 1..4, the split
    is balanced (`max − min ≤ 1`) and is exactly `4/3/3/3`; the ordered split is
    byte-identical on re-run and follows the roster order (1,2,3,4,1,…).
  - 43e: a manual switch persists; `INVALID_GROUP`, `NOT_FOUND` (unknown member),
    `NOT_FOUND` (unknown class) and `INVALID_GROUP_COUNT` are all returned.
  - 43f: an **anon** client cannot call the RPC, and writing `group_number` leaves
    `team_number` untouched (the arena-independence guard).
  - 43g: the web layer is wired — `MEMBER_COLUMNS`, both RPC wrappers, the CSV group
    header, all four badge colours, the pills and both auto-balance buttons.
- **Test defects caught and fixed during this phase:**
  1. My first `43d` "repeatable" check only asserted the *second call succeeded*, which
     was tautological. Rewritten to compare the full `(student_code, group_number)`
     assignment across two runs.
  2. `const ordered` collided with an existing binding in the same scope (the harness
     parses-and-runs the whole file) → renamed to `orderedSplit`.
- **Rollback Strategy:**
  1. `git revert <this commit>` plus
     `drop function public.auto_balance_class_groups(uuid,int,boolean); drop function public.update_class_member_group(uuid,int);`
     — the column is additive and can be left in place harmlessly.
  2. `team_number` and the arena were never touched, so the Tree of Knowledge needs no
     rollback.
  3. The web/SPA clients read `group_number` only through `MEMBER_COLUMNS`; dropping the
     column requires reverting `classes.ts` in step.

## 5. Deviations From The Task Spec (and why)

| Spec draft | Reality | Resolution |
|---|---|---|
| `c.teacher_id` in both RPC ownership checks | `public.classes` has no `teacher_id`; ownership is `user_id` (Phase 6.1) | Used `c.user_id` |
| New `group_number` column, range 1..8 | `class_members.team_number` (Tổ, 1..4) already exists for the arena | Confirmed with the user: added a **separate** `group_number`; `team_number` untouched |
| CSV headers `/^(t[oổ]\|nh[oó]m\|group)$/i` → `group_number` | Those `tổ`/`nhóm` spellings were already wired to `team_number` (Phase 8.4) | Split: `group`/`nhóm` → `group_number`, `tổ`/`to`/`team` stay on `team_number`; the template ships both columns |
| New standalone migration | — | Also mirrored into `schema.sql` (column, §C.18/C.19, ACL block) per project policy |
| `auto_balance` "shuffles members before partitioning" | A plain `random()` in `ORDER BY` would be non-deterministic without a seed | Implemented as a `row_number()` round-robin over a randomized (or name-ordered) rank — sizes differ by ≤1, and the ordered mode is exactly reproducible |
