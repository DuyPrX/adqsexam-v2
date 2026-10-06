-- ============================================================================
-- PHASE 8.5 (HARDENING) — revoke the stale `anon` EXECUTE grant on the five
-- teacher-only RPCs
-- ----------------------------------------------------------------------------
-- WHY
--   Phase 6.1 discovered that `revoke ... from public` does NOT strip `anon`'s
--   grant: Supabase's database default privileges grant EXECUTE to `anon`
--   DIRECTLY, and an explicit grant survives a PUBLIC revoke. Verified then with
--   `has_function_privilege('anon', ...) = true` after the PUBLIC revoke, and the
--   fix was applied to `import_class_to_exam` only.
--
--   Five PRE-EXISTING teacher-only RPCs were left carrying the same stale grant:
--       delete_exam(varchar)
--       restore_exam(varchar)
--       purge_expired_exams()
--       recalculate_exam_scores(varchar)
--       update_exam_questions_safe(varchar, jsonb)
--   Re-verified locally before this migration: all five reported anon=true while
--   import_class_to_exam correctly reported anon=false.
--
--   They are NOT exploitable as written — every one rejects an anonymous caller
--   inside its body via auth.uid() — but the ACL advertised a privilege the
--   design does not intend, which is a latent hazard: any future edit that
--   weakens a body check would silently expose the function. This migration makes
--   the ACL match the documented "teacher-only" intent.
--
-- SAFETY
--   Pure `revoke` — no body, signature or return type changes. The five
--   signatures are unchanged, so no DROP/overload handling is needed. The grants
--   to `authenticated` are deliberately left in place.
--
-- IDEMPOTENT
--   `revoke` on an already-absent privilege is a no-op, so this can be re-run.
-- ============================================================================

revoke all on function public.update_exam_questions_safe(varchar, jsonb) from anon;
revoke all on function public.delete_exam(varchar)                       from anon;
revoke all on function public.restore_exam(varchar)                      from anon;
revoke all on function public.purge_expired_exams()                      from anon;
revoke all on function public.recalculate_exam_scores(varchar)           from anon;

-- Restate the teacher grants so the intent is explicit and a future reader does
-- not have to reconstruct it from schema.sql.
grant execute on function public.update_exam_questions_safe(varchar, jsonb) to authenticated;
grant execute on function public.delete_exam(varchar)                       to authenticated;
grant execute on function public.restore_exam(varchar)                      to authenticated;
grant execute on function public.purge_expired_exams()                      to authenticated;
grant execute on function public.recalculate_exam_scores(varchar)           to authenticated;
