-- ============================================================================
-- PHASE 8.1 — flexible identity + practice roster on closed exams
-- ----------------------------------------------------------------------------
-- WHY
--   The student SPA is losing every visible "student code" input: identity
--   becomes Class + Full Name (+ PIN). Three RPCs have to move with it, because
--   each one currently authenticates on `student_code`.
--
-- THE OVERLOAD HAZARD (the reason for the DROPs below)
--   `create or replace function` matches on the ARGUMENT SIGNATURE. Adding a
--   parameter therefore does NOT replace the old function — it creates a SECOND
--   one, and a call that matches both becomes "function is not unique". Phase 6.1
--   hit exactly this with verify_and_acquire_session(p_pin). Every changed
--   function here is therefore preceded by an explicit
--   `drop function if exists <old signature>`.
--
-- WHAT CHANGES
--   1. get_exam_roster(p_exam_code, p_for_practice DEFAULT false)
--        * p_for_practice = true  -> return the roster for an exam the teacher
--          opened for practice even when it is closed / outside its window.
--          Still refuses a trashed exam and one with allow_practice = false.
--        * p_for_practice = false -> unchanged official-exam behaviour.
--   2. get_practice_exam_payload(p_exam_code, p_student_code DEFAULT NULL,
--                                p_class_name DEFAULT NULL,
--                                p_full_name  DEFAULT NULL)
--        * Authorises by student_code OR by (full_name, class_name).
--   3. verify_student_practice(p_class_name, p_full_name, p_student_code DEFAULT NULL)
--        * NOT in the original task list, but REQUIRED for coherence: the .docx
--          personal-practice path calls this to authorise against "any roster",
--          and with the student-code input gone it can only supply class + name.
--          Leaving it code-only would silently break that feature.
--
-- SECURITY POSTURE (unchanged)
--   All three stay SECURITY DEFINER with a pinned search_path, and none of them
--   ever returns `pin` or `dob`. The roster projection is still three explicit
--   keys, never `s.*`.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. get_exam_roster — add p_for_practice
-- ---------------------------------------------------------------------------
drop function if exists public.get_exam_roster(varchar);

create or replace function public.get_exam_roster(
    p_exam_code     varchar,
    p_for_practice  boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam       public.exams%rowtype;
    v_candidates jsonb;
begin
    -- A blank code must not fall through to a full-table scan.
    if p_exam_code is null or trim(p_exam_code) = '' then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    select * into v_exam from public.exams where code = upper(trim(p_exam_code));

    if not found then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    -- A trashed exam is indistinguishable from a missing one (Trash is a
    -- teacher-only concept). Applies to BOTH modes: "deleted" must never be
    -- revealed, and practice on a deleted exam makes no sense.
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    if p_for_practice then
        -- Practice mode: the ONLY gate is the teacher's explicit consent. The
        -- open/close switch and the schedule are deliberately NOT consulted —
        -- that is the entire point of this parameter: self-study is allowed on
        -- an exam that is closed for the official sitting.
        if v_exam.allow_practice is not true then
            return jsonb_build_object(
                'success', false,
                'code',    'PRACTICE_NOT_ALLOWED',
                'message', 'Đề thi này chưa mở cho tự luyện tập.'
            );
        end if;
    else
        -- Official sitting: unchanged Phase 6.3 behaviour.
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

    -- Three display keys ONLY. `pin` and `dob` are credentials (dob is the DDMM
    -- fallback PIN) and must never appear in this payload.
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
        'pin_mode',       v_exam.pin_mode,
        -- Lets the practice picker distinguish "closed" from "not open for
        -- practice" without a second round-trip.
        'allow_practice', v_exam.allow_practice,
        'candidates',     coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_exam_roster(varchar, boolean) from public;
grant execute on function public.get_exam_roster(varchar, boolean) to anon, authenticated;

comment on function public.get_exam_roster(varchar, boolean) is
    'Phase 8.1: sanitised candidate list (student_code/full_name/class_name + pin_mode + allow_practice). p_for_practice=true returns the roster of a practice-enabled exam even when it is closed. Never returns pin or dob.';


-- ---------------------------------------------------------------------------
-- 2. get_practice_exam_payload — accept (full_name, class_name)
-- ---------------------------------------------------------------------------
drop function if exists public.get_practice_exam_payload(varchar, varchar, varchar);

create or replace function public.get_practice_exam_payload(
    p_exam_code    varchar,
    p_student_code varchar default null,
    p_class_name   varchar default null,
    p_full_name    varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_match     public.students%rowtype;
    v_matched   boolean := false;
    v_questions jsonb;
    v_total     integer;
begin
    select * into v_exam from public.exams where code = upper(trim(coalesce(p_exam_code, '')));
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- Trashed exams stay invisible to students.
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- The teacher's explicit consent is the ONLY thing that unlocks the key.
    if v_exam.allow_practice is not true then
        return jsonb_build_object('success', false, 'message', 'PRACTICE_NOT_ALLOWED');
    end if;

    -- Flexible whitelist check: by student_code when supplied, otherwise by
    -- (full_name + class_name). Both comparisons are case/whitespace
    -- insensitive, matching verify_and_acquire_session.
    --
    -- `v_matched` is tracked explicitly rather than relying on FOUND: when
    -- neither branch runs (every parameter blank) FOUND would still hold the
    -- value left by the `select ... into v_exam` above.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select * into v_match
          from public.students s
         where s.exam_code = v_exam.code
           and lower(trim(s.student_code)) = lower(trim(p_student_code))
         limit 1;
        v_matched := found;
    elsif p_full_name is not null and trim(p_full_name) <> ''
      and p_class_name is not null and trim(p_class_name) <> '' then
        select * into v_match
          from public.students s
         where s.exam_code = v_exam.code
           and lower(trim(s.full_name))  = lower(trim(p_full_name))
           and lower(trim(s.class_name)) = lower(trim(p_class_name))
         order by s.student_code
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    -- Original order. Position ASC is the contract: practice must NOT shuffle,
    -- so a student reviewing "Câu 7" sees the same numbering as the paper.
    -- `correct_answer` and `explanation` are included on purpose.
    with ordered as (
        select q.*,
               (row_number() over (order by q.position, q.created_at, q.id) - 1) as idx
          from public.question_bank q
         where q.exam_id = v_exam.id
    )
    select
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'index',          o.idx,
                    'question_text',  o.question_text,
                    'question_type',  o.question_type,
                    'options',        o.options,
                    'correct_answer', o.correct_answer,
                    'explanation',    o.explanation
                )
                order by o.idx
            ),
            '[]'::jsonb
        ),
        count(*)
      into v_questions, v_total
      from ordered o;

    if coalesce(v_total, 0) = 0 then
        return jsonb_build_object('success', false, 'message', 'PRACTICE_EMPTY');
    end if;

    return jsonb_build_object(
        'success', true,
        'exam', jsonb_build_object(
            'code',             v_exam.code,
            'title',            v_exam.title,
            'duration_minutes', v_exam.duration_minutes,
            'total_questions',  v_total
        ),
        -- The roster row is authoritative: the client shows this name rather
        -- than echoing whatever was typed.
        'student_name', v_match.full_name,
        'questions', v_questions
    );
