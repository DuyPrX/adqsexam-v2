-- ============================================================================
-- PHASE 6.1 — CLASS ROSTER MANAGEMENT & FLEXIBLE PIN AUTHENTICATION
-- ----------------------------------------------------------------------------
-- Two additions, both teacher-controlled:
--
--   1. Independent class rosters (`classes` + `class_members`) that exist
--      OUTSIDE any exam, so a teacher maintains a class once and imports it into
--      as many exams as needed via `import_class_to_exam()`.
--
--   2. Per-exam PIN policy with three modes:
--        NONE       -> no PIN at all (open sitting).
--        GLOBAL     -> one shared PIN stored on the exam.
--        INDIVIDUAL -> per-student PIN, falling back to the student's date of
--                      birth as DDMM (e.g. 2008-09-05 -> '0509').
--
-- `INDIVIDUAL` is the DEFAULT because it is the strict mode, yet it degrades to
-- "pass" for a roster that carries neither `pin` nor `dob` (see the function
-- body). That is what keeps every exam and every `students` row created before
-- this migration working unchanged: they all have NULL pin/dob, so no student
-- is suddenly locked out.
--
-- ----------------------------------------------------------------------------
-- HAZARD ADDRESSED: replacing a function that gains a parameter
-- ----------------------------------------------------------------------------
-- `create or replace function` matches on the function's SIGNATURE. Adding
-- `p_pin` therefore does NOT replace the existing 6-argument function — it
-- creates a second OVERLOAD, leaving the original PIN-LESS function still
-- callable by `anon`. That would be a complete PIN bypass.
--
-- Verified locally before writing this file:
--   create function f(a varchar) ...;
--   create or replace function f(a varchar, b varchar default null) ...;
--   -> pg_proc lists BOTH; `select f('x')` fails with
--      "function f(unknown) is not unique".
--
-- The old signature is therefore DROPPED explicitly below. (Checked first: no
-- view, policy or function depends on it, so the drop is safe.)
-- ============================================================================

begin;

-- set search_path is not needed here, but the file follows the house style of
-- wrapping DDL in a single transaction so a partial failure rolls back cleanly.


-- ============================================================================
-- SECTION 1 — CLASS ROSTER TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1.1  classes — a teacher-owned roster container, independent of any exam.
-- ----------------------------------------------------------------------------
create table if not exists public.classes (
    id            uuid         primary key default gen_random_uuid(),
    user_id       uuid         not null references auth.users (id) on delete cascade,
    name          varchar(100) not null,
    academic_year varchar(20)  default '2026-2027',
    created_at    timestamptz  default now(),
    updated_at    timestamptz  default now(),
    constraint classes_user_name_uniq unique (user_id, name)
);

comment on table public.classes is
    'Teacher-owned class roster container (Phase 6.1). Independent of exams; imported via import_class_to_exam().';

-- ----------------------------------------------------------------------------
-- 1.2  class_members — the students belonging to a class.
--      `pin` is nullable on purpose: NULL means "fall back to DOB", and NULL
--      DOB means "no secret for this student" (see verify_and_acquire_session).
-- ----------------------------------------------------------------------------
create table if not exists public.class_members (
    id           uuid         primary key default gen_random_uuid(),
    class_id     uuid         not null references public.classes (id) on delete cascade,
    student_code varchar(50)  not null,
    full_name    varchar(100) not null,
    dob          date,
    pin          varchar(50),
    created_at   timestamptz  default now(),
    constraint class_members_class_code_uniq unique (class_id, student_code)
);

comment on table public.class_members is
    'Roster rows for a class. `pin` NULL -> DOB (DDMM) fallback; both NULL -> no PIN required.';

-- ----------------------------------------------------------------------------
-- 1.3  Indexes — RLS predicates and the roster join both filter on these.
-- ----------------------------------------------------------------------------
create index if not exists idx_classes_user_id            on public.classes (user_id);
create index if not exists idx_class_members_class_id     on public.class_members (class_id);
create index if not exists idx_class_members_student_code on public.class_members (student_code);


