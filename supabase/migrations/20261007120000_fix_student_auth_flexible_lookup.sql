-- ============================================================================
-- PHASE 8.8 — flexible candidate lookup for session acquisition
-- ----------------------------------------------------------------------------
-- WHY
--   The student SPA no longer shows a "Mã học sinh" input (Phase 8.1 removed it
--   in favour of a class + name picker). Today's `verify_and_acquire_session`
--   still resolves the candidate ONLY by `student_code`, so the SPA has to
--   pre-resolve that code from a roster it fetched separately:
--
--     * if the roster RPC fails or the exam has an empty roster, the student
--       CANNOT log in at all, even though they typed their exact name and class;
--     * the resolved code is a client-side guess. The server re-checks the
--       identity afterwards, so it is not a security hole — but it means a
--       perfectly valid (class, name) pair is rejected purely because the client
--       could not obtain the code.
--
--   This migration lets the server resolve the candidate itself: by
--   `p_student_code` when supplied, otherwise by the (class_name, full_name)
--   pair. The client-provided code becomes a fast path / disambiguator rather
--   than a hard requirement.
--
-- WHAT
--   `verify_and_acquire_session` step 2 & 3 are rewritten to:
--     * resolve the roster row by a NORMALIZED comparison — lower(trim(
--       regexp_replace(..., '\s+', ' ', 'g'))) — so extra/duplicate whitespace
--       and case differences can never reject a legitimate candidate;
--     * fall back to (class_name, full_name) when `p_student_code` is null,
--       empty or whitespace-only;
--     * treat the code as authoritative WHEN SUPPLIED, but still verify the
--       name/class against that row (unchanged behaviour, wrong identity still
--       fails).
--
--   The returned payload gains `student_code`, `student_name` and `class_name`
--   (canonical spelling from the roster row) plus `exam_title`,
--   `duration_minutes` and `shuffle_questions`, so the SPA can render the exam
--   banner without a second round-trip. These are additive keys: existing
--   callers read only `success` / `session_token` / `message`.
--
-- WHAT THIS DELIBERATELY DOES **NOT** DO
--   The signature is UNCHANGED
--     (p_exam_code, p_student_code, p_full_name, p_class_name, p_device_info,
--      p_existing_token, p_pin)
--   so there is no `drop function` and therefore no ACL hazard, no overload
--   ambiguity, and no client change required. `create or replace` is safe here
--   precisely because the argument list does not move.
--
--   The spec draft also proposed renaming the pin modes to INDIVIDUAL_PIN /
--   DOB_ONLY and adding `active_sessions.status` / `.id` / `.started_at` /
--   `.client_session_id` and `exams.max_ip_switches`. NONE of those columns or
--   values exist in this schema: `pin_mode` is CHECK-constrained to
--   ('NONE','GLOBAL','INDIVIDUAL'), and `active_sessions` is keyed on
--   (student_code, exam_code) with `last_heartbeat` + `session_token`. Adopting
--   the draft verbatim would have DROPPED this function and recreated one that
--   references non-existent columns, breaking every student login. The security
--   guards it omitted — the ALREADY_SUBMITTED probe, the single-device lock, the
--   60-second stale takeover, the F5 token-resume tolerance and the fail-closed
--   `is distinct from` PIN comparison — are all preserved below.
--
-- IDEMPOTENT
--   `create or replace function` is re-runnable for an unchanged signature.
--   The revoke/grant pair is restated at the end so a future operator who DOES
--   drop the function cannot silently leave it executable by PUBLIC.
-- ============================================================================

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
    v_code      varchar;
    v_name      varchar;
    v_class     varchar;
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

    -- 2. Resolve the whitelisted candidate.
    --
    --    Both inputs are normalized the way the client normalizes them:
    --    collapsed internal whitespace, trimmed, case-folded. `\s+` -> ' ' is
    --    applied to BOTH sides so a name stored as 'Nguyễn  Văn   A' matches a
    --    typed 'nguyễn văn a'. Done in SQL rather than relying on the client
    --    having normalized correctly, because this is the authentication path:
    --    a legitimate candidate must not be rejectable by a double space.
    v_code  := nullif(lower(trim(coalesce(p_student_code, ''))), '');
    v_name  := nullif(lower(regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g')), '');
    v_class := nullif(lower(regexp_replace(trim(coalesce(p_class_name, '')), '\s+', ' ', 'g')), '');

    if v_code is not null then
        -- Fast path: the client resolved a roster row and sent its code.
        select * into v_student
          from public.students s
         where s.exam_code = p_exam_code
           and lower(trim(s.student_code)) = v_code;
    elsif v_name is not null and v_class is not null then
        -- Fallback: no code supplied (or it was blank/whitespace). Match the
        -- normalized pair the student actually typed.
        --
        -- `order by student_code` + `limit 1` makes a duplicate roster row
        -- deterministic instead of "whichever the planner returns first". The
        -- `students_code_exam_uniq` constraint is on (student_code, exam_code),
        -- NOT on (full_name, class_name), so two students may legitimately share
        -- a name in one class; picking the lowest code is stable, and the
        -- supplied PIN/DOB still has to match below, so a wrong pick cannot
        -- authenticate.
        select * into v_student
          from public.students s
         where s.exam_code = p_exam_code
           and lower(regexp_replace(trim(s.full_name),  '\s+', ' ', 'g')) = v_name
           and lower(regexp_replace(trim(s.class_name), '\s+', ' ', 'g')) = v_class
         order by s.student_code
         limit 1;
    end if;

    if not found or v_student.student_code is null then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    -- 3. Identity must match the whitelist.
    --
    --    When the code was supplied, step 2 already matched on it, so this
    --    re-checks the name/class the student typed against THAT row — the code
    --    alone must never be enough to sit an exam under someone else's name.
    --    When the fallback matched on name+class, this is a no-op by
    --    construction, but it is kept unconditional so both paths run the same
    --    assertion and a future edit to step 2 cannot quietly skip it.
    if lower(regexp_replace(trim(v_student.full_name),  '\s+', ' ', 'g')) <> coalesce(v_name, '')
       or lower(regexp_replace(trim(v_student.class_name), '\s+', ' ', 'g')) <> coalesce(v_class, '') then
        return jsonb_build_object('success', false, 'message', 'IDENTITY_MISMATCH');
    end if;

    -- 3.b PIN gate (Phase 6.1). Placed AFTER identity so a wrong PIN can never
    --     touch the session lock or the results table, and BEFORE the
    --     duplicate-submission probe so a failed attempt is side-effect free.
    --
    --     Comparison uses `is distinct from` (null-safe): the naive
    --     `trim(p_pin) = trim(global_pin)` evaluates to NULL when the teacher
    --     selected GLOBAL but left global_pin unset, and the enclosing IF would
    --     fall through — silently admitting EVERY candidate. An exam credential
    --     must fail closed.
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
            -- Per-student PIN takes precedence over DOB.
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
        -- Neither pin nor dob set -> legacy/minimal row -> no PIN required.
    end if;
    -- pin_mode = 'NONE' -> no verification. The chk_pin_mode CHECK guarantees
    -- pin_mode is one of the three, so no ELSE branch is reachable.

    -- 4. One submission per candidate, ever.
    --
    --    Keyed on the RESOLVED roster code, not on the caller's input: the same
    --    candidate must not be able to dodge this by omitting `p_student_code`
    --    and logging in via the name+class fallback.
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = v_student.student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    -- 5. Atomic single-device lock.
    --    FOR UPDATE serialises concurrent logins for the same candidate.
    --    Again keyed on the RESOLVED code, so the fallback path is subject to
    --    exactly the same lock as the fast path.
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = v_student.student_code
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
                   and student_code = v_student.student_code;
                return jsonb_build_object(
                    'success', true,
                    'session_token', v_session.session_token,
                    'student_code', v_student.student_code,
                    'student_name', v_student.full_name,
                    'class_name',   v_student.class_name,
                    'exam_title',   v_exam.title,
                    'duration_minutes', v_exam.duration_minutes,
                    'shuffle_questions', v_exam.shuffle_questions,
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
           and student_code = v_student.student_code;
        return jsonb_build_object(
            'success', true,
            'session_token', v_new_token,
            'student_code', v_student.student_code,
            'student_name', v_student.full_name,
            'class_name',   v_student.class_name,
            'exam_title',   v_exam.title,
            'duration_minutes', v_exam.duration_minutes,
            'shuffle_questions', v_exam.shuffle_questions,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

    -- No session row -> create one.
    insert into public.active_sessions (
        student_code, exam_code, session_token, last_heartbeat,
        current_question, answered_count, blur_count, fullscreen_exit_count, device_info
    ) values (
        v_student.student_code, p_exam_code, v_new_token, now(),
        0, 0, 0, 0, p_device_info
    );
    return jsonb_build_object(
        'success', true,
        'session_token', v_new_token,
        'student_code', v_student.student_code,
        'student_name', v_student.full_name,
        'class_name',   v_student.class_name,
        'exam_title',   v_exam.title,
        'duration_minutes', v_exam.duration_minutes,
        'shuffle_questions', v_exam.shuffle_questions,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
        -- Lost an insert race against a concurrent login.
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;

revoke all on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) from public;
grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- get_exam_roster — expose `duration_minutes`
-- ----------------------------------------------------------------------------
-- Additive only: the login banner shows the paper's length next to the title,
-- and the roster call is already the single round-trip the form makes. The
-- signature is unchanged, so no drop and no ACL hazard.
--
-- `pin`/`dob` remain absent from the candidate projection — they are exam
-- credentials, and this is the one anon RPC that answers before roster
-- membership is proven.
-- ----------------------------------------------------------------------------
create or replace function public.get_exam_roster(
    p_exam_code    varchar,
    p_for_practice boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam       public.exams%rowtype;
    v_candidates jsonb;
begin
    if p_exam_code is null or trim(p_exam_code) = '' then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    select * into v_exam from public.exams where code = upper(trim(p_exam_code));
    if not found then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    -- Trashed exams stay invisible to students (mirrors verify_and_acquire_session).
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    if p_for_practice then
        -- Practice mode: the ONLY gate is the teacher's explicit consent. The
        -- open/close switch and the schedule are deliberately NOT consulted —
        -- that is the point of this parameter (self-study after the sitting).
        if v_exam.allow_practice is not true then
            return jsonb_build_object(
                'success', false,
                'code',    'PRACTICE_NOT_ALLOWED',
                'message', 'Đề thi này chưa mở cho tự luyện tập.'
            );
        end if;
    else
        if v_exam.is_active is not true then
            return jsonb_build_object('success', false, 'code', 'EXAM_INACTIVE', 'message', 'Đề thi hiện đang đóng.');
        end if;

        if v_exam.starts_at is not null and now() < v_exam.starts_at then
            return jsonb_build_object('success', false, 'code', 'EXAM_NOT_STARTED', 'message', 'Chưa đến giờ làm bài.');
        end if;
        if v_exam.ends_at is not null and now() > v_exam.ends_at then
            return jsonb_build_object('success', false, 'code', 'EXAM_EXPIRED', 'message', 'Đề thi đã kết thúc.');
        end if;
    end if;

    -- Three display keys ONLY: `pin`/`dob` must never leave the server here.
    select jsonb_agg(
               jsonb_build_object(
                   'student_code', s.student_code,
                   'full_name',    s.full_name,
                   'class_name',   s.class_name
               )
               order by s.class_name asc, s.student_code asc
           )
      into v_candidates
      from public.students s
     where s.exam_code = v_exam.code;

    return jsonb_build_object(
        'success',        true,
        'exam_code',      v_exam.code,
        'title',          v_exam.title,
        -- Phase 8.8 — the login banner shows the paper's length before the
        -- student commits, without a second round-trip.
        'duration_minutes', v_exam.duration_minutes,
        'pin_mode',       v_exam.pin_mode,
        'allow_practice', v_exam.allow_practice,
        'shuffle_questions', v_exam.shuffle_questions,
        'candidates',     coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_exam_roster(varchar, boolean) from public;
grant execute on function public.get_exam_roster(varchar, boolean) to anon, authenticated;