end;
$$;

revoke all on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar) from public;
grant execute on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar) to anon, authenticated;

comment on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar) is
    'Phase 8.1: returns a practice-enabled exam''s questions + answer keys to a whitelisted student. Authorises by student_code OR (full_name, class_name).';


-- ---------------------------------------------------------------------------
-- 3. verify_student_practice — accept (class_name, full_name)
-- ---------------------------------------------------------------------------
drop function if exists public.verify_student_practice(varchar, varchar);

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
    v_match   public.students%rowtype;
    v_matched boolean := false;
begin
    if p_class_name is null or trim(p_class_name) = ''
       or p_full_name is null or trim(p_full_name) = '' then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Vui lòng nhập đầy đủ Họ tên và Lớp.'
        );
    end if;

    -- Roster-agnostic on purpose (this is the personal .docx path, where the
    -- student is not tied to a specific exam code): any roster row that matches
    -- the identity is enough.
    --
    -- `v_matched` is tracked explicitly: an `if/elsif` where no branch runs
    -- leaves FOUND holding whatever the previous statement set.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select * into v_match
          from public.students s
         where lower(trim(s.student_code)) = lower(trim(p_student_code))
           and lower(trim(s.class_name))   = lower(trim(p_class_name))
         limit 1;
        v_matched := found;
    else
        select * into v_match
          from public.students s
         where lower(trim(s.full_name))  = lower(trim(p_full_name))
           and lower(trim(s.class_name)) = lower(trim(p_class_name))
         order by s.student_code
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Thông tin học sinh không có trong danh sách được phép ôn luyện.'
        );
    end if;

    return jsonb_build_object(
        'authorized',   true,
        'student_name', v_match.full_name,
        'student_code', v_match.student_code
    );
end;
$$;

revoke all on function public.verify_student_practice(varchar, varchar, varchar) from public;
grant execute on function public.verify_student_practice(varchar, varchar, varchar) to anon, authenticated;

comment on function public.verify_student_practice(varchar, varchar, varchar) is
    'Phase 8.1: authorises the personal .docx practice path against ANY roster by (full_name, class_name), or by student_code when supplied.';

commit;