-- ============================================================================
-- SECTION 2 — PIN COLUMNS ON exams / students
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1  exams — the per-exam PIN policy.
--      NOT NULL DEFAULT 'INDIVIDUAL' is load-bearing: an exam created before
--      this phase must adopt a defined policy rather than NULL, which would
--      make the branch logic in verify_and_acquire_session fall through.
-- ----------------------------------------------------------------------------
alter table public.exams
    add column if not exists pin_mode   varchar(20) not null default 'INDIVIDUAL',
    add column if not exists global_pin varchar(50);

comment on column public.exams.pin_mode is
    'PIN policy (Phase 6.1): NONE | GLOBAL | INDIVIDUAL. INDIVIDUAL falls back to students.dob as DDMM.';
comment on column public.exams.global_pin is
    'Shared PIN used when pin_mode = ''GLOBAL''. Ignored in the other two modes.';

-- Idempotent CHECK: `add constraint` itself is not re-runnable, so drop first.
alter table public.exams drop constraint if exists chk_pin_mode;
alter table public.exams add constraint chk_pin_mode
    check (pin_mode in ('NONE', 'GLOBAL', 'INDIVIDUAL'));

-- ----------------------------------------------------------------------------
-- 2.2  students — the per-candidate secret. Both NULL = legacy row = no PIN.
-- ----------------------------------------------------------------------------
alter table public.students
    add column if not exists dob date,
    add column if not exists pin varchar(50);

comment on column public.students.dob is
    'Date of birth (Phase 6.1). Used as the DDMM PIN fallback when pin IS NULL.';
comment on column public.students.pin is
    'Per-student PIN (Phase 6.1). Takes precedence over dob. NULL -> DOB fallback.';


-- ============================================================================
-- SECTION 3 — RLS FOR THE NEW TABLES
-- ----------------------------------------------------------------------------
-- Same model as the rest of the schema: a teacher reaches only their own rows.
-- Students (anon) never touch these tables — they hold no EXECUTE path here and
-- are revoked below.
-- ============================================================================
alter table public.classes       enable row level security;
alter table public.class_members enable row level security;

drop policy if exists classes_owner_all on public.classes;
create policy classes_owner_all on public.classes
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Membership is scoped through the parent class, mirroring how `students` is
-- scoped through its exam.
drop policy if exists class_members_owner_all on public.class_members;
create policy class_members_owner_all on public.class_members
    for all
    to authenticated
    using (
        exists (
            select 1 from public.classes c
            where c.id = class_members.class_id and c.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.classes c
            where c.id = class_members.class_id and c.user_id = auth.uid()
        )
    );

-- ----------------------------------------------------------------------------
-- 3.1  Revoke anon.
--      Supabase's default privileges grant ALL on new public tables to `anon`
--      (verified: pg_default_acl is {postgres=…, anon=arwdDxtm, authenticated=…}).
--      The architecture requires students to hold ZERO table privileges, so the
--      grant must be explicitly removed or the invariant silently stops holding.
-- ----------------------------------------------------------------------------
revoke all on public.classes       from anon;
revoke all on public.class_members from anon;


