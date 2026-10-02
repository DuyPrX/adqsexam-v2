-- ============================================================================
-- PHASE 5.4 — EXAM LIFECYCLE, SCHEDULING WINDOW & SAFE QUESTION CRUD
-- ----------------------------------------------------------------------------
-- 1. exams.starts_at / exams.ends_at scheduling window (NULL = unbounded).
-- 2. verify_and_acquire_session() now enforces is_active + the window, emitting
--    EXAM_INACTIVE / EXAM_NOT_STARTED / EXAM_EXPIRED.
-- 3. New teacher-only RPC update_exam_questions_safe(p_exam_code, p_questions):
--    full question rewrite while the exam has zero submissions, and a
--    content-only, structure-locked update once a submission exists.
--
-- Mirrors the definitions in ../../supabase/schema.sql (Section A.1 / C.1 / C.8).
-- Idempotent: safe to re-run.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Scheduling columns on exams.
-- ----------------------------------------------------------------------------
alter table public.exams add column if not exists starts_at timestamptz;
alter table public.exams add column if not exists ends_at   timestamptz;

comment on column public.exams.starts_at is 'Earliest acceptable login time. NULL = no lower bound.';
comment on column public.exams.ends_at   is 'Latest acceptable login time. NULL = no upper bound.';


-- ----------------------------------------------------------------------------
-- 2. verify_and_acquire_session — enforce is_active + scheduling window.
-- ----------------------------------------------------------------------------
create or replace function public.verify_and_acquire_session(
    p_exam_code      varchar,
    p_student_code   varchar,
    p_full_name      varchar,
    p_class_name     varchar,
    p_device_info    text    default null,
    p_existing_token uuid    default null
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

    -- 4. One submission per candidate, ever.
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = p_student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    -- 5. Atomic single-device lock.
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = p_student_code
     for update;

    if found then
        if v_session.last_heartbeat > now() - interval '60 seconds' then
            if p_existing_token is not null and p_existing_token = v_session.session_token then
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
            return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
        end if;

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
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. update_exam_questions_safe — post-creation question CRUD with guard.
-- ----------------------------------------------------------------------------
create or replace function public.update_exam_questions_safe(
    p_exam_code varchar,
    p_questions jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id     uuid;
    v_owner       uuid;
    v_submissions integer;
    v_existing    integer;
    v_incoming    integer;
    v_item        jsonb;
    v_idx         integer := 0;
    v_exists_type text;
    v_in_type     text;
    i             integer;
begin
    if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
        return jsonb_build_object('success', false, 'message', 'INVALID_PAYLOAD');
    end if;
    v_incoming := jsonb_array_length(p_questions);

    select e.id, e.user_id into v_exam_id, v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    select count(*) into v_submissions
      from public.exam_results r
     where r.exam_code = p_exam_code;

    if v_submissions > 0 then
        select count(*) into v_existing
          from public.question_bank q
         where q.exam_id = v_exam_id;

        if v_existing <> v_incoming then
            return jsonb_build_object(
                'success', false,
                'message', 'STRUCTURAL_CHANGE_BLOCKED',
                'detail',  'Đề thi đã có lượt nộp bài, chỉ có thể sửa nội dung câu hỏi.'
            );
        end if;

        -- Validate ALL positions BEFORE applying any update, so a mismatch at the
        -- last index cannot leave earlier rows already modified (a plpgsql
        -- `return` does not roll back the transaction).
        for i in 0 .. v_incoming - 1 loop
            v_item    := p_questions -> i;
            v_in_type := upper(coalesce(v_item ->> 'question_type', ''));

            select upper(q.question_type) into v_exists_type
              from public.question_bank q
             where q.exam_id = v_exam_id
               and q.position = i + 1;
            if not found or v_exists_type <> v_in_type then
                return jsonb_build_object(
                    'success', false,
                    'message', 'STRUCTURAL_CHANGE_BLOCKED',
                    'detail',  'Đề thi đã có lượt nộp bài, chỉ có thể sửa nội dung câu hỏi.'
                );
            end if;
        end loop;

        -- Apply pass: structure is proven intact, so only content is touched.
        for i in 0 .. v_incoming - 1 loop
            v_item := p_questions -> i;

            update public.question_bank q
               set question_text  = coalesce(v_item ->> 'question_text', q.question_text),
                   options        = coalesce(v_item -> 'options', q.options),
                   correct_answer = nullif(v_item -> 'correct_answer', 'null'::jsonb),
                   explanation    = v_item ->> 'explanation'
             where q.exam_id = v_exam_id
               and q.position = i + 1;
        end loop;

        return jsonb_build_object(
            'success',     true,
            'message',     'CONTENT_UPDATED',
            'updated',     v_incoming,
            'submissions', v_submissions
        );
    end if;

    delete from public.question_bank q where q.exam_id = v_exam_id;

    for i in 0 .. v_incoming - 1 loop
        v_item := p_questions -> i;
        v_idx  := v_idx + 1;

        insert into public.question_bank (
            user_id, exam_id, question_text, question_type,
            options, correct_answer, explanation, position
        ) values (
            v_owner,
            v_exam_id,
            coalesce(v_item ->> 'question_text', ''),
            upper(coalesce(v_item ->> 'question_type', 'MULTIPLE_CHOICE')),
            coalesce(v_item -> 'options', '[]'::jsonb),
            -- `->` yields JSONB 'null' for an explicit JSON null; nullif maps it
            -- back to SQL NULL so the column matches the PostgREST saveExam path
            -- (JS null -> SQL NULL). `#>> '{}'` on JSONB 'null' would be 'null',
            -- which would corrupt the SHORT_ANSWER comparison in submit_exam_result.
            nullif(v_item -> 'correct_answer', 'null'::jsonb),
            v_item ->> 'explanation',
            v_idx
        );
    end loop;

    return jsonb_build_object(
        'success',     true,
        'message',     'REPLACED',
        'inserted',    v_incoming,
        'submissions', 0
    );
end;
$$;

revoke all on function public.update_exam_questions_safe(varchar, jsonb) from public;
grant execute on function public.update_exam_questions_safe(varchar, jsonb) to authenticated;

commit;
