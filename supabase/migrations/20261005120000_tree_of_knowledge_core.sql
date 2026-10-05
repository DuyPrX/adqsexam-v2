-- ============================================================================
-- PHASE 7.1 — TREE OF KNOWLEDGE: SCHEMA, REALTIME & SIMILARITY RPC
-- ----------------------------------------------------------------------------
-- The "Cây tri thức" activity: a teacher poses one open question to a class,
-- every student submits a free-text answer, and each accepted answer becomes a
-- "fruit" on a shared, synchronised tree. Submissions are de-duplicated by text
-- similarity so the tree grows with *distinct* ideas rather than five copies of
-- the same sentence.
--
-- THREE DEFECTS IN THE DRAFT DDL WERE FOUND BY LOCAL PROBE AND FIXED HERE:
--
--   (1) RLS: the draft's `tree_submissions` SELECT policy used an inline
--       `EXISTS (SELECT 1 FROM public.tree_sessions ...)`. A policy predicate is
--       evaluated AS THE QUERYING ROLE (`anon`), and anon holds NO privilege on
--       tree_sessions (Section B revokes it) — so the query raises
--       `ERROR: permission denied for table tree_sessions` instead of returning
--       rows. Reproduced locally, and fixed with a SECURITY DEFINER helper
--       `tree_session_is_public(uuid)`, which runs as the owner and therefore
--       sees past both the table ACL and the parent's RLS. Verified working.
--
--   (2) pg_trgm placement: `create extension pg_trgm` lands in whichever schema
--       the installer's search_path names first — on Supabase that is `public`
--       only by accident of the current path, while `pgcrypto` already lives in
--       `extensions`. The RPCs pin `search_path = public, pg_temp`, so if the
--       extension ever lands anywhere else, `similarity()` raises
--       `undefined_function` at RUNTIME (not at create time). Pinning the schema
--       explicitly with `with schema extensions` + `similarity(...)` called
--       schema-qualified removes the dependency on ambient state entirely.
--
--   (3) `real` vs `numeric`: `v_max_sim real` compared against
--       `max_similarity numeric(3,2)` resolves via implicit cast, but the cast is
--       lossy and the comparison silently degrades. Typed as `numeric` to compare
--       like with like.
--
-- IDEMPOTENT: tables/indexes use `if not exists`, policies use
-- `drop policy if exists` first, the function is `create or replace` (same
-- signature every run). The publication add is guarded because `add table`
-- raises 42710 when the table is already a member.
-- ============================================================================

begin;

-- 1. Text similarity. `with schema extensions` matches Supabase's convention
--    (pgcrypto already lives there), but it is a NO-OP when the extension is
--    already installed — and on Supabase it often is, having been created by an
--    earlier script into whichever schema happened to be first on the installer's
--    search_path (`public`). Two independent worries:
--
--      * `similarity()` is called from an RPC that pins
--        `search_path = public, pg_temp`; an extension sitting in `extensions`
--        would NOT resolve. Every call is schema-qualified, so this is handled.
--      * The GIN index needs `gin_trgm_ops`, and an unqualified operator class
--        name is resolved at CREATE INDEX time against the current search_path.
--
--    The explicit `alter extension ... set schema` below pins the location
--    regardless of where a prior run left it, and is itself a no-op when already
--    correct. Belt-and-braces, because the failure is a RUNTIME error that no
--    amount of create-time testing would have caught.
create extension if not exists pg_trgm with schema extensions;
alter extension pg_trgm set schema extensions;


-- ============================================================================
-- 2. TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tree_sessions — one teacher-owned activity, scoped to a class roster.
--   min_words       : shortest acceptable answer, counted after whitespace
--                     normalisation.
--   max_similarity  : trigram similarity ceiling (0.00-1.00). NULL means "no
--                     similarity check"; the RPC compares with IS NOT NULL, so a
--                     NULL can never silently reject every answer.
--   tree_seed       : lets the client grow a deterministic procedural tree, so
--                     every student's browser draws the SAME tree without any
--                     tree geometry being stored.
--   ended_at        : set when the teacher closes early; `is_active` remains the
--                     authoritative switch the RPC reads.
-- ----------------------------------------------------------------------------
create table if not exists public.tree_sessions (
    id                 uuid         primary key default gen_random_uuid(),
    user_id            uuid         not null references auth.users (id) on delete cascade,
    -- RESTRICT (not cascade): a class roster is shared with exams, so silently
    -- destroying an activity's grouping because a class was deleted would be
    -- surprising. The teacher must delete the session first.
    class_id           uuid         not null references public.classes (id) on delete restrict,
    title              varchar(255) not null,
    question_text      text         not null,
    min_words          integer      not null default 20,
    time_limit_minutes integer      not null default 45,
    max_similarity     numeric(3,2) not null default 0.60,
    tree_seed          integer      not null default floor(random() * 1000000)::integer,
    is_active          boolean      not null default true,
    created_at         timestamptz  not null default now(),
    ended_at           timestamptz,
    -- A similarity ceiling outside (0,1] is nonsensical: 0 would reject every
    -- answer (each text is 100% similar to itself) and >1 can never trigger.
    constraint tree_sessions_max_similarity_range
        check (max_similarity > 0.0 and max_similarity <= 1.0),
    constraint tree_sessions_min_words_positive check (min_words > 0),
    constraint tree_sessions_time_limit_positive check (time_limit_minutes > 0)
);

