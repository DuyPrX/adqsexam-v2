-- ============================================================================
-- PHASE 5.1 — CERTIFICATE ISSUANCE & PUBLIC QR VERIFICATION
-- ----------------------------------------------------------------------------
-- 1. submit_exam_result() now returns the inserted `result_id` so the client
--    can build the public QR link `${origin}/verify.html?id=<result_id>`.
-- 2. New public RPC get_certificate_verification(p_result_id uuid) returning
--    the pass/fail verdict (score / total >= 0.8) plus safe metadata.
-- Mirrors the definitions in ../../supabase/schema.sql (Sections C.4 / C.6).
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. submit_exam_result — capture and return the new result id.
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
    v_exam          public.exams%rowtype;
    v_student       public.students%rowtype;
    v_session       public.active_sessions%rowtype;
    v_q             public.question_bank%rowtype;
    v_ans           jsonb;
    v_idx           integer := 0;
    v_total         integer := 0;
    v_sum           numeric := 0;
    v_score         numeric := 0;
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
    v_result_id     uuid;
    i               integer;
begin
    -- 1. Exam.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
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

    -- 4. Walk the authoritative question order and grade each answer.
    for v_q in
        select * from public.question_bank q
         where q.exam_id = v_exam.id
         order by q.position, q.created_at, q.id
    loop
        v_type := upper(coalesce(v_q.question_type, ''));

        -- Locate the client answer for this 0-based index (absent = unanswered).
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

    -- 5. Aggregate: clamp(round(sum*100)/100, 0, total).
    v_score := greatest(0, least(v_total, round(v_sum * 100) / 100));

    insert into public.exam_results (
        exam_code, student_code, student_name, class_name,
        score, total_questions, answers_json,
        blur_count, fullscreen_exit_count, elapsed_seconds, needs_grading
    ) values (
        p_exam_code, p_student_code,
        coalesce(v_student.full_name, ''), coalesce(v_student.class_name, ''),
        v_score, v_total, v_corrected,
        coalesce(nullif(regexp_replace(p_metrics ->> 'blurCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'fullscreenExitCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'elapsedSeconds', '\D', '', 'g'), '')::int, 0),
        v_needs_grading
    )
    returning id into v_result_id;

    -- 6. Retire the session so the token can never be reused.
    delete from public.active_sessions
     where exam_code = p_exam_code and student_code = p_student_code;

    return jsonb_build_object(
        'success',         true,
        'message',         'SUBMITTED',
        'result_id',       v_result_id,
        'score',           v_score,
        'total_questions', v_total,
        'needs_grading',   v_needs_grading
    );
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. get_certificate_verification — public read-only pass/fail verdict.
-- ----------------------------------------------------------------------------
create or replace function public.get_certificate_verification(
    p_result_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_result      public.exam_results%rowtype;
    v_exam_title  varchar(200);
    v_passed      boolean;
begin
    select * into v_result
      from public.exam_results
     where id = p_result_id;

    if not found then
        return jsonb_build_object('valid', false, 'message', 'NOT_FOUND');
    end if;

    v_passed := v_result.total_questions > 0
            and (v_result.score / v_result.total_questions::numeric) >= 0.8;

    select e.title into v_exam_title
      from public.exams e
     where e.code = v_result.exam_code;

    if not v_passed then
        return jsonb_build_object('valid', false, 'message', 'NOT_PASSED');
    end if;

    return jsonb_build_object(
        'valid',           true,
        'message',         'VALID',
        'result_id',       v_result.id,
        'exam_code',       v_result.exam_code,
        'exam_title',      coalesce(v_exam_title, v_result.exam_code),
        'student_name',    v_result.student_name,
        'student_code',    v_result.student_code,
        'class_name',      v_result.class_name,
        'score',           v_result.score,
        'total_questions', v_result.total_questions,
        'submitted_at',    v_result.submitted_at
    );
end;
$$;

revoke all on function public.get_certificate_verification(uuid) from public;
grant execute on function public.get_certificate_verification(uuid) to anon, authenticated;

commit;
