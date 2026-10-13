-- Migration: 20261013040000_session_recovery_and_proctor_actions.sql
-- Description: Server-anchored session time recovery, attempt reset & session reopen teacher RPCs

-- 1. Create public.exam_sessions table for durable per-student timing
CREATE TABLE IF NOT EXISTS public.exam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  exam_code VARCHAR(10) NOT NULL,
  student_code VARCHAR(50) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_sessions_exam_student_key UNIQUE(exam_id, student_code)
);

CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam_student ON public.exam_sessions(exam_id, student_code);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam_code ON public.exam_sessions(exam_code, student_code);

ALTER TABLE public.exam_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers can read their exam sessions" ON public.exam_sessions;
DROP POLICY IF EXISTS "Teachers can manage their exam sessions" ON public.exam_sessions;
CREATE POLICY "Teachers can manage their exam sessions"
ON public.exam_sessions FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.id = exam_sessions.exam_id AND e.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.id = exam_sessions.exam_id AND e.user_id = auth.uid()
  )
);

-- 2. Teacher RPC: Reset Student Exam Attempt
CREATE OR REPLACE FUNCTION public.reset_student_exam_attempt(
  p_exam_code VARCHAR,
  p_student_code VARCHAR,
  p_reason TEXT DEFAULT 'Giáo viên cấp lại lượt thi mới'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_teacher_id UUID;
  v_exam RECORD;
  v_clean_code VARCHAR;
  v_clean_student VARCHAR;
BEGIN
  v_teacher_id := auth.uid();
  IF v_teacher_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
  END IF;

  v_clean_code := UPPER(TRIM(p_exam_code));
  v_clean_student := TRIM(p_student_code);

  SELECT id, code, user_id INTO v_exam
  FROM public.exams
  WHERE code = v_clean_code AND user_id = v_teacher_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  END IF;

  -- Remove prior attempt records from active_sessions
  DELETE FROM public.active_sessions
  WHERE exam_code = v_clean_code AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  -- Remove prior submission from exam_results
  DELETE FROM public.exam_results
  WHERE exam_code = v_clean_code AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  -- Remove prior session from exam_sessions
  DELETE FROM public.exam_sessions
  WHERE exam_id = v_exam.id AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  -- Log action
  INSERT INTO public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) VALUES (
    v_clean_code, v_clean_student, 'TEACHER_RESET_ATTEMPT', COALESCE(p_reason, 'Cấp lại lượt thi'),
    jsonb_build_object('proctor_id', v_teacher_id), now()
  );

  RETURN jsonb_build_object('success', true, 'exam_code', v_clean_code, 'student_code', v_clean_student);
END;
$$;