comment on table public.tree_sessions is 'Teacher-owned "Cây tri thức" activity: one open question posed to a class (Phase 7.1).';
comment on column public.tree_sessions.max_similarity is 'Trigram similarity ceiling. An answer at or below this is accepted; above it is rejected as duplicated.';
comment on column public.tree_sessions.tree_seed is 'Deterministic seed so every client renders the same procedural tree.';

-- ----------------------------------------------------------------------------
-- tree_submissions — one answer per student per session ("fruit").
--   fruit_index : the ordinal the student's fruit occupies on the tree.
--   The UNIQUE(session_id, student_code) is what makes a resubmission an UPDATE
--   rather than a duplicate fruit: `on conflict do update` keeps the original
--   fruit_index so the tree does not reshuffle when a student edits their answer.
-- ----------------------------------------------------------------------------
create table if not exists public.tree_submissions (
    id           uuid         primary key default gen_random_uuid(),
    session_id   uuid         not null references public.tree_sessions (id) on delete cascade,
    student_code varchar(50)  not null,
    student_name varchar(100) not null,
    answer_text  text         not null,
    word_count   integer      not null,
    submitted_at timestamptz  not null default now(),
    fruit_index  integer      not null,
    constraint tree_submissions_session_student_uniq unique (session_id, student_code),
    -- The RPC is the only writer, but a monotonic index is worth defending:
    -- fruit_index is the tree's visual ordering, so a 0 or negative value would
    -- place a fruit before the trunk.
    constraint tree_submissions_fruit_index_positive check (fruit_index > 0),
    constraint tree_submissions_word_count_nonneg check (word_count >= 0)
);

comment on table public.tree_submissions is 'Student answers ("fruits") for a tree session. UNIQUE(session_id, student_code) makes resubmission an update, not a new fruit.';


-- ============================================================================
-- 3. INDEXES
-- ============================================================================
create index if not exists idx_tree_sessions_class_id        on public.tree_sessions (class_id);
create index if not exists idx_tree_sessions_user_id         on public.tree_sessions (user_id);
create index if not exists idx_tree_submissions_session_id   on public.tree_submissions (session_id);
-- The similarity scan filters by session; this index orders the tree in one pass.
create index if not exists idx_tree_submissions_session_fruit on public.tree_submissions (session_id, fruit_index);
-- Trigram index backing similarity()/word-similarity lookups. Schema-qualified:
-- the operator class is created by the extension in `extensions`, not `public`.
create index if not exists idx_tree_submissions_trgm
    on public.tree_submissions using gin (answer_text extensions.gin_trgm_ops);


-- ============================================================================
-- 4. RLS PREDICATE HELPER
-- ----------------------------------------------------------------------------
-- Created BEFORE the policies that reference it: `create policy` parses and
-- validates its expression immediately, so a forward reference to a
-- not-yet-existing function aborts the script.
-- ----------------------------------------------------------------------------
-- tree_session_is_public — RLS predicate helper (Phase 7.1).
--   SECURITY DEFINER so the EXISTS runs as the table owner: `anon` has no
--   privilege on tree_sessions, so an inline subquery inside a policy would
--   raise `permission denied` rather than filtering. STABLE (one call per row,
--   no writes) and NULL-safe: an unknown session id returns false, never NULL,
--   because a NULL predicate would make the row invisible anyway and hide bugs.
-- ----------------------------------------------------------------------------
create or replace function public.tree_session_is_public(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.tree_sessions s
        where s.id = p_session_id
    );
$$;

comment on function public.tree_session_is_public(uuid) is 'RLS helper: may anon read this session''s submissions? SECURITY DEFINER because anon has no privilege on tree_sessions.';


