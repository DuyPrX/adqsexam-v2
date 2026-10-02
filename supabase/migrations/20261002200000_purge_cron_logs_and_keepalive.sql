-- ============================================================================
-- PHASE 5.7 — PG_CRON LOG RETENTION & KEEP-ALIVE SUPPORT
-- ----------------------------------------------------------------------------
-- 1. purge_expired_exams() now also prunes cron.job_run_details.
--
--    Once the Phase 5.6 schedule began running purge-expired-exams-daily, every
--    execution appended a row to cron.job_run_details. That table is never
--    pruned by pg_cron itself, so on a project running for years it grows
--    without bound. The sweep that already runs daily is the natural place to
--    trim it.
--
--    The prune is guarded by an extension check rather than assumed: the
--    function must remain creatable and callable on a database without pg_cron
--    (plpgsql parses statements lazily, so the guarded DELETE is never even
--    planned when the guard is false — verified on PG17).
--
--    RLS note: cron.job_run_details is RLS-enabled with policy
--    `username = CURRENT_USER`. This function is SECURITY DEFINER and owned by
--    `postgres`, which holds BYPASSRLS, so the DELETE is not filtered. Were the
--    ownership ever moved to a role without BYPASSRLS, the prune would silently
--    delete 0 rows.
--
-- 2. Keep-alive: the Supabase free tier pauses a project after 7 days without
--    activity, and a paused project runs no pg_cron workers — so pg_cron alone
--    cannot keep the project itself alive. That job belongs to an external
--    pinger; see worker/src/index.ts `scheduled` and wrangler.toml [triggers].
--    Nothing database-side is required for it, which is why this migration only
--    touches the log retention.
--
-- Idempotent: safe to re-run.
-- ============================================================================
begin;

create or replace function public.purge_expired_exams()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_purged integer;
    v_pruned bigint := 0;
begin
    with doomed as (
        delete from public.exams e
         where e.deleted_at is not null
           and e.deleted_at < now() - interval '7 days'
        returning 1
    )
    select count(*) into v_purged from doomed;

    -- Prune pg_cron's own run history (retain 30 days). Guarded so this remains
    -- a valid function on a database where pg_cron was never installed.
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        delete from cron.job_run_details
         where start_time < now() - interval '30 days';
        get diagnostics v_pruned = row_count;
    end if;

    return jsonb_build_object(
        'success',      true,
        'purged_count', coalesce(v_purged, 0),
        'pruned_logs',  coalesce(v_pruned, 0),
        'message',      'Đã xóa vĩnh viễn các đề thi quá thời hạn lưu trữ.'
    );
end;
$$;

-- Re-assert the grant dropped by `create or replace` on some PG versions.
revoke all on function public.purge_expired_exams() from public;
grant execute on function public.purge_expired_exams() to authenticated;

commit;
