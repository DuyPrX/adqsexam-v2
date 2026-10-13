-- ============================================================================
-- ANTI-CHEAT SUITE — DETERMINISTIC SHUFFLING & LIVE PROCTORING (PHASE 11.2)
-- ----------------------------------------------------------------------------
-- 1. Update security_config default to include shuffle_options: true
-- 2. Backfill existing exams to include shuffle_options
-- 3. Enable Realtime Replication for public.exam_audit_logs
-- 4. Teacher RPC: proctor_force_submit_exam
-- ============================================================================

-- 1. Update security_config default to include shuffle_options
ALTER TABLE public.exams
ALTER COLUMN security_config SET DEFAULT '{
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
}'::jsonb;

-- 2. Backfill existing exams
UPDATE public.exams
SET security_config = jsonb_set(
  COALESCE(security_config, '{}'::jsonb),
  '{shuffle_options}',
  'true'::jsonb,
  true
)
WHERE security_config->>'shuffle_options' IS NULL;

-- 3. Enable Realtime Replication for audit logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'exam_audit_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.exam_audit_logs;
  END IF;
END $$;

ALTER TABLE public.exam_audit_logs REPLICA IDENTITY FULL;

-- 4. Teacher RPC: Force Submit Candidate Session
CREATE OR REPLACE FUNCTION public.proctor_force_submit_exam(
  p_exam_code VARCHAR,
  p_student_code VARCHAR,
  p_reason TEXT DEFAULT 'Giám thị thu bài trực tiếp'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_teacher_id UUID;
  v_exam RECORD;
BEGIN
  v_teacher_id := auth.uid();
  IF v_teacher_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
  END IF;

  SELECT id, code, user_id
  INTO v_exam
  FROM public.exams
  WHERE code = UPPER(TRIM(p_exam_code)) AND user_id = v_teacher_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  END IF;

  -- Insert audit record of forced submission
  INSERT INTO public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) VALUES (
    v_exam.code,
    TRIM(p_student_code),
    'PROCTOR_FORCE_SUBMIT',
    COALESCE(p_reason, 'Giám thị thu bài cưỡng chế'),
    jsonb_build_object('proctor_id', v_teacher_id, 'forced', true),
    now()
  );

  -- Remove from active_sessions if exists
  DELETE FROM public.active_sessions
  WHERE exam_code = v_exam.code 
    AND LOWER(TRIM(student_code)) = LOWER(TRIM(p_student_code));

  -- Close session in exam_sessions if table exists
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'exam_sessions'
  ) THEN
    EXECUTE 'UPDATE public.exam_sessions SET is_completed = true, submitted_at = now() WHERE exam_id = $1 AND LOWER(TRIM(student_code)) = LOWER(TRIM($2))'
    USING v_exam.id, p_student_code;
  END IF;

  RETURN jsonb_build_object('success', true, 'exam_code', v_exam.code, 'student_code', p_student_code);
END;
$$;

REVOKE ALL ON FUNCTION public.proctor_force_submit_exam(VARCHAR, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.proctor_force_submit_exam(VARCHAR, VARCHAR, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.proctor_force_submit_exam(VARCHAR, VARCHAR, TEXT) TO authenticated;