REVOKE ALL ON FUNCTION public.reset_student_exam_attempt(VARCHAR, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_student_exam_attempt(VARCHAR, VARCHAR, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reset_student_exam_attempt(VARCHAR, VARCHAR, TEXT) TO authenticated;

-- 3. Teacher RPC: Reopen & Extend Session
CREATE OR REPLACE FUNCTION public.reopen_student_exam_session(
  p_exam_code VARCHAR,
  p_student_code VARCHAR,
  p_extra_minutes INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_teacher_id UUID;
  v_exam RECORD;
  v_clean_code VARCHAR;
  v_clean_student VARCHAR;
  v_new_ends_at TIMESTAMPTZ;
  v_mins INT := COALESCE(p_extra_minutes, 5);
BEGIN
  v_teacher_id := auth.uid();
  IF v_teacher_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập.');
  END IF;

  v_clean_code := UPPER(TRIM(p_exam_code));
  v_clean_student := TRIM(p_student_code);

  SELECT id, code, user_id INTO v_exam
  FROM public.exams
  WHERE code = v_clean_code AND user_id = v_teacher_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  END IF;

  SELECT ends_at INTO v_new_ends_at
  FROM public.exam_sessions
  WHERE exam_id = v_exam.id AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  IF NOT FOUND THEN
    -- If no prior session exists, create a fresh one anchored from now
    v_new_ends_at := now() + (v_mins || ' minutes')::INTERVAL;
    INSERT INTO public.exam_sessions (
      exam_id, exam_code, student_code, started_at, ends_at, is_completed
    ) VALUES (
      v_exam.id, v_clean_code, v_clean_student, now(), v_new_ends_at, false
    );
  ELSE
    v_new_ends_at := GREATEST(now(), v_new_ends_at) + (v_mins || ' minutes')::INTERVAL;

    UPDATE public.exam_sessions
    SET is_completed = false,
        submitted_at = NULL,
        ends_at = v_new_ends_at
    WHERE exam_id = v_exam.id AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);
  END IF;

  -- Remove prior submission from exam_results if any so candidate can submit again
  DELETE FROM public.exam_results
  WHERE exam_code = v_clean_code AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  -- Remove stale active_session row to allow immediate re-entry
  DELETE FROM public.active_sessions
  WHERE exam_code = v_clean_code AND LOWER(TRIM(student_code)) = LOWER(v_clean_student);

  INSERT INTO public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) VALUES (
    v_clean_code, v_clean_student, 'TEACHER_REOPEN_SESSION', 'Mở lại bài thi và gia hạn ' || v_mins || ' phút',
    jsonb_build_object('proctor_id', v_teacher_id, 'new_ends_at', v_new_ends_at), now()
  );

  RETURN jsonb_build_object('success', true, 'new_ends_at', v_new_ends_at);
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_student_exam_session(VARCHAR, VARCHAR, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_student_exam_session(VARCHAR, VARCHAR, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reopen_student_exam_session(VARCHAR, VARCHAR, INT) TO authenticated;

-- 4. Update verify_and_acquire_session to anchor ends_at & calculate time_remaining_seconds
CREATE OR REPLACE FUNCTION public.verify_and_acquire_session(
    p_exam_code      varchar,
    p_student_code   varchar default null,
    p_full_name      varchar default null,
    p_class_name     varchar default null,
    p_device_info    text    default null,
    p_existing_token uuid    default null,
    p_pin            varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam              public.exams%rowtype;
    v_student           public.students%rowtype;
    v_session           public.active_sessions%rowtype;
    v_exam_session      public.exam_sessions%rowtype;
    v_new_token         uuid := gen_random_uuid();
    v_code              varchar;
    v_name              varchar;
    v_class             varchar;
    v_sec_cfg           jsonb;
    v_now               timestamptz := now();
    v_remaining_seconds int := 0;
begin
    -- 1. Exam must exist and be open.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    if v_exam.is_active is not true then
        return jsonb_build_object('success', false, 'message', 'EXAM_INACTIVE');
    end if;

    if v_exam.starts_at is not null and v_now < v_exam.starts_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_STARTED');
    end if;
    if v_exam.ends_at is not null and v_now > v_exam.ends_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_EXPIRED');
    end if;

    v_sec_cfg := coalesce(v_exam.security_config, '{
      "prevent_copy": true,
      "detect_multitouch": true,
      "blur_on_leave": true,
      "watermark": true,
      "enforce_fullscreen": true,
      "detect_split_screen": true,
      "detect_motion": false,
      "shuffle_options": true,
      "max_violations": 3,
      "auto_submit_on_limit": false
    }'::jsonb);

    -- 2. Resolve candidate.
    v_code  := nullif(lower(trim(coalesce(p_student_code, ''))), '');
    v_name  := nullif(lower(regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g')), '');
    v_class := nullif(lower(regexp_replace(trim(coalesce(p_class_name, '')), '\s+', ' ', 'g')), '');

    if v_code is not null then
        select * into v_student
          from public.students s
         where s.exam_code = p_exam_code
           and lower(trim(s.student_code)) = v_code;
    elsif v_name is not null and v_class is not null then
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

    -- 3. Identity verification
    if lower(regexp_replace(trim(v_student.full_name),  '\s+', ' ', 'g')) <> coalesce(v_name, '')
       or lower(regexp_replace(trim(v_student.class_name), '\s+', ' ', 'g')) <> coalesce(v_class, '') then
        return jsonb_build_object('success', false, 'message', 'IDENTITY_MISMATCH');
    end if;

    -- 3.b PIN gate
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
            if trim(coalesce(p_pin, '')) is distinct from trim(v_student.pin) then
                return jsonb_build_object(
                    'success', false,
                    'code',    'INVALID_PIN',
                    'message', 'Mã PIN hoặc ngày sinh (DDMM) không chính xác.'
                );
            end if;

        elsif v_student.dob is not null then
            if trim(coalesce(p_pin, '')) is distinct from to_char(v_student.dob, 'DDMM') then
                return jsonb_build_object(
                    'success', false,
                    'code',    'INVALID_PIN',
                    'message', 'Mã PIN hoặc ngày sinh (DDMM) không chính xác.'
                );
            end if;
        end if;
    end if;

    -- 4. Check existing submission
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = v_student.student_code
    ) then
        return jsonb_build_object(
            'success', false,
            'code', 'EXAM_ALREADY_SUBMITTED',
            'message', 'ALREADY_SUBMITTED'
        );
    end if;

    -- 5. Server-anchored timing recovery via exam_sessions
    select * into v_exam_session
      from public.exam_sessions
     where exam_id = v_exam.id
       and lower(trim(student_code)) = lower(trim(v_student.student_code));

    if found then
        if v_exam_session.is_completed then
            return jsonb_build_object(
                'success', false,
                'code', 'EXAM_ALREADY_SUBMITTED',
                'message', 'ALREADY_SUBMITTED'
            );
        end if;

        v_remaining_seconds := greatest(0, extract(epoch from (v_exam_session.ends_at - v_now))::int);
        if v_remaining_seconds <= 0 then
            update public.exam_sessions
               set is_completed = true,
                   submitted_at = v_now
             where id = v_exam_session.id;

            return jsonb_build_object(
                'success', false,
                'code', 'EXAM_TIME_EXPIRED',
                'message', 'EXAM_TIME_EXPIRED'
            );
        end if;
    else
        -- Initial session creation
        insert into public.exam_sessions (
            exam_id, exam_code, student_code, started_at, ends_at, is_completed
        ) values (
            v_exam.id, p_exam_code, v_student.student_code, v_now,
            v_now + (v_exam.duration_minutes || ' minutes')::interval, false
        ) returning * into v_exam_session;

        v_remaining_seconds := v_exam.duration_minutes * 60;
    end if;

    -- 6. Active sessions lock & recovery
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = v_student.student_code
     for update;

    if found then
        if v_session.last_heartbeat > v_now - interval '60 seconds' then
            if p_existing_token is not null and p_existing_token = v_session.session_token then
                update public.active_sessions
                   set last_heartbeat = v_now,
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
                    'time_remaining_seconds', v_remaining_seconds,
                    'started_at', v_exam_session.started_at,
                    'ends_at', v_exam_session.ends_at,
                    'shuffle_questions', v_exam.shuffle_questions,
                    'security_config', v_sec_cfg,
                    'message', 'SESSION_RESUMED'
                );
            end if;
            return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
        end if;

        update public.active_sessions
           set session_token         = v_new_token,
               last_heartbeat        = v_now,
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
            'time_remaining_seconds', v_remaining_seconds,
            'started_at', v_exam_session.started_at,
            'ends_at', v_exam_session.ends_at,
            'shuffle_questions', v_exam.shuffle_questions,
            'security_config', v_sec_cfg,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

    insert into public.active_sessions (
        student_code, exam_code, session_token, last_heartbeat,
        current_question, answered_count, blur_count, fullscreen_exit_count, device_info
    ) values (
        v_student.student_code, p_exam_code, v_new_token, v_now,
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
        'time_remaining_seconds', v_remaining_seconds,
        'started_at', v_exam_session.started_at,
        'ends_at', v_exam_session.ends_at,
        'shuffle_questions', v_exam.shuffle_questions,
        'security_config', v_sec_cfg,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;

REVOKE ALL ON FUNCTION public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) TO anon, authenticated;

-- 5. Update submit_exam_result to also stamp exam_sessions
CREATE OR REPLACE FUNCTION public.submit_exam_result(
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

    -- 5. Mark completed in exam_sessions if present
    update public.exam_sessions
       set is_completed = true,
           submitted_at = now()
     where exam_id = v_exam.id
       and lower(trim(student_code)) = lower(trim(p_student_code));

    -- 6. Retire the active session
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
