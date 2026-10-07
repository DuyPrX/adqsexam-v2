-- ============================================================================
-- PHASE 8.9 — class-gated DOCX self-practice + teacher permission toggle
-- ----------------------------------------------------------------------------
-- WHY
--   Self-practice with a personal .docx (Phase 5.2) was authorised against
--   `public.students` — i.e. against the roster of ANY exam the candidate had
--   ever been imported into. That made the gate a property of historical exam
--   imports rather than of the class the student is actually in, and it gave
--   the teacher no way to switch a group off.
--
--   This migration moves the gate onto the canonical roster container:
--   `public.classes` (Phase 6.1) + `public.class_members`. A teacher can now
--   disable self-practice for one class with a single toggle.
--
-- BEHAVIOUR CHANGE (deliberate, and the point of the phase)
--   Authorisation no longer consults `public.students`. A teacher who has only
--   ever imported exam rosters and never created a `classes` row will find
--   self-practice now answers CLASS_NOT_FOUND. `classes` is the source of truth
--   and `import_class_to_exam()` copies it into exams, so this makes the gate
--   consistent with how rosters are actually managed.
--
-- RESPONSE CONTRACT (replaces the previous one)
--   OLD: { authorized, message, student_name, student_code }
--   NEW: { success, code?, message, class_name, full_name, student_code }
--   `success` + `code` matches every other RPC in this schema. All three
--   consumers in this repository were updated with it:
--     * student/app.js — the .docx authorization call, and
--     * e2e Steps 11 / 32c — whose fixtures were seeded to the new prerequisites.
--
-- SIGNATURE IS UNCHANGED — (p_class_name, p_full_name, p_student_code)
--   so this is a plain `create or replace`: NO `drop function`, therefore no
--   window where the function is absent and no loss of its ACL. (The spec draft
--   proposed a drop "to avoid signature/ACL collision"; there is no collision,
--   and dropping would only have discarded the grants.)
--
-- SECURITY POSTURE
--   `get_public_practice_classes()` is anon-executable and reveals class NAMES
--   across every teacher. That is inherent to the feature — the SPA needs a
--   pick-list of valid classes before the student has identified themselves —
--   and it exposes no member, credential or result data. `verify_student_practice`
--   likewise returns only the caller's own echoed identity.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. classes.allow_practice — the teacher's permission switch
-- ----------------------------------------------------------------------------
-- Inline in the CREATE for a fresh database, plus an idempotency ALTER for one
-- created before this phase (the same pattern as class_members.team_number).
-- `not null default true` backfills existing rows in a single pass, so no row is
-- ever NULL for a column the public gate tests with `IF NOT allow_practice`.
alter table public.classes add column if not exists allow_practice boolean not null default true;

comment on column public.classes.allow_practice is 'Teacher switch: may this class self-practise with a personal .docx (Phase 8.9)? Default true.';

-- Requested by the spec. Low cardinality, so the planner will often prefer a
-- seq scan on a small per-teacher table; kept because it costs nothing and helps
-- once the table grows.
create index if not exists idx_classes_allow_practice on public.classes (allow_practice);