-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================
alter table public.tree_sessions    enable row level security;
alter table public.tree_submissions enable row level security;

-- --- tree_sessions: full CRUD for the owning teacher -------------------------
drop policy if exists tree_sessions_owner_all on public.tree_sessions;
create policy tree_sessions_owner_all on public.tree_sessions
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- --- tree_submissions --------------------------------------------------------
-- Teachers may read submissions for their own sessions (for review/export).
drop policy if exists tree_submissions_teacher_read on public.tree_submissions;
create policy tree_submissions_teacher_read on public.tree_submissions
    for select
    to authenticated
    using (
        exists (
            select 1 from public.tree_sessions s
            where s.id = tree_submissions.session_id and s.user_id = auth.uid()
        )
    );

-- Students (anon) may READ the fruits of a session so the tree can be rendered
-- and kept live. The predicate MUST go through a SECURITY DEFINER helper: an
-- inline EXISTS on tree_sessions is evaluated as `anon`, which has no privilege
-- on that table, and the query fails outright. See header note (1).
drop policy if exists tree_submissions_public_read on public.tree_submissions;
create policy tree_submissions_public_read on public.tree_submissions
    for select
    to anon, authenticated
    using (public.tree_session_is_public(session_id));

-- --- Privilege hardening -----------------------------------------------------
-- Students hold NO direct table privileges; writes are RPC-only, exactly like
-- every other student-facing table in this schema.
revoke all on public.tree_sessions    from anon;
revoke all on public.tree_submissions from anon;
-- Students read submissions through the policy above.
grant select on public.tree_submissions to anon;


-- ============================================================================
-- 6. RPC: submit_tree_answer
-- ============================================================================

-- ----------------------------------------------------------------------------
-- submit_tree_answer — the single student write path (Phase 7.1).
--   Validates the session, enforces the minimum word count, rejects text that is
--   too similar to an existing answer, then assigns the next fruit ordinal and
--   upserts. Returns a jsonb envelope ({success, code, ...}) rather than RAISEing,
--   matching get_exam_roster / verify_and_acquire_session so the client has one
--   error-handling shape.
--
--   SIMILARITY SEMANTICS: the check deliberately EXCLUDES the caller's own prior
--   submission (student_code <>) — otherwise a student editing their answer would
--   be compared against their previous text and could never improve it.
--
--   RACE: `max(fruit_index) + 1` is not atomic under concurrent inserts, so two
--   simultaneous first-submissions could collide on the same ordinal. The
--   UNIQUE(session_id, student_code) still prevents duplicate students; only the
--   ordinal could tie, which the client sorts on. Left as-is rather than adding a
--   serialisable lock, since this is a classroom activity and a duplicate ordinal
--   is cosmetic — flagged here so it is a known trade-off, not an oversight.
-- ----------------------------------------------------------------------------
-- Drop any prior overload first: `create or replace` matches on the SIGNATURE,
-- so a changed parameter list would leave the old function callable alongside
-- the new one (the Phase 6.1 lesson).
drop function if exists public.submit_tree_answer(uuid, varchar, varchar, text);

