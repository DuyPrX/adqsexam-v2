-- ============================================================================
-- PHASE 5.6 — SCHEDULED TRASH PURGE (pg_cron)
-- ----------------------------------------------------------------------------
-- Until now, purge_expired_exams() (schema.sql C.11) existed but nothing ever
-- called it, so the "tự động xóa sau 7 ngày" promise made by delete_exam() was
-- never actually enforced. This migration hands that responsibility to the
-- database itself:
--
--   * No extra Worker / Edge Function to deploy or keep warm.
--   * No outbound network path, so no Cloudflare request-quota consumption.
--   * Runs inside the same transaction domain as the data it deletes.
--
-- Job: purge-expired-exams-daily at 03:00 UTC == 10:00 Asia/Saigon (UTC+7).
--
-- Deploy note (Supabase free tier): a paused project runs no background
-- workers, so the job is suspended along with the database. pg_cron keeps the
-- schedule definition, and the next wake-up resumes the normal cadence — no
-- reconfiguration is needed. The Teacher Web thin-client sweep
-- (listTrashedExams -> after()) covers the window between wake-up and the next
-- 03:00 run, so the Trash list is never visibly stale.
--
-- Idempotent: safe to re-run.
--   cron.schedule(job_name, ...) upserts on job_name — verified against
--   pg_cron 1.6.4 — so re-running replaces the existing entry in place and
--   preserves its jobid. An explicit cron.unschedule() first would be
--   redundant (and would need a guard, since unscheduling an unknown name
--   raises "could not find valid entry for job").
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Enable the in-database scheduler.
--    Supabase ships pg_cron as an available extension (1.6.4 here); this is a
--    no-op where it is already installed.
-- ----------------------------------------------------------------------------
create extension if not exists pg_cron;


-- ----------------------------------------------------------------------------
-- 2. Schedule the daily sweep.
--    0 3 * * * → 03:00 UTC daily → 10:00 giờ Việt Nam.
-- ----------------------------------------------------------------------------
select cron.schedule(
    'purge-expired-exams-daily',
    '0 3 * * *',
    'select public.purge_expired_exams()'
);

commit;
