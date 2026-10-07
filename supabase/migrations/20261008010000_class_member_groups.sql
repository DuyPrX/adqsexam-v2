-- ============================================================================
-- PHASE 8.11 — class member group management + auto-balancing
-- ----------------------------------------------------------------------------
-- WHY
--   The teacher roster (`public.classes` + `public.class_members`, Phase 6.1)
--   could already carry a competition TEAM — `team_number` 1..4, Phase 8.4 —
--   because the Tree of Knowledge arena splits one class into four independent
--   trees. That field is an ARENA concept: `submit_tree_answer` reads it,
--   `get_public_tree_session` exposes it to anon clients, and it is capped at 4.
--
--   A teacher also needs a plain CLASSROOM grouping ("Tổ / Nhóm") for ordinary
--   seat-work: up to 8 groups, freely re-shuffled before a lesson, with no
--   bearing on the arena. Reusing `team_number` for that would be wrong in both
--   directions:
--     * it caps at 4, so "chia 6 tổ" would be impossible, and
--     * re-shuffling seat groups would silently re-partition the arena's trees.
--
--   So this migration adds a SEPARATE `group_number` (1..8). The two fields are
--   deliberately independent: nothing in this phase reads or writes
--   `team_number`, and the arena is unaffected. (The CSV importer routes the
--   `To_nhom`/`Tổ`/`team` headers to `team_number` and the `group`/`Nhóm`
--   headers to `group_number`, so a file may populate either or both.)
--
-- RANGE / CONSTRAINT NAME
--   `check (group_number between 1 and 8)`, auto-named
--   `class_members_group_number_check` by Postgres's `<table>_<column>_check`
--   convention — the same rule that produced `class_members_team_number_check`.
--
-- AUTHORIZATION
--   Both RPCs are SECURITY DEFINER (the house pattern for teacher RPCs, e.g.
--   `import_class_to_exam`), so RLS is BYPASSED inside the body: each therefore
--   re-checks ownership EXPLICITLY against `classes.user_id`. The
--   `... from public` / `... from anon` revokes then make them
--   authenticated-only, so a student client cannot reach them at all.
--
-- SPEC DRIFT
--   The task draft referenced `c.teacher_id`, which does not exist — the
--   ownership column on `public.classes` is `user_id` (Phase 6.1). Corrected.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. class_members.group_number — the classroom group (Tổ / Nhóm)
-- ----------------------------------------------------------------------------
-- Mirrors the `team_number` pattern: the column is declared inline in the
-- CREATE for a fresh database, and this idempotent ALTER adds it to one created
-- before this phase. `not null default 1` backfills existing rows in a single
-- pass, so no member is ever NULL for a column the balance RPC always writes.
-- Note that `add column if not exists` skips the WHOLE statement when the column
-- already exists — inline CHECK included — which is exactly why the constraint
-- needs no separate guard for the pre-existing-COLUMN case.
alter table public.class_members
    add column if not exists group_number smallint not null default 1
    check (group_number between 1 and 8);

comment on column public.class_members.group_number is
    'Classroom group (Tổ/Nhóm) 1..8 for seat-work, independent of the Phase 8.4 arena team_number (1..4). (Phase 8.11)';

-- Supports both the per-class roster read and the group filter/pills.
create index if not exists idx_class_members_group
    on public.class_members (class_id, group_number);

-- ----------------------------------------------------------------------------
-- 2. update_class_member_group — move ONE member to another group
-- ----------------------------------------------------------------------------
create or replace function public.update_class_member_group(
    p_member_id    uuid,
    p_group_number int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id uuid;
    v_class_id   uuid;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object(
            'success', false,
            'code',    'UNAUTHORIZED',
            'message', 'Yêu cầu đăng nhập giáo viên.'
        );
    end if;

    -- Validated here rather than left to the CHECK constraint: a raw 23514
    -- surfaces to the teacher as an untranslated Postgres error.
    if p_group_number is null or p_group_number < 1 or p_group_number > 8 then
        return jsonb_build_object(
            'success', false,
            'code',    'INVALID_GROUP',
            'message', 'Số tổ phải nằm trong khoảng từ 1 đến 8.'
        );
    end if;

    -- SECURITY DEFINER bypasses RLS, so ownership is asserted explicitly: the
    -- member's parent class must belong to the caller. The join also proves the
    -- member id is real, collapsing "unknown member" and "not yours" into one
    -- indistinguishable answer — a foreign teacher learns nothing either way.
    select cm.class_id into v_class_id
      from public.class_members cm
      join public.classes c on c.id = cm.class_id
     where cm.id = p_member_id
       and c.user_id = v_teacher_id;

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'NOT_FOUND',
            'message', 'Không tìm thấy học sinh hoặc bạn không có quyền.'
        );
    end if;

    update public.class_members
       set group_number = p_group_number::smallint
     where id = p_member_id;

    return jsonb_build_object(
        'success',      true,
        'member_id',    p_member_id,
        'group_number', p_group_number
    );