-- ============================================================================
-- SECTION 4 — RPC: import_class_to_exam
-- ----------------------------------------------------------------------------
-- Copies one or more rosters into an exam's `students` whitelist. Re-importing
-- the same class REFRESHES name/class/dob/pin rather than failing, so a teacher
-- who fixes a typo in a class roster can simply re-import.
--
-- SECURITY DEFINER with an explicit ownership check: `auth.uid()` reads the JWT
-- (not the SQL role), so it still resolves to the calling teacher even though the
-- body runs as the function owner.
-- ============================================================================
create or replace function public.import_class_to_exam(
    p_exam_code varchar,
    p_class_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id       uuid;
    v_inserted_count integer;
begin
    -- 1. The caller must own this exam and it must not be trashed.
    select e.id into v_exam_id
      from public.exams e
     where e.code = upper(trim(p_exam_code))
       and e.user_id = auth.uid()
       and e.deleted_at is null;
    if v_exam_id is null then
        raise exception 'UNAUTHORIZED_OR_EXAM_NOT_FOUND';
    end if;

    -- 2. Import. `ON CONFLICT` targets students_code_exam_uniq.
    --    The join to `classes` re-checks ownership so a class id belonging to
    --    another teacher contributes nothing, even if it was passed in.
    insert into public.students (exam_code, student_code, full_name, class_name, dob, pin)
    select
        upper(trim(p_exam_code)),
        cm.student_code,
        cm.full_name,
        c.name,
        cm.dob,
        cm.pin
      from public.class_members cm
      join public.classes c on c.id = cm.class_id
     where cm.class_id = any(p_class_ids)
       and c.user_id = auth.uid()
    on conflict (exam_code, student_code) do update
       set full_name  = excluded.full_name,
           class_name = excluded.class_name,
           dob        = excluded.dob,
           pin        = excluded.pin;

    get diagnostics v_inserted_count = row_count;
    return coalesce(v_inserted_count, 0);
end;
$$;

revoke all on function public.import_class_to_exam(varchar, uuid[]) from public;
-- `revoke ... from public` is NOT enough here. Supabase's database-level default
-- privileges already grant EXECUTE to `anon` EXPLICITLY, and an explicit grant
-- survives a revoke aimed at PUBLIC. Verified locally:
--   after `revoke ... from public` -> anon still had X, has_function_privilege('anon', ...) = true.
-- The architecture promises teacher-only RPCs are unreachable by anon, so the
-- explicit grant must be revoked by name. (The body would reject an anonymous
-- caller anyway via auth.uid(), but failing closed at the ACL is cheaper and
-- makes the privilege table match the documented intent.)
revoke all on function public.import_class_to_exam(varchar, uuid[]) from anon;
grant execute on function public.import_class_to_exam(varchar, uuid[]) to authenticated;


-- ============================================================================
-- SECTION 5 — RPC v2: verify_and_acquire_session (adds p_pin)
-- ----------------------------------------------------------------------------
-- The single-device lock, timer and session-acquisition logic are preserved
-- VERBATIM from Phase 1; only step 3.b (the PIN gate) is new. See the file
-- header for why the old 6-argument signature is dropped first.
-- ============================================================================
drop function if exists public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid);

