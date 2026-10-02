-- ============================================================================
-- ADQS EXAM v2 — PHASE 5: REALTIME PUBLICATION
-- ----------------------------------------------------------------------------
-- Enables Realtime delivery (D2) for the two tables the teacher live monitor
-- subscribes to.
--
-- WHY THIS MIGRATION EXISTS
--   Supabase creates the `supabase_realtime` publication EMPTY. A table that is
--   not a member produces NO postgres_changes events, even with
--   `[realtime] enabled = true` in config.toml. Adding the tables only to
--   schema.sql is not enough for `supabase db push` deployments, because the
--   Phase 1 migration was already applied and would not be re-run.
--
-- Idempotent: `alter publication ... add table` raises 42710 when the table is
-- already a member, so each addition is guarded.
-- ============================================================================

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'active_sessions'
    ) then
        alter publication supabase_realtime add table public.active_sessions;
    end if;

    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'exam_results'
    ) then
        alter publication supabase_realtime add table public.exam_results;
    end if;
end
$$;

-- Realtime evaluates a `filter` against the row carried in the WAL record.
-- Under the default replica identity an UPDATE/DELETE record holds only the
-- primary key, so `filter=exam_code=eq.<code>` cannot match and the event is
-- dropped. `exam_results` is keyed on `id`, so it needs the full old row.
-- `active_sessions` is keyed on (student_code, exam_code) — exam_code is part
-- of the key, so its filter works without this change.
alter table public.exam_results replica identity full;
