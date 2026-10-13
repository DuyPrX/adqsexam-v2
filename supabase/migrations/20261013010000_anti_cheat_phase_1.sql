-- ============================================================================
-- ANTI-CHEAT SUITE — CLIENT DEFENSE SHIELD & SECURITY CONFIG (PHASE 11.0)
-- ----------------------------------------------------------------------------
-- 1. Add security_config column to public.exams
-- 2. Audit logs table for proctoring violations: public.exam_audit_logs
-- 3. Public RPC: log_exam_violation(p_exam_code, p_student_code, p_violation_type, p_message, p_metadata)
-- 4. Expose security_config in verify_and_acquire_session & get_exam_roster
-- ============================================================================

-- 1. Add security_config column to exams
ALTER TABLE public.exams
ADD COLUMN IF NOT EXISTS security_config JSONB NOT NULL DEFAULT '{
  "prevent_copy": true,
  "detect_multitouch": true,
  "blur_on_leave": true,
  "watermark": true,
  "max_violations": 3
}'::jsonb;

-- 2. Audit logs table for proctoring violations
CREATE TABLE IF NOT EXISTS public.exam_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_code VARCHAR(50) NOT NULL,
  student_code VARCHAR(50) NOT NULL,
  violation_type VARCHAR(50) NOT NULL,
  violation_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exam_audit_logs_lookup
ON public.exam_audit_logs (exam_code, student_code, occurred_at DESC);

ALTER TABLE public.exam_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers can read audit logs for their exams" ON public.exam_audit_logs;
CREATE POLICY "Teachers can read audit logs for their exams"
ON public.exam_audit_logs FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.code = exam_audit_logs.exam_code AND e.user_id = auth.uid()
  )
);

-- 3. Public RPC: Log Violation Event
CREATE OR REPLACE FUNCTION public.log_exam_violation(
  p_exam_code VARCHAR,
  p_student_code VARCHAR,
  p_violation_type VARCHAR,
  p_message TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_exam_code IS NULL OR p_student_code IS NULL OR p_violation_type IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ARGS');
  END IF;

  INSERT INTO public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) VALUES (
    UPPER(TRIM(p_exam_code)),
    TRIM(p_student_code),
    TRIM(p_violation_type),
    p_message,
    COALESCE(p_metadata, '{}'::jsonb),
    now()
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.log_exam_violation(VARCHAR, VARCHAR, VARCHAR, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_exam_violation(VARCHAR, VARCHAR, VARCHAR, TEXT, JSONB) TO anon, authenticated;

-- 4. Update verify_and_acquire_session to return security_config
CREATE OR REPLACE FUNCTION public.verify_and_acquire_session(
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
    v_sec_cfg   jsonb;
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

    if v_exam.starts_at is not null and now() < v_exam.starts_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_STARTED');
    end if;
    if v_exam.ends_at is not null and now() > v_exam.ends_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_EXPIRED');
    end if;

    v_sec_cfg := coalesce(v_exam.security_config, '{
      "prevent_copy": true,
      "detect_multitouch": true,
      "blur_on_leave": true,
      "watermark": true,
      "max_violations": 3
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

    -- 4. One submission per candidate
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = v_student.student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    -- 5. Session lock
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = v_student.student_code
     for update;

    if found then
        if v_session.last_heartbeat > now() - interval '60 seconds' then
            if p_existing_token is not null and p_existing_token = v_session.session_token then
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
                    'security_config', v_sec_cfg,
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
            'security_config', v_sec_cfg,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

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
        'security_config', v_sec_cfg,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;

revoke all on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) from public;
grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar) to anon, authenticated;

-- 5. Also expose security_config in get_exam_roster
CREATE OR REPLACE FUNCTION public.get_exam_roster(
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
    v_sec_cfg    jsonb;
begin
    if p_exam_code is null or trim(p_exam_code) = '' then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    select * into v_exam from public.exams where code = upper(trim(p_exam_code));
    if not found then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    if p_for_practice then
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
            return jsonb_build_object('success', false, 'code', 'EXAM_EXPIRED', 'message', 'Đã hết giờ làm bài.');
        end if;
    end if;

    v_sec_cfg := coalesce(v_exam.security_config, '{
      "prevent_copy": true,
      "detect_multitouch": true,
      "blur_on_leave": true,
      "watermark": true,
      "max_violations": 3
    }'::jsonb);

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
        'duration_minutes', v_exam.duration_minutes,
        'pin_mode',       v_exam.pin_mode,
        'allow_practice', v_exam.allow_practice,
        'shuffle_questions', v_exam.shuffle_questions,
        'security_config', v_sec_cfg,
        'candidates',     coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_exam_roster(varchar, boolean) from public;
grant execute on function public.get_exam_roster(varchar, boolean) to anon, authenticated;