create or replace function public.verify_and_acquire_session(
    p_exam_code      varchar,
    p_student_code   varchar,
    p_full_name      varchar,
    p_class_name     varchar,
    p_device_info    text    default null,
    p_existing_token uuid    default null,
    p_pin            varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_student   public.students%rowtype;
    v_session   public.active_sessions%rowtype;
    v_new_token uuid := gen_random_uuid();
begin
    -- 1. Exam must exist and be open.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 1.0 Soft-deleted exams are indistinguishable from missing ones: the Trash
    --     is a teacher-only concept, and revealing it would leak that the code
    --     once existed. Same code as a genuine miss on purpose.
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 1.a Teacher open/close switch.
    if v_exam.is_active is not true then
        return jsonb_build_object('success', false, 'message', 'EXAM_INACTIVE');
    end if;

    -- 1.b Scheduling window. A NULL bound means "unbounded on that side".
    if v_exam.starts_at is not null and now() < v_exam.starts_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_STARTED');
    end if;
    if v_exam.ends_at is not null and now() > v_exam.ends_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_EXPIRED');
    end if;

    -- 2. Candidate must be whitelisted for this exam.
    select * into v_student
      from public.students
     where exam_code = p_exam_code
       and student_code = p_student_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    -- 3. Identity must match the whitelist (case-insensitive, trimmed).
    if lower(trim(v_student.full_name)) <> lower(trim(coalesce(p_full_name, '')))
       or lower(trim(v_student.class_name)) <> lower(trim(coalesce(p_class_name, ''))) then
        return jsonb_build_object('success', false, 'message', 'IDENTITY_MISMATCH');
    end if;

    -- 3.b PIN gate (Phase 6.1). Placed AFTER identity so a wrong PIN can never
    --     touch the session lock or the results table, and BEFORE the
    --     duplicate-submission probe so a failed attempt is side-effect free.
    --
    --     Comparison uses `is distinct from` (null-safe): the naive
    --     `trim(p_pin) = trim(global_pin)` would evaluate to NULL when the
    --     teacher selected GLOBAL but left global_pin unset, and the enclosing
    --     IF would fall through — silently admitting EVERY candidate. Failing
    --     closed is the only safe direction for an exam credential.
    if v_exam.pin_mode = 'GLOBAL' then
        if trim(coalesce(p_pin, '')) is distinct from trim(v_exam.global_pin) then
            return jsonb_build_object(
                'success', false,
                'code',    'INVALID_PIN',
                'message', 'Mã PIN hoặc ngày sinh (DDMM) không chính xác.'
            );
        end if;

    elsif v_exam.pin_mode = 'INDIVIDUAL' then
        if v_student.pin is not null and trim(v_student.pin) <> '' then
            -- Per-student PIN takes precedence.
            if trim(coalesce(p_pin, '')) is distinct from trim(v_student.pin) then
                return jsonb_build_object(
                    'success', false,
                    'code',    'INVALID_PIN',
                    'message', 'Mã PIN hoặc ngày sinh (DDMM) không chính xác.'
                );
            end if;

        elsif v_student.dob is not null then
            -- DOB fallback: DDMM, e.g. 2008-09-05 -> '0509'.
            if trim(coalesce(p_pin, '')) is distinct from to_char(v_student.dob, 'DDMM') then
                return jsonb_build_object(
                    'success', false,
                    'code',    'INVALID_PIN',
                    'message', 'Mã PIN hoặc ngày sinh (DDMM) không chính xác.'
                );
            end if;
        end if;
        -- Neither pin nor dob set -> legacy/no-secret row -> no PIN required.
    end if;
    -- pin_mode = 'NONE' -> no verification. (The CHECK constraint guarantees
    -- pin_mode is always one of the three, so no ELSE branch is reachable.)

    -- 4. One submission per candidate, ever.
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = p_student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    -- 5. Atomic single-device lock.
    --    FOR UPDATE serialises concurrent logins for the same candidate.
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = p_student_code
     for update;

    if found then
        if v_session.last_heartbeat > now() - interval '60 seconds' then
            -- Live session.
            if p_existing_token is not null and p_existing_token = v_session.session_token then
                -- Same device reloaded: extend rather than lock out (F5 tolerance).
                update public.active_sessions
                   set last_heartbeat = now(),
                       device_info    = coalesce(p_device_info, device_info)
                 where exam_code = p_exam_code
                   and student_code = p_student_code;
                return jsonb_build_object(
                    'success', true,
                    'session_token', v_session.session_token,
                    'message', 'SESSION_RESUMED'
                );
            end if;
            -- Foreign device while a session is alive -> reject.
            return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
        end if;

        -- Stale session (>60s silent): take it over, reset telemetry.
        update public.active_sessions
           set session_token         = v_new_token,
               last_heartbeat        = now(),
               current_question      = 0,
               answered_count        = 0,
               blur_count            = 0,
               fullscreen_exit_count = 0,
               device_info           = p_device_info
         where exam_code = p_exam_code
           and student_code = p_student_code;
        return jsonb_build_object(
            'success', true,
            'session_token', v_new_token,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

    -- No session row -> create one.
    insert into public.active_sessions (
        student_code, exam_code, session_token, last_heartbeat,
        current_question, answered_count, blur_count, fullscreen_exit_count, device_info
    ) values (
        p_student_code, p_exam_code, v_new_token, now(),
        0, 0, 0, 0, p_device_info
    );
    return jsonb_build_object(
        'success', true,
        'session_token', v_new_token,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
        -- Lost an insert race against a concurrent login.
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;

-- The new signature needs its own grants; the dropped one took its grants with it.
revoke all on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) from public;
grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) to anon, authenticated;

commit;
