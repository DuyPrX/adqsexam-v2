-- ============================================================================
-- ANTI-CHEAT SUITE — ADVANCED CLIENT DEFENSE & VIOLATION LIMITS (PHASE 11.1)
-- ----------------------------------------------------------------------------
-- 1. Update security_config default value on public.exams:
--    - enforce_fullscreen (boolean, default: true)
--    - detect_split_screen (boolean, default: true)
--    - detect_motion (boolean, default: false)
--    - max_violations (number, default: 3)
--    - auto_submit_on_limit (boolean, default: false)
-- 2. Backfill existing exams to include new keys if missing
-- ============================================================================

-- 1. Update security_config default value on public.exams
ALTER TABLE public.exams
ALTER COLUMN security_config SET DEFAULT '{
  "prevent_copy": true,
  "detect_multitouch": true,
  "blur_on_leave": true,
  "watermark": true,
  "enforce_fullscreen": true,
  "detect_split_screen": true,
  "detect_motion": false,
  "max_violations": 3,
  "auto_submit_on_limit": false
}'::jsonb;

-- 2. Backfill existing exams to include new keys if missing
UPDATE public.exams
SET security_config = jsonb_build_object(
  'prevent_copy', COALESCE((security_config->>'prevent_copy')::boolean, true),
  'detect_multitouch', COALESCE((security_config->>'detect_multitouch')::boolean, true),
  'blur_on_leave', COALESCE((security_config->>'blur_on_leave')::boolean, true),
  'watermark', COALESCE((security_config->>'watermark')::boolean, true),
  'enforce_fullscreen', COALESCE((security_config->>'enforce_fullscreen')::boolean, true),
  'detect_split_screen', COALESCE((security_config->>'detect_split_screen')::boolean, true),
  'detect_motion', COALESCE((security_config->>'detect_motion')::boolean, false),
  'max_violations', COALESCE((security_config->>'max_violations')::int, 3),
  'auto_submit_on_limit', COALESCE((security_config->>'auto_submit_on_limit')::boolean, false)
)
WHERE security_config IS NOT NULL;