-- ----------------------------------------------------------------------------
-- 2. verify_student_practice — re-pointed at classes + class_members
-- ----------------------------------------------------------------------------
create or replace function public.verify_student_practice(
    p_class_name   varchar,
    p_full_name    varchar,
    p_student_code varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_class   public.classes%rowtype;
    v_member  public.class_members%rowtype;
    v_name    varchar;
    v_class_n varchar;
    -- Tracked explicitly rather than relying on FOUND: a skipped branch would
    -- otherwise leave FOUND holding whatever the PREVIOUS statement set. (Testing
    -- an unassigned RECORD with `IS NULL` would also raise "record is not
    -- assigned yet", which is why the spec draft's shape cannot be used as-is.)
    v_matched boolean := false;
begin
    if p_class_name is null or trim(p_class_name) = '' then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_REQUIRED',
            'message', 'Vui lòng nhập hoặc chọn tên lớp.'
        );
    end if;

    if p_full_name is null or trim(p_full_name) = '' then
        return jsonb_build_object(
            'success', false,
            'code',    'NAME_REQUIRED',
            'message', 'Vui lòng nhập họ và tên của bạn.'
        );
    end if;

    -- Normalized once, in the same shape the SQL comparison uses below.
    v_class_n := lower(regexp_replace(trim(p_class_name), '\s+', ' ', 'g'));
    v_name    := lower(regexp_replace(trim(p_full_name),  '\s+', ' ', 'g'));

    -- 1. Resolve the class by normalized name.
    --
    --    `classes` is per-teacher, so two teachers may own a class of the same
    --    name. ORDER BY puts an ENABLED class first, which is load-bearing
    --    rather than cosmetic: `get_public_practice_classes()` lists a name when
    --    ANY teacher permits practice, so a name offered in that pick-list must
    --    actually verify — ordering by id alone could resolve a listed name to a
    --    different tenant's disabled class and refuse it with
    --    CLASS_PRACTICE_DISABLED. `id` breaks ties deterministically.
    select * into v_class
      from public.classes c
     where lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')) = v_class_n
     order by c.allow_practice desc, c.id
     limit 1;

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_NOT_FOUND',
            'message', 'Lớp học không tồn tại trên hệ thống. Vui lòng kiểm tra lại tên lớp!'
        );
    end if;

    -- 2. The teacher's permission switch.
    if not v_class.allow_practice then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_PRACTICE_DISABLED',
            'message', 'Lớp của bạn hiện đang tạm khóa quyền tự luyện tập. Vui lòng liên hệ giáo viên!'
        );
    end if;

    -- 3. Candidate must be a member of THAT class.
    --
    --    Fast path by student_code when one was supplied; otherwise the
    --    normalized full name. Both are scoped to `class_id`, so membership of a
    --    different class (or a same-named one from another teacher) never
    --    authorises.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select * into v_member
          from public.class_members m
         where m.class_id = v_class.id
           and lower(trim(m.student_code)) = lower(trim(p_student_code))
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        select * into v_member
          from public.class_members m
         where m.class_id = v_class.id
           and lower(regexp_replace(trim(m.full_name), '\s+', ' ', 'g')) = v_name
         -- A class may legitimately hold two students with the same name
         -- ((class_id, student_code) is the unique key, not the name); the lowest
         -- code is a stable pick. Nothing further is asserted on the row, so a
         -- wrong pick cannot escalate — it only echoes that row's own identity.
         order by m.student_code
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        return jsonb_build_object(
            'success', false,
            'code',    'STUDENT_NOT_FOUND',
            'message', 'Thông tin học sinh không có trong danh sách của lớp này.'
        );
    end if;

    -- Canonical spelling from the roster row, so the client can greet the
    -- student and reuse the code.
    return jsonb_build_object(
        'success',      true,
        'class_name',   v_class.name,
        'full_name',    v_member.full_name,
        'student_code', v_member.student_code
    );
end;
$$;

revoke all on function public.verify_student_practice(varchar, varchar, varchar) from public;
grant execute on function public.verify_student_practice(varchar, varchar, varchar) to anon, authenticated;

comment on function public.verify_student_practice(varchar, varchar, varchar) is
    'Public gate for personal-.docx self-practice. Class must exist and have allow_practice = true, and the candidate must be a class_members row of THAT class (Phase 8.9).';

-- ----------------------------------------------------------------------------
-- 3. get_public_practice_classes — the student's class pick-list
-- ----------------------------------------------------------------------------
-- Anon-executable by design: the SPA populates a datalist from it BEFORE the
-- student has identified themselves. DISTINCT because `classes` is per-teacher
-- and two teachers may share a class name; the same name must appear once.
create or replace function public.get_public_practice_classes()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_classes jsonb;
begin
    select jsonb_agg(distinct c.name order by c.name asc)
      into v_classes
      from public.classes c
     where c.allow_practice = true;

    return jsonb_build_object(
        'success', true,
        -- coalesce, not `[]`: jsonb_agg over zero rows yields NULL, and the
        -- client iterates this unconditionally.
        'classes', coalesce(v_classes, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_public_practice_classes() from public;
grant execute on function public.get_public_practice_classes() to anon, authenticated;

comment on function public.get_public_practice_classes() is
    'Distinct class names with allow_practice = true, for the student SPA class pick-list (Phase 8.9).';
