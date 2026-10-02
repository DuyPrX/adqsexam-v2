-- ============================================================================
-- PHASE 5.5 — TIMEZONE, RE-GRADING RPC & 2-TIER EXAM DELETION (7-DAY TRASH)
-- ----------------------------------------------------------------------------
-- 1. exams.deleted_at — soft-delete / Trash marker (NULL = live).
-- 2. verify_and_acquire_session / submit_exam_result treat a trashed exam as
--    missing (EXAM_NOT_FOUND).
-- 3. grade_exam_answers(p_exam_id, p_answers) — the SINGLE authoritative scoring
--    implementation (C.4a). Extracted out of submit_exam_result so re-grading
--    can never apply a different scale.
-- 4. delete_exam()     — 0 submissions => hard wipe; > 0 => 7-day soft delete.
-- 5. restore_exam()    — clears deleted_at.
-- 6. purge_expired_exams() — hard-deletes exams past the 7-day window.
-- 7. recalculate_exam_scores() — replays stored answers against the latest keys.
--
-- Mirrors the definitions in ../../supabase/schema.sql (Sections A.1/C.1/C.4a/
-- C.4/C.9-C.12). Idempotent: safe to re-run.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Trash marker.
-- ----------------------------------------------------------------------------
alter table public.exams add column if not exists deleted_at timestamptz;

comment on column public.exams.deleted_at is
    'Soft-delete / Trash marker. NULL = live; otherwise purgeable 7 days after this instant.';


-- ----------------------------------------------------------------------------
-- 2a. verify_and_acquire_session — reject trashed exams as EXAM_NOT_FOUND.
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