end;
$$;

revoke all on function public.update_class_member_group(uuid, int) from public;
-- Required explicitly: Supabase's database default privileges grant EXECUTE to
-- `anon` DIRECTLY, so `revoke ... from public` alone would leave it reachable.
revoke all on function public.update_class_member_group(uuid, int) from anon;
grant execute on function public.update_class_member_group(uuid, int) to authenticated;

comment on function public.update_class_member_group(uuid, int) is
    'Teacher-only: set one class_members.group_number (1..8). Ownership asserted via classes.user_id (Phase 8.11).';

-- ----------------------------------------------------------------------------
-- 3. auto_balance_class_groups — evenly re-partition a whole class
-- ----------------------------------------------------------------------------
create or replace function public.auto_balance_class_groups(
    p_class_id   uuid,
    p_num_groups int     default 4,
    p_randomize  boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id     uuid;
    v_total_assigned int;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object(
            'success', false,
            'code',    'UNAUTHORIZED',
            'message', 'Yêu cầu đăng nhập giáo viên.'
        );
    end if;

    if p_num_groups is null or p_num_groups < 1 or p_num_groups > 8 then
        return jsonb_build_object(
            'success', false,
            'code',    'INVALID_GROUP_COUNT',
            'message', 'Số lượng tổ phải từ 1 đến 8.'
        );
    end if;

    -- Same explicit ownership check as above (SECURITY DEFINER bypasses RLS).
    if not exists (
        select 1 from public.classes c
         where c.id = p_class_id
           and c.user_id = v_teacher_id
    ) then
        return jsonb_build_object(
            'success', false,
            'code',    'NOT_FOUND',
            'message', 'Lớp học không tồn tại hoặc bạn không có quyền.'
        );
    end if;

    -- Round-robin over a RANKED list. Assigning `rank % n + 1` gives group sizes
    -- that differ by at most 1 for ANY member count — 13 members over 4 groups
    -- become 4/3/3/3 — which is exactly the balance guarantee Step 43 asserts.
    --
    -- `case when p_randomize then random() end` (no ELSE) yields NULL for every
    -- row when randomising is off; NULLs compare equal, so the sort falls
    -- through to `full_name` — i.e. "chia theo thứ tự danh sách" is a plain
    -- alphabetical split, and the same class always splits the same way.
    -- `id` is the final tie-break so two identically-named students still get a
    -- deterministic order.
    with ordered_members as (
        select cm.id,
               row_number() over (
                   order by case when p_randomize then random() end,
                            cm.full_name asc,
                            cm.id asc
               ) - 1 as row_idx
          from public.class_members cm
         where cm.class_id = p_class_id
    ),
    assignments as (
        select om.id,
               ((om.row_idx % p_num_groups) + 1)::smallint as assigned_group
          from ordered_members om
    )
    update public.class_members cm
       set group_number = a.assigned_group
      from assignments a
     where cm.id = a.id;

    -- ROW_COUNT after a joined UPDATE is the number of rows actually written.
    get diagnostics v_total_assigned = row_count;

    return jsonb_build_object(
        'success',        true,
        'class_id',       p_class_id,
        'total_assigned', v_total_assigned,
        'num_groups',     p_num_groups
    );
end;
$$;

revoke all on function public.auto_balance_class_groups(uuid, int, boolean) from public;
revoke all on function public.auto_balance_class_groups(uuid, int, boolean) from anon;
grant execute on function public.auto_balance_class_groups(uuid, int, boolean) to authenticated;

comment on function public.auto_balance_class_groups(uuid, int, boolean) is
    'Teacher-only: re-partition a class into 1..8 balanced groups, randomly or in name order. Group sizes differ by at most 1 (Phase 8.11).';