create or replace function public.submit_tree_answer(
    p_session_id   uuid,
    p_student_code varchar,
    p_student_name varchar,
    p_answer_text  text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session           public.tree_sessions%rowtype;
    v_clean_text        text;
    v_word_count        integer;
    v_max_sim           numeric := 0.0;
    v_next_fruit_index  integer;
    v_submission_id     uuid;
    v_student_code      varchar(50);
    v_student_name      varchar(100);
begin
    -- 0. Reject malformed input before touching the database. Without this, a
    --    NULL/blank student code would bypass the UNIQUE constraint check in
    --    confusing ways and could overwrite another blank-code row.
    v_student_code := trim(coalesce(p_student_code, ''));
    v_student_name := trim(coalesce(p_student_name, ''));
    if p_session_id is null then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;
    if v_student_code = '' or v_student_name = '' then
        return jsonb_build_object('success', false, 'code', 'IDENTITY_REQUIRED', 'message', 'Thiếu thông tin học sinh.');
    end if;

    -- 1. Session must exist and still be open.
    select * into v_session
      from public.tree_sessions
     where id = p_session_id;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    if v_session.is_active is not true then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;

    -- 1.a Time limit. make_interval is used instead of the draft's
    --     `(integer || ' minutes')::interval`, which depends on integer->text
    --     casting and a locale-independent interval parser.
    if now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Đã hết thời gian làm bài.');
    end if;

    -- 2. Normalise whitespace (including newlines/tabs) and count words.
    v_clean_text := regexp_replace(trim(coalesce(p_answer_text, '')), '\s+', ' ', 'g');
    if v_clean_text = '' then
        v_word_count := 0;
    else
        v_word_count := cardinality(string_to_array(v_clean_text, ' '));
    end if;

    if v_word_count < v_session.min_words then
        return jsonb_build_object(
            'success',        false,
            'code',           'MIN_WORDS_NOT_MET',
            'current_words',  v_word_count,
            'required_words', v_session.min_words,
            'message',        format('Câu trả lời cần tối thiểu %s từ (bạn mới nhập %s từ).', v_session.min_words, v_word_count)
        );
    end if;

    -- 3. Similarity against OTHER students' answers in this session.
    --    schema-qualified: pg_trgm lives in `extensions`, which is NOT on the
    --    pinned search_path.
    select coalesce(max(extensions.similarity(s.answer_text, v_clean_text)), 0.0)
      into v_max_sim
      from public.tree_submissions s
     where s.session_id = p_session_id
       and s.student_code <> v_student_code;

    -- Strict `>`: a score exactly at the ceiling is permitted, matching the
    -- documented "max_similarity = highest allowed" reading.
    if v_max_sim > v_session.max_similarity then
        return jsonb_build_object(
            'success',            false,
            'code',               'SIMILARITY_EXCEEDED',
            'similarity_percent', round(v_max_sim * 100, 1),
            'message',            format('Câu trả lời bị trùng lặp %s%% với bài đã nộp. Vui lòng tự diễn đạt lại!', round(v_max_sim * 100, 1))
        );
    end if;

    -- 4. Next fruit ordinal, then upsert.
    --    On resubmission the fruit_index is intentionally NOT updated, so the
    --    student's fruit stays where it is on the tree.
    select coalesce(max(s.fruit_index), 0) + 1
      into v_next_fruit_index
      from public.tree_submissions s
     where s.session_id = p_session_id;

    insert into public.tree_submissions (
        session_id, student_code, student_name, answer_text, word_count, fruit_index
    ) values (
        p_session_id, v_student_code, v_student_name, v_clean_text, v_word_count, v_next_fruit_index
    )
    on conflict (session_id, student_code) do update
        set answer_text  = excluded.answer_text,
            word_count   = excluded.word_count,
            student_name = excluded.student_name,
            submitted_at = now()
    returning id, fruit_index into v_submission_id, v_next_fruit_index;

    return jsonb_build_object(
        'success',       true,
        'submission_id', v_submission_id,
        'fruit_index',   v_next_fruit_index,
        'word_count',    v_word_count,
        'message',       'Đóng góp thành công! Cây tri thức đang phát triển thêm quả mới. 🌱🍎'
    );
end;
$$;

comment on function public.submit_tree_answer(uuid, varchar, varchar, text) is 'Phase 7.1: submit/update a student answer ("fruit") with min-word and trigram-similarity enforcement.';


-- ============================================================================
-- 7. EXECUTE GRANTS
-- ============================================================================
-- Student-facing write path -> anon. The similarity rules live INSIDE the body,
-- so a caller cannot skip them by calling the table directly.
revoke all on function public.submit_tree_answer(uuid, varchar, varchar, text) from public;
grant execute on function public.submit_tree_answer(uuid, varchar, varchar, text) to anon, authenticated;

-- The RLS helper is called from a policy, so `anon` needs EXECUTE on it — but it
-- must never be reachable as a general-purpose probe. It leaks only a boolean.
revoke all on function public.tree_session_is_public(uuid) from public;
grant execute on function public.tree_session_is_public(uuid) to anon, authenticated;


-- ============================================================================
-- 8. REALTIME PUBLICATION (D2)
-- ----------------------------------------------------------------------------
-- Realtime is how the tree grows live: every accepted fruit is broadcast to all
-- students in the session without polling. A table must be a member of the
-- `supabase_realtime` publication or Realtime delivers nothing for it.
--
-- `add table` raises 42710 when already a member, so guard it to stay re-runnable.
--
-- replica identity: the default is PRIMARY KEY, so an UPDATE record carries only
-- `id`. Clients filter events by `session_id` (a non-key column), and a filter
-- that cannot be evaluated against the record causes the event to be DROPPED.
-- Resubmissions are UPDATEs, so `full` is required or answer edits would never
-- reach the class. (Same reasoning as exam_results in Section D.2.)
-- ============================================================================
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tree_submissions'
    ) then
        alter publication supabase_realtime add table public.tree_submissions;
    end if;
end
$$;

alter table public.tree_submissions replica identity full;

commit;