-- ----------------------------------------------------------------------------
-- 3. grade_exam_answers — single authoritative scoring implementation (C.4a).
-- ----------------------------------------------------------------------------
create or replace function public.grade_exam_answers(
    p_exam_id uuid,
    p_answers jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_q             public.question_bank%rowtype;
    v_ans           jsonb;
    v_idx           integer := 0;
    v_total         integer := 0;
    v_sum           numeric := 0;
    v_needs_grading boolean := false;
    v_corrected     jsonb   := '[]'::jsonb;
    v_type          text;
    v_is_correct    boolean;
    v_correct_idx   integer;
    v_selected_idx  integer;
    v_correct_arr   jsonb;
    v_selected_arr  jsonb;
    v_correct_count integer;
    v_q_score       numeric;
    i               integer;
begin
    -- Walk the authoritative question order and grade each answer.
    for v_q in
        select * from public.question_bank q
         where q.exam_id = p_exam_id
         order by q.position, q.created_at, q.id
    loop
        v_type := upper(coalesce(v_q.question_type, ''));

        -- Locate the answer for this 0-based index (absent = unanswered).
        -- CASE (not AND) guarantees the regex is checked before the ::int cast,
        -- so a hostile questionIndex cannot raise a cast error.
        v_ans := null;
        select elem into v_ans
          from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) as elem
         where case
                   when (elem ->> 'questionIndex') ~ '^-?[0-9]+$'
                   then (elem ->> 'questionIndex')::int
               end = v_idx
         limit 1;

        if v_type = 'TRUE_FALSE' then
            v_correct_arr  := v_q.correct_answer;
            v_selected_arr := coalesce(v_ans -> 'selectedAnswers', '[]'::jsonb);
            v_correct_count := 0;
            if jsonb_typeof(v_correct_arr) = 'array' then
                for i in 0 .. jsonb_array_length(v_correct_arr) - 1 loop
                    if (v_selected_arr ->> i) is not null
                       and (v_correct_arr ->> i) = (v_selected_arr ->> i) then
                        v_correct_count := v_correct_count + 1;
                    end if;
                end loop;
            end if;
            v_q_score := case v_correct_count
                             when 4 then 1.0
                             when 3 then 0.5
                             when 2 then 0.25
                             when 1 then 0.1
                             else 0.0
                         end;
            v_is_correct := (v_correct_count = 4);
            v_corrected := v_corrected || jsonb_build_object(
                'questionIndex',  v_idx,
                'type',           'TRUE_FALSE',
                'selectedAnswers', v_selected_arr,
                'correctAnswers',  coalesce(v_correct_arr, '[]'::jsonb),
                'isCorrect',       v_is_correct
            );

        elsif v_type = 'SHORT_ANSWER' then
            -- Mirrors normalizeShort(): trim, lower, ',' -> '.'.
            v_is_correct :=
                replace(lower(trim(coalesce(v_ans ->> 'selectedAnswerText', ''))), ',', '.')
                =
                replace(lower(trim(coalesce(v_q.correct_answer #>> '{}', ''))), ',', '.');
            v_q_score := case when v_is_correct then 1.0 else 0.0 end;
            v_corrected := v_corrected || jsonb_build_object(
                'questionIndex',      v_idx,
                'type',               'SHORT_ANSWER',
                'selectedAnswerText', coalesce(v_ans ->> 'selectedAnswerText', ''),
                'correctAnswer',      coalesce(v_q.correct_answer #>> '{}', ''),
                'isCorrect',          v_is_correct
            );

        elsif v_type = 'ESSAY' then
            -- Never auto-graded; flagged for teacher review.
            v_q_score       := 0.0;
            v_is_correct    := false;
            v_needs_grading := true;
            v_corrected := v_corrected || jsonb_build_object(
                'questionIndex',      v_idx,
                'type',               'ESSAY',
                'selectedAnswerText', coalesce(v_ans ->> 'selectedAnswerText', ''),
                'isCorrect',          false
            );

        else
            -- Default branch == MCQ (mirrors the v1 fallthrough).
            -- Cast through a digit regex so hostile input cannot raise.
            v_correct_idx := case
                                 when (v_q.correct_answer #>> '{}') ~ '^-?[0-9]+$'
                                 then (v_q.correct_answer #>> '{}')::int
                                 else null
                             end;
            v_selected_idx := case
                                  when (v_ans ->> 'selectedIndex') ~ '^-?[0-9]+$'
                                  then (v_ans ->> 'selectedIndex')::int
                                  else null
                              end;
            v_is_correct   := (v_correct_idx is not null
                               and v_selected_idx is not null
                               and v_correct_idx = v_selected_idx);
            v_q_score := case when v_is_correct then 1.0 else 0.0 end;
            v_corrected := v_corrected || jsonb_build_object(
                'questionIndex', v_idx,
                'type',          'MCQ',
                'selectedIndex', v_selected_idx,
                'correctIndex',  v_correct_idx,
                'isCorrect',     v_is_correct
            );
        end if;

        v_sum   := v_sum + v_q_score;
        v_total := v_total + 1;
        v_idx   := v_idx + 1;
    end loop;

    return jsonb_build_object(
        -- clamp(round(sum*100)/100, 0, total)
        'score',         greatest(0, least(v_total, round(v_sum * 100) / 100)),
        'total',         v_total,
        'needs_grading', v_needs_grading,
        'corrected',     v_corrected
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- 2b. submit_exam_result — now delegates scoring to grade_exam_answers and
--     refuses to accept a submission for a trashed exam.
-- ----------------------------------------------------------------------------
create or replace function public.submit_exam_result(
    p_exam_code     varchar,
    p_student_code  varchar,
    p_session_token uuid,
    p_answers       jsonb,
    p_metrics       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_student   public.students%rowtype;
    v_session   public.active_sessions%rowtype;
    v_grade     jsonb;
    v_result_id uuid;
begin
    -- 1. Exam.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 1a. A trashed exam accepts no further submissions.
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 2. Session must be live and bound to this candidate.
    select * into v_session
      from public.active_sessions
     where exam_code      = p_exam_code
       and student_code   = p_student_code
       and session_token  = p_session_token;
    if not found then
        return jsonb_build_object('success', false, 'message', 'INVALID_SESSION');
    end if;

    -- 3. One submission per candidate.
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = p_student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    select * into v_student
      from public.students
     where exam_code = p_exam_code and student_code = p_student_code;

    -- 4. Grade every answer against the authoritative question order.
    v_grade := public.grade_exam_answers(v_exam.id, p_answers);

    insert into public.exam_results (
        exam_code, student_code, student_name, class_name,
        score, total_questions, answers_json,
        blur_count, fullscreen_exit_count, elapsed_seconds, needs_grading
    ) values (
        p_exam_code, p_student_code,
        coalesce(v_student.full_name, ''), coalesce(v_student.class_name, ''),
        (v_grade ->> 'score')::numeric,
        (v_grade ->> 'total')::int,
        v_grade -> 'corrected',
        coalesce(nullif(regexp_replace(p_metrics ->> 'blurCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'fullscreenExitCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'elapsedSeconds', '\D', '', 'g'), '')::int, 0),
        (v_grade ->> 'needs_grading')::boolean
    )
    returning id into v_result_id;

    -- 6. Retire the session so the token can never be reused.
    delete from public.active_sessions
     where exam_code = p_exam_code and student_code = p_student_code;

    return jsonb_build_object(
        'success',         true,
        'message',         'SUBMITTED',
        'result_id',       v_result_id,
        'score',           (v_grade ->> 'score')::numeric,
        'total_questions', (v_grade ->> 'total')::int,
        'needs_grading',   (v_grade ->> 'needs_grading')::boolean
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. delete_exam — 2-tier deletion (hard when unsubmitted, soft otherwise).
-- ----------------------------------------------------------------------------
create or replace function public.delete_exam(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id     uuid;
    v_owner       uuid;
    v_deleted_at  timestamptz;
    v_submissions integer;
begin
    select e.id, e.user_id, e.deleted_at
      into v_exam_id, v_owner, v_deleted_at
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    -- Already trashed: deleting again is a no-op rather than a data hazard.
    if v_deleted_at is not null then
        return jsonb_build_object(
            'success', true,
            'action',  'already_deleted',
            'message', 'Đề thi đã nằm trong thùng rác.'
        );
    end if;

    select count(*) into v_submissions
      from public.exam_results r
     where r.exam_code = p_exam_code;

    if v_submissions > 0 then
        update public.exams
           set deleted_at = now(),
               is_active  = false
         where code = p_exam_code;

        return jsonb_build_object(
            'success',  true,
            'action',   'soft_deleted',
            'purge_at', now() + interval '7 days',
            'message',  'Đề thi đã có kết quả. Đã chuyển vào thùng rác (tự động xóa sau 7 ngày).'
        );
    end if;

    -- Hard delete: children first, then the exam. proctoring_snapshots can hold
    -- rows for a candidate who captured a webcam frame but never submitted, so
    -- it is cleared explicitly rather than left to the cascade.
    delete from public.active_sessions      s where s.exam_code = p_exam_code;
    delete from public.students             s where s.exam_code = p_exam_code;
    delete from public.question_bank        q where q.exam_id   = v_exam_id;
    delete from public.exam_results         r where r.exam_code = p_exam_code;
    delete from public.proctoring_snapshots p where p.exam_code = p_exam_code;
    delete from public.exams                e where e.id        = v_exam_id;

    return jsonb_build_object(
        'success', true,
        'action',  'hard_deleted',
        'message', 'Đã xóa hoàn toàn đề thi và câu hỏi.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. restore_exam — clears the Trash marker (is_active stays false on purpose).
-- ----------------------------------------------------------------------------
create or replace function public.restore_exam(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_owner uuid;
begin
    select e.user_id into v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    update public.exams
       set deleted_at = null
     where code = p_exam_code;

    return jsonb_build_object(
        'success', true,
        'message', 'Đã khôi phục đề thi từ thùng rác.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. purge_expired_exams — hard-delete everything past the 7-day window.
-- ----------------------------------------------------------------------------
create or replace function public.purge_expired_exams()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_purged integer;
begin
    with doomed as (
        delete from public.exams e
         where e.deleted_at is not null
           and e.deleted_at < now() - interval '7 days'
        returning 1
    )
    select count(*) into v_purged from doomed;

    return jsonb_build_object(
        'success',        true,
        'purged_count',   coalesce(v_purged, 0),
        'message',        'Đã xóa vĩnh viễn các đề thi quá thời hạn lưu trữ.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. recalculate_exam_scores — re-grade stored answers against the latest keys.
-- ----------------------------------------------------------------------------
create or replace function public.recalculate_exam_scores(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id uuid;
    v_owner   uuid;
    v_result  public.exam_results%rowtype;
    v_grade   jsonb;
    v_updated integer := 0;
begin
    select e.id, e.user_id into v_exam_id, v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    for v_result in
        select * from public.exam_results r
         where r.exam_code = p_exam_code
         order by r.submitted_at, r.id
    loop
        v_grade := public.grade_exam_answers(v_exam_id, v_result.answers_json);

        update public.exam_results r
           set score           = (v_grade ->> 'score')::numeric,
               total_questions = (v_grade ->> 'total')::int,
               answers_json    = v_grade -> 'corrected',
               needs_grading   = (v_grade ->> 'needs_grading')::boolean
         where r.id = v_result.id;

        v_updated := v_updated + 1;
    end loop;

    return jsonb_build_object(
        'success',       true,
        'updated_count', v_updated,
        'message',       'Đã chấm lại toàn bộ bài thi theo đáp án mới nhất.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- Grants: teacher-only for all lifecycle RPCs; grade_exam_answers stays internal.
-- ----------------------------------------------------------------------------
revoke all on function public.grade_exam_answers(uuid, jsonb)   from public;
revoke all on function public.delete_exam(varchar)              from public;
revoke all on function public.restore_exam(varchar)             from public;
revoke all on function public.purge_expired_exams()             from public;
revoke all on function public.recalculate_exam_scores(varchar)  from public;

grant execute on function public.delete_exam(varchar)             to authenticated;
grant execute on function public.restore_exam(varchar)            to authenticated;
grant execute on function public.purge_expired_exams()            to authenticated;
grant execute on function public.recalculate_exam_scores(varchar) to authenticated;

commit;
