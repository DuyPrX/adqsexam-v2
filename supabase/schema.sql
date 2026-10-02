-- ============================================================================
-- ADQS EXAM v2 — SUPABASE DATA ARCHITECTURE (PHASE 1)
-- ----------------------------------------------------------------------------
-- Target : Supabase PostgreSQL (PG15+)
-- Scope  : 6 tables + multi-tenant RLS + atomic RPCs (server-authoritative).
-- Contract: v2/ARCHITECTURE_FREEZE.md  (F1-F5, D1-D4). v1 is READ-ONLY.
--
-- Invariants enforced here:
--   F1/F2/D1 -> Answer keys NEVER reach the student browser.
--               get_student_exam_payload() strips correct_answer / explanation
--               and every sub-question key. Students hold ZERO table privileges;
--               every student interaction is an RPC call.
--   F3       -> Scoring is executed ONLY inside submit_exam_result() (D1).
--               Rules mirror backend/.../ExamResultService.java:
--                 MCQ          : selectedIndex == correctIndex            -> 1.0
--                 TRUE_FALSE   : 4->1.0 | 3->0.5 | 2->0.25 | 1->0.1      -> else 0.0
--                 SHORT_ANSWER : trim + lower + ','->'.' exact match     -> 1.0
--                 ESSAY        : 0.0 auto + needs_grading = true
--                 score        : clamp(round(sum*100)/100, 0, total)
--   D2       -> Realtime replaces Firebase RTDB (postgres_changes / broadcast).
--   D3/D4    -> No server-side rendering, no portal sync (decommissioned in v1).
--
-- The script is idempotent (create or replace / drop policy if exists) and is
-- intended to be pasted verbatim into the Supabase SQL Editor.
-- ============================================================================

begin;

-- gen_random_uuid() (also in core PG13+, pgcrypto keeps older projects happy)
create extension if not exists pgcrypto;


-- ============================================================================
-- SECTION A — TABLES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A.1  exams — teacher-owned exam metadata (authoritative for metadata; the
--      student runtime reads the sanitized payload through an RPC, per F1).
-- ----------------------------------------------------------------------------
create table if not exists public.exams (
    id               uuid         primary key default gen_random_uuid(),
    user_id          uuid         not null references auth.users (id) on delete cascade,
    code             varchar(6)   not null unique,
    title            varchar(255) not null,
    duration_minutes integer      not null default 45,
    is_active        boolean      not null default true,
    -- Scheduling window (Phase 5.4). NULL = unbounded on that side.
    starts_at        timestamptz,
    ends_at          timestamptz,
    -- Soft-delete / Trash marker (Phase 5.5). NULL = live; otherwise the exam is
    -- in the Trash and is purgeable 7 days after this timestamp.
    deleted_at       timestamptz,
    created_at       timestamptz  not null default now()
);

-- Idempotency: databases created before Phase 5.4 lack the scheduling columns,
-- and `create table if not exists` would silently skip them.
alter table public.exams add column if not exists starts_at  timestamptz;
alter table public.exams add column if not exists ends_at    timestamptz;
alter table public.exams add column if not exists deleted_at timestamptz;

comment on table public.exams is 'Teacher-owned exam metadata. Multi-tenant via user_id + RLS.';

-- ----------------------------------------------------------------------------
-- A.2  question_bank — the question store for an exam.
--      `position` gives the deterministic 0-based ordering the student payload
--      uses as `questionIndex`; without it the mapping between a submitted
--      answer and its question would be non-deterministic and scoring unsafe.
--      `correct_answer` is JSONB so one column carries all shapes (F3 / D1):
--         MCQ          : bare number     e.g.  2
--         TRUE_FALSE   : ordered array   e.g.  ["Đ","S","Đ","S"]   (keys only)
--                         - the four sub-item STATEMENTS live in `options`
--                           (e.g. ["a) ...","b) ...","c) ...","d) ..."])
--         SHORT_ANSWER : bare string     e.g.  "1.5"
--         ESSAY        : null  (never auto-graded)
--
--      NULLABLE on purpose: an ESSAY (or an unresolved MCQ) has no key, and the
--      teacher client writes through PostgREST, where a JSON null becomes SQL
--      NULL. A NOT NULL constraint here would reject every such insert with
--      SQLSTATE 23502. Raw SQL could store 'null'::jsonb, but PostgREST cannot.
-- ----------------------------------------------------------------------------
create table if not exists public.question_bank (
    id              uuid        primary key default gen_random_uuid(),
    user_id         uuid        not null references auth.users (id) on delete cascade,
    exam_id         uuid        references public.exams (id) on delete cascade,
    question_text   text        not null,
    question_type   varchar(30) not null,
    options         jsonb       not null default '[]'::jsonb,
    correct_answer  jsonb,
    explanation     text,
    cognitive_level varchar(50),
    subject         varchar(100),
    chapter         varchar(100),
    position        integer     not null default 0,
    created_at      timestamptz not null default now()
);

comment on table public.question_bank is 'Exam question store. correct_answer is JSONB (scalar index/string or ordered Đ/S map).';

-- ----------------------------------------------------------------------------
-- A.3  students — per-exam whitelist (Student Code + Full Name + Class).
-- ----------------------------------------------------------------------------
create table if not exists public.students (
    id           uuid        primary key default gen_random_uuid(),
    student_code varchar(50) not null,
    full_name    varchar(150) not null,
    class_name   varchar(50) not null,
    exam_code    varchar(6)  not null references public.exams (code) on delete cascade,
    created_at   timestamptz not null default now(),
    constraint students_code_exam_uniq unique (student_code, exam_code)
);

comment on table public.students is 'Per-exam candidate whitelist used by verify_and_acquire_session().';

-- ----------------------------------------------------------------------------
-- A.4  active_sessions — single-device concurrency lock + live proctoring feed.
--      PK(student_code, exam_code) => at most one device per candidate/exam.
-- ----------------------------------------------------------------------------
create table if not exists public.active_sessions (
    student_code           varchar(50) not null,
    exam_code              varchar(6)  not null references public.exams (code) on delete cascade,
    session_token          uuid        not null,
    last_heartbeat         timestamptz not null default now(),
    current_question       integer     not null default 0,
    answered_count         integer     not null default 0,
    blur_count             integer     not null default 0,
    fullscreen_exit_count  integer     not null default 0,
    device_info            text,
    constraint active_sessions_pkey primary key (student_code, exam_code)
);

comment on table public.active_sessions is 'One live session per candidate/exam (20s heartbeat, 60s expiry). Reload extends via token match.';

-- ----------------------------------------------------------------------------
-- A.5  exam_results — server-scored submissions (client score is never trusted).
-- ----------------------------------------------------------------------------
create table if not exists public.exam_results (
    id                    uuid          primary key default gen_random_uuid(),
    exam_code             varchar(6)    not null references public.exams (code) on delete cascade,
    student_code          varchar(50)   not null,
    student_name          varchar(150)  not null,
    class_name            varchar(50)   not null,
    score                 numeric(5, 2) not null default 0,
    total_questions       integer       not null default 0,
    answers_json          jsonb         not null default '[]'::jsonb,
    blur_count            integer       not null default 0,
    fullscreen_exit_count integer       not null default 0,
    elapsed_seconds       integer       not null default 0,
    needs_grading         boolean       not null default false,
    submitted_at          timestamptz   not null default now(),
    constraint exam_results_code_student_uniq unique (exam_code, student_code)
);

comment on table public.exam_results is 'Immutable server-scored result. UNIQUE(exam_code, student_code) blocks duplicate submission.';

-- ----------------------------------------------------------------------------
-- A.6  proctoring_snapshots — append-only webcam captures (image lives in
--      Supabase Storage; this row only carries the URL).
-- ----------------------------------------------------------------------------
create table if not exists public.proctoring_snapshots (
    id           uuid        primary key default gen_random_uuid(),
    exam_code    varchar(6)  not null references public.exams (code) on delete cascade,
    student_code varchar(50) not null,
    image_url    text        not null,
    captured_at  timestamptz not null default now()
);

comment on table public.proctoring_snapshots is 'Append-only proctoring captures. Written via record_proctoring_snapshot(); read by the owning teacher.';


-- ============================================================================
-- SECTION A.7 — INDEXES
-- ============================================================================
create index if not exists idx_exams_user_id                 on public.exams (user_id);
create index if not exists idx_question_bank_exam_id         on public.question_bank (exam_id, position);
create index if not exists idx_question_bank_user_id         on public.question_bank (user_id);
create index if not exists idx_students_exam_code            on public.students (exam_code);
create index if not exists idx_active_sessions_exam_code     on public.active_sessions (exam_code);
create index if not exists idx_active_sessions_heartbeat     on public.active_sessions (last_heartbeat);
create index if not exists idx_exam_results_exam_code        on public.exam_results (exam_code);
create index if not exists idx_proctoring_snapshots_exam     on public.proctoring_snapshots (exam_code, student_code);


-- ============================================================================
-- SECTION B — ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Design:
--   * Teachers (role `authenticated`) reach only rows their auth.uid() owns.
--   * Students (role `anon`) get ZERO table privileges -> every student action
--     is forced through a SECURITY DEFINER RPC (requirement B / D1).
--   * service_role retains full access (used by server tooling/migrations).
-- ============================================================================
alter table public.exams                enable row level security;
alter table public.question_bank        enable row level security;
alter table public.students             enable row level security;
alter table public.active_sessions      enable row level security;
alter table public.exam_results         enable row level security;
alter table public.proctoring_snapshots enable row level security;

-- --- exams: full CRUD for the owning teacher ---------------------------------
drop policy if exists exams_owner_all on public.exams;
create policy exams_owner_all on public.exams
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- --- question_bank: full CRUD for the owning teacher -------------------------
drop policy if exists question_bank_owner_all on public.question_bank;
create policy question_bank_owner_all on public.question_bank
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- --- students: roster CRUD where the teacher owns the referenced exam --------
drop policy if exists students_teacher_all on public.students;
create policy students_teacher_all on public.students
    for all
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = students.exam_code and e.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.exams e
            where e.code = students.exam_code and e.user_id = auth.uid()
        )
    );

-- --- active_sessions: teacher reads the live proctoring feed -----------------
--     (writes only ever happen inside SECURITY DEFINER RPCs)
drop policy if exists active_sessions_teacher_read on public.active_sessions;
create policy active_sessions_teacher_read on public.active_sessions
    for select
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = active_sessions.exam_code and e.user_id = auth.uid()
        )
    );

-- --- exam_results: teacher reads, grades (essay) and deletes own results ------
drop policy if exists exam_results_teacher_read on public.exam_results;
create policy exam_results_teacher_read on public.exam_results
    for select
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = exam_results.exam_code and e.user_id = auth.uid()
        )
    );

drop policy if exists exam_results_teacher_update on public.exam_results;
create policy exam_results_teacher_update on public.exam_results
    for update
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = exam_results.exam_code and e.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.exams e
            where e.code = exam_results.exam_code and e.user_id = auth.uid()
        )
    );

drop policy if exists exam_results_teacher_delete on public.exam_results;
create policy exam_results_teacher_delete on public.exam_results
    for delete
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = exam_results.exam_code and e.user_id = auth.uid()
        )
    );

-- --- proctoring_snapshots: teacher reads own captures ------------------------
drop policy if exists proctoring_snapshots_teacher_read on public.proctoring_snapshots;
create policy proctoring_snapshots_teacher_read on public.proctoring_snapshots
    for select
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = proctoring_snapshots.exam_code and e.user_id = auth.uid()
        )
    );

-- --- Privilege hardening -----------------------------------------------------
-- Students (anon) must hold no direct table access whatsoever.
-- Supabase grants ALL on public tables to anon by default; revoke it.
revoke all on public.exams                from anon;
revoke all on public.question_bank        from anon;
revoke all on public.students             from anon;
revoke all on public.active_sessions      from anon;
revoke all on public.exam_results         from anon;
revoke all on public.proctoring_snapshots from anon;


-- ============================================================================
-- SECTION C — ATOMIC RPCs (SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Run as the function owner (postgres, which owns the tables) so RLS is
-- bypassed internally. search_path is pinned to defeat search_path hijacking.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C.1  verify_and_acquire_session
--      Whitelist verification + scheduling window + single-device lock + reload.
--      Returns: { success, session_token, message }
--        SESSION_ACQUIRED        -> brand new session
--        SESSION_RESUMED         -> same device reloaded (token matched)
--        SESSION_ACTIVE_ELSEWHERE-> another live device holds the lock
--        EXAM_INACTIVE           -> teacher closed the exam (is_active = false)
--        EXAM_NOT_STARTED        -> now() is before starts_at
--        EXAM_EXPIRED            -> now() is after ends_at
--        EXAM_NOT_FOUND          -> exam is in the Trash (deleted_at set) or gone
-- ----------------------------------------------------------------------------
create or replace function public.verify_and_acquire_session(
    p_exam_code      varchar,
    p_student_code   varchar,
    p_full_name      varchar,
    p_class_name     varchar,
    p_device_info    text    default null,
    p_existing_token uuid    default null
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
begin
    -- 1. Exam must exist and be open.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 1.0 Soft-deleted exams are indistinguishable from missing ones: the Trash
    --     is a teacher-only concept, and revealing it would leak that the code
    --     once existed. Same code as a genuine miss on purpose.
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- 1.a Teacher open/close switch.
    if v_exam.is_active is not true then
        return jsonb_build_object('success', false, 'message', 'EXAM_INACTIVE');
    end if;

    -- 1.b Scheduling window. A NULL bound means "unbounded on that side".
    if v_exam.starts_at is not null and now() < v_exam.starts_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_STARTED');
    end if;
    if v_exam.ends_at is not null and now() > v_exam.ends_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_EXPIRED');
    end if;

    -- 2. Candidate must be whitelisted for this exam.
    select * into v_student
      from public.students
     where exam_code = p_exam_code
       and student_code = p_student_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    -- 3. Identity must match the whitelist (case-insensitive, trimmed).
    if lower(trim(v_student.full_name)) <> lower(trim(coalesce(p_full_name, '')))
       or lower(trim(v_student.class_name)) <> lower(trim(coalesce(p_class_name, ''))) then
        return jsonb_build_object('success', false, 'message', 'IDENTITY_MISMATCH');
    end if;

    -- 4. One submission per candidate, ever.
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = p_student_code
    ) then
        return jsonb_build_object('success', false, 'message', 'ALREADY_SUBMITTED');
    end if;

    -- 5. Atomic single-device lock.
    --    FOR UPDATE serialises concurrent logins for the same candidate.
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = p_student_code
     for update;

    if found then
        if v_session.last_heartbeat > now() - interval '60 seconds' then
            -- Live session.
            if p_existing_token is not null and p_existing_token = v_session.session_token then
                -- Same device reloaded: extend rather than lock out (F5 tolerance).
                update public.active_sessions
                   set last_heartbeat = now(),
                       device_info    = coalesce(p_device_info, device_info)
                 where exam_code = p_exam_code
                   and student_code = p_student_code;
                return jsonb_build_object(
                    'success', true,
                    'session_token', v_session.session_token,
                    'message', 'SESSION_RESUMED'
                );
            end if;
            -- Foreign device while a session is alive -> reject.
            return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
        end if;

        -- Stale session (>60s silent): take it over, reset telemetry.
        update public.active_sessions
           set session_token         = v_new_token,
               last_heartbeat        = now(),
               current_question      = 0,
               answered_count        = 0,
               blur_count            = 0,
               fullscreen_exit_count = 0,
               device_info           = p_device_info
         where exam_code = p_exam_code
           and student_code = p_student_code;
        return jsonb_build_object(
            'success', true,
            'session_token', v_new_token,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

    -- No session row -> create one.
    insert into public.active_sessions (
        student_code, exam_code, session_token, last_heartbeat,
        current_question, answered_count, blur_count, fullscreen_exit_count, device_info
    ) values (
        p_student_code, p_exam_code, v_new_token, now(),
        0, 0, 0, 0, p_device_info
    );
    return jsonb_build_object(
        'success', true,
        'session_token', v_new_token,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
        -- Lost an insert race against a concurrent login.
        return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
end;
$$;


-- ----------------------------------------------------------------------------
-- C.2  record_student_heartbeat
--      20s pulse. A token mismatch means the session was taken over -> the
--      client is told INVALID_SESSION and evicted.
-- ----------------------------------------------------------------------------
create or replace function public.record_student_heartbeat(
    p_exam_code        varchar,
    p_student_code     varchar,
    p_session_token    uuid,
    p_current_q        integer default 0,
    p_answered_count   integer default 0,
    p_blur_count       integer default 0,
    p_fs_exit_count    integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.active_sessions
       set last_heartbeat        = now(),
           current_question      = coalesce(p_current_q, current_question),
           answered_count        = coalesce(p_answered_count, answered_count),
           blur_count            = coalesce(p_blur_count, blur_count),
           fullscreen_exit_count = coalesce(p_fs_exit_count, fullscreen_exit_count)
     where exam_code      = p_exam_code
       and student_code   = p_student_code
       and session_token  = p_session_token;

    if not found then
        return jsonb_build_object('success', false, 'message', 'INVALID_SESSION');
    end if;

    return jsonb_build_object('success', true, 'message', 'OK', 'server_time', now());
end;
$$;


-- ----------------------------------------------------------------------------
-- C.3  get_student_exam_payload
--      Validates the session and returns the SANITIZED question set.
--      Stripped: correct_answer, explanation, correctIndex, correctAnswer and
--      every sub-question key. Only option/sub-item CONTENT survives (D1/F2).
-- ----------------------------------------------------------------------------
create or replace function public.get_student_exam_payload(
    p_exam_code     varchar,
    p_session_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_session   public.active_sessions%rowtype;
    v_questions jsonb;
    v_total     integer;
begin
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and session_token = p_session_token;
    if not found then
        return jsonb_build_object('success', false, 'message', 'INVALID_SESSION');
    end if;
    if v_session.last_heartbeat < now() - interval '60 seconds' then
        return jsonb_build_object('success', false, 'message', 'SESSION_EXPIRED');
    end if;

    with ordered as (
        select q.*,
               (row_number() over (order by q.position, q.created_at, q.id) - 1) as idx
          from public.question_bank q
         where q.exam_id = v_exam.id
    )
    select
        coalesce(
            jsonb_agg(
                jsonb_strip_nulls(
                    jsonb_build_object(
                        'index',   o.idx,
                        'content', o.question_text,
                        'type',    o.question_type,
                        'options',
                            case when o.question_type = 'TRUE_FALSE'
                                 then '[]'::jsonb
                                 else o.options
                            end,
                        'subQuestions',
                            case when o.question_type = 'TRUE_FALSE' then (
                                select jsonb_agg(
                                           jsonb_build_object('content', e.value)
                                           order by e.ord
                                       )
                                  from jsonb_array_elements_text(o.options)
                                       with ordinality as e(value, ord)
                            ) end
                    )
                )
                order by o.idx
            ),
            '[]'::jsonb
        ),
        count(*)
      into v_questions, v_total
      from ordered o;

    return jsonb_build_object(
        'success', true,
        'exam', jsonb_build_object(
            'code',             v_exam.code,
            'title',            v_exam.title,
            'duration_minutes', v_exam.duration_minutes,
            'total_questions',  coalesce(v_total, 0)
        ),
        'questions', v_questions
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.4a  grade_exam_answers  (internal — helper for C.4 and C.8a)
--       The single authoritative implementation of the F3 scoring rules.
--
--       Both submit_exam_result (initial grading) and recalculate_exam_scores
--       (re-grading against edited keys) call this, so the Ministry-of-Education
--       scale can never drift between the two code paths.
--
--       `p_answers` is the raw client answer array (submit) OR a stored
--       `exam_results.answers_json` (re-grade) — both share the same keys:
--         { questionIndex, selectedIndex | selectedAnswers | selectedAnswerText }
--
--       Returns: { score, total, needs_grading, corrected }
-- ----------------------------------------------------------------------------
create or replace function public.grade_exam_answers(
    p_exam_id uuid,
    p_answers jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_q             public.question_bank%rowtype;
    v_ans           jsonb;
    v_idx           integer := 0;
    v_total         integer := 0;
    v_sum           numeric := 0;
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
    i               integer;
begin
    -- Walk the authoritative question order and grade each answer.
    for v_q in
        select * from public.question_bank q
         where q.exam_id = p_exam_id
         order by q.position, q.created_at, q.id
    loop
        v_type := upper(coalesce(v_q.question_type, ''));

        -- Locate the answer for this 0-based index (absent = unanswered).
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

    return jsonb_build_object(
        -- clamp(round(sum*100)/100, 0, total)
        'score',         greatest(0, least(v_total, round(v_sum * 100) / 100)),
        'total',         v_total,
        'needs_grading', v_needs_grading,
        'corrected',     v_corrected
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.4  submit_exam_result
--      Server-authoritative grading (F3). The client's claimed score is never
--      accepted; only raw answers are. Duplicate submission is rejected by the
--      UNIQUE(exam_code, student_code) constraint plus an explicit guard.
--      Scoring itself lives in grade_exam_answers (C.4a), shared with the
--      re-grading RPC so both always apply the same scale.
--      Returns: { success, message, result_id, score, total_questions, needs_grading }
--      `result_id` is the public certificate handle consumed by verify.html.
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

    -- 1a. A trashed exam accepts no further submissions.
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

    -- 6. Retire the session so the token can never be reused.
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


-- ----------------------------------------------------------------------------
-- C.5  record_proctoring_snapshot  (support RPC)
--      Required because students hold no table privileges (Section B): the
--      capture row must be written through a session-validated definer function.
-- ----------------------------------------------------------------------------
create or replace function public.record_proctoring_snapshot(
    p_exam_code     varchar,
    p_student_code  varchar,
    p_session_token uuid,
    p_image_url     text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not exists (
        select 1
          from public.active_sessions
         where exam_code      = p_exam_code
           and student_code   = p_student_code
           and session_token  = p_session_token
           and last_heartbeat > now() - interval '60 seconds'
    ) then
        return jsonb_build_object('success', false, 'message', 'INVALID_SESSION');
    end if;

    insert into public.proctoring_snapshots (exam_code, student_code, image_url)
    values (p_exam_code, p_student_code, p_image_url);

    return jsonb_build_object('success', true, 'message', 'SNAPSHOT_SAVED');
end;
$$;


-- ----------------------------------------------------------------------------
-- C.6  get_certificate_verification  (PUBLIC — anon)
--      Backs the standalone /verify.html page reached by scanning the QR code
--      printed on a certificate. It is deliberately read-only and discloses
--      only non-sensitive metadata (no answers, no answer keys, no token).
--
--      `valid` is true ONLY when the candidate actually passed:
--          total_questions > 0  AND  score / total_questions >= 0.8
--      Any unknown id — or an id whose result failed the threshold — returns
--      valid = false so the public page can render an "Invalid" badge without
--      leaking whether the UUID merely does not exist.
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


-- ----------------------------------------------------------------------------
-- C.7  verify_student_practice  (PUBLIC — anon, Phase 5.2)
--      Gate for AUTHORIZED SELF-PRACTICE. A candidate may practise with any
--      .docx of their own choosing as long as their (student_code, class_name)
--      pair appears in the whitelist of ANY exam roster ever imported — the
--      exam_code is deliberately NOT part of the match, because practice is
--      not tied to a published exam.
--
--      Matching is case- and whitespace-insensitive on both fields, mirroring
--      the tolerance of verify_and_acquire_session().
--
--      This is an authorization probe only: it writes nothing, reveals no
--      exam content, and returns the canonical full_name so the client can
--      greet the student. Practice exams are never persisted (no `exams`,
--      `question_bank`, `active_sessions` or `exam_results` rows are touched).
-- ----------------------------------------------------------------------------
create or replace function public.verify_student_practice(
    p_student_code varchar,
    p_class_name   varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exists       boolean;
    v_student_name varchar;
begin
    if p_student_code is null or trim(p_student_code) = ''
       or p_class_name is null or trim(p_class_name) = '' then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Vui lòng nhập đầy đủ Mã học sinh và Lớp.'
        );
    end if;

    select exists (
               select 1
                 from public.students s
                where lower(trim(s.student_code)) = lower(trim(p_student_code))
                  and lower(trim(s.class_name))   = lower(trim(p_class_name))
           ),
           max(s.full_name)
      into v_exists, v_student_name
      from public.students s
     where lower(trim(s.student_code)) = lower(trim(p_student_code))
       and lower(trim(s.class_name))   = lower(trim(p_class_name));

    if not v_exists then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Thông tin học sinh không có trong danh sách được phép ôn luyện.'
        );
    end if;

    return jsonb_build_object(
        'authorized',   true,
        'student_name', v_student_name
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.8  update_exam_questions_safe  (teacher — authenticated, Phase 5.4)
--      Post-creation question CRUD with an integrity guard.
--
--      Ownership is checked inside the function (auth.uid() = exams.user_id)
--      because SECURITY DEFINER bypasses RLS; the grant is `authenticated` only.
--
--      Behaviour depends on whether the exam has any submission:
--
--        * SUBMISSIONS EXIST -> immutable structure. A count change (=> a
--          deletion or an addition) or an ordered type change is rejected with
--          STRUCTURAL_CHANGE_BLOCKED. Only in-place content edits are applied
--          (question_text / options / correct_answer / explanation) so already
--          scored answers keep pointing at the same question.
--
--        * ZERO SUBMISSIONS  -> safe to rewrite the whole bank: the existing
--          rows are deleted and the incoming array is re-inserted with a clean
--          contiguous 1-based `position`.
--
--      p_questions shape (array):
--        [{ position?, question_type, question_text, options,
--           correct_answer?, explanation? }, ...]
-- ----------------------------------------------------------------------------
create or replace function public.update_exam_questions_safe(
    p_exam_code varchar,
    p_questions jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id     uuid;
    v_owner       uuid;
    v_submissions integer;
    v_existing    integer;
    v_incoming    integer;
    v_item        jsonb;
    v_idx         integer := 0;
    v_exists_type text;
    v_in_type     text;
    i             integer;
begin
    -- 0. Payload must be a JSON array.
    if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
        return jsonb_build_object('success', false, 'message', 'INVALID_PAYLOAD');
    end if;
    v_incoming := jsonb_array_length(p_questions);

    -- 1. Exam must exist and belong to the caller.
    select e.id, e.user_id into v_exam_id, v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    -- 2. Has this exam been submitted to?
    select count(*) into v_submissions
      from public.exam_results r
     where r.exam_code = p_exam_code;

    if v_submissions > 0 then
        select count(*) into v_existing
          from public.question_bank q
         where q.exam_id = v_exam_id;

        -- Structural guard: the question count must not change.
        if v_existing <> v_incoming then
            return jsonb_build_object(
                'success', false,
                'message', 'STRUCTURAL_CHANGE_BLOCKED',
                'detail',  'Đề thi đã có lượt nộp bài, chỉ có thể sửa nội dung câu hỏi.'
            );
        end if;

        -- Structural guard: every ordered position must exist with the same type.
        -- Validate ALL positions BEFORE applying any update, so a mismatch at the
        -- last index cannot leave earlier rows already modified (a plpgsql
        -- `return` does not roll back the transaction).
        for i in 0 .. v_incoming - 1 loop
            v_item    := p_questions -> i;
            v_in_type := upper(coalesce(v_item ->> 'question_type', ''));

            select upper(q.question_type) into v_exists_type
              from public.question_bank q
             where q.exam_id = v_exam_id
               and q.position = i + 1;
            if not found or v_exists_type <> v_in_type then
                return jsonb_build_object(
                    'success', false,
                    'message', 'STRUCTURAL_CHANGE_BLOCKED',
                    'detail',  'Đề thi đã có lượt nộp bài, chỉ có thể sửa nội dung câu hỏi.'
                );
            end if;
        end loop;

        -- Apply pass: structure is proven intact, so only content is touched.
        for i in 0 .. v_incoming - 1 loop
            v_item := p_questions -> i;

            update public.question_bank q
               set question_text  = coalesce(v_item ->> 'question_text', q.question_text),
                   options        = coalesce(v_item -> 'options', q.options),
                   correct_answer = nullif(v_item -> 'correct_answer', 'null'::jsonb),
                   explanation    = v_item ->> 'explanation'
             where q.exam_id = v_exam_id
               and q.position = i + 1;
        end loop;

        return jsonb_build_object(
            'success',     true,
            'message',     'CONTENT_UPDATED',
            'updated',     v_incoming,
            'submissions', v_submissions
        );
    end if;

    -- 3. Zero submissions -> full rewrite with contiguous 1-based positions.
    delete from public.question_bank q where q.exam_id = v_exam_id;

    for i in 0 .. v_incoming - 1 loop
        v_item := p_questions -> i;
        v_idx  := v_idx + 1;

        insert into public.question_bank (
            user_id, exam_id, question_text, question_type,
            options, correct_answer, explanation, position
        ) values (
            v_owner,
            v_exam_id,
            coalesce(v_item ->> 'question_text', ''),
            upper(coalesce(v_item ->> 'question_type', 'MULTIPLE_CHOICE')),
            coalesce(v_item -> 'options', '[]'::jsonb),
            -- `->` yields JSONB 'null' for an explicit JSON null; nullif maps it
            -- back to SQL NULL so the column matches the PostgREST saveExam path
            -- (JS null -> SQL NULL). `#>> '{}'` on JSONB 'null' would be 'null',
            -- which would corrupt the SHORT_ANSWER comparison in submit_exam_result.
            nullif(v_item -> 'correct_answer', 'null'::jsonb),
            v_item ->> 'explanation',
            v_idx
        );
    end loop;

    return jsonb_build_object(
        'success',     true,
        'message',     'REPLACED',
        'inserted',    v_incoming,
        'submissions', 0
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.9  delete_exam  (teacher — authenticated, Phase 5.5)
--      Two-tier deletion driven by whether any submission exists.
--
--        * 0 submissions  -> HARD DELETE. The exam carries no graded history, so
--          every dependent row (active_sessions, students, question_bank, and
--          the exam itself) is removed outright. FKs are `on delete cascade`,
--          but the children are deleted explicitly so the intent is auditable.
--
--        * > 0 submissions -> SOFT DELETE. Flipping `deleted_at` preserves the
--          results for the 7-day retention window; `is_active` is forced false
--          so the exam cannot be entered while it sits in the Trash.
--
--      Ownership is checked inside the body (SECURITY DEFINER bypasses RLS).
--      Returns: { success, action, message, purge_at? }
-- ----------------------------------------------------------------------------
create or replace function public.delete_exam(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id     uuid;
    v_owner       uuid;
    v_deleted_at  timestamptz;
    v_submissions integer;
begin
    select e.id, e.user_id, e.deleted_at
      into v_exam_id, v_owner, v_deleted_at
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    -- Already trashed: deleting again is a no-op rather than a data hazard.
    if v_deleted_at is not null then
        return jsonb_build_object(
            'success', true,
            'action',  'already_deleted',
            'message', 'Đề thi đã nằm trong thùng rác.'
        );
    end if;

    select count(*) into v_submissions
      from public.exam_results r
     where r.exam_code = p_exam_code;

    if v_submissions > 0 then
        update public.exams
           set deleted_at = now(),
               is_active  = false
         where code = p_exam_code;

        return jsonb_build_object(
            'success',  true,
            'action',   'soft_deleted',
            'purge_at', now() + interval '7 days',
            'message',  'Đề thi đã có kết quả. Đã chuyển vào thùng rác (tự động xóa sau 7 ngày).'
        );
    end if;

    -- Hard delete: children first, then the exam. proctoring_snapshots can hold
    -- rows for a candidate who captured a webcam frame but never submitted, so
    -- it is cleared explicitly rather than left to the cascade.
    delete from public.active_sessions      s where s.exam_code = p_exam_code;
    delete from public.students             s where s.exam_code = p_exam_code;
    delete from public.question_bank        q where q.exam_id   = v_exam_id;
    delete from public.exam_results         r where r.exam_code = p_exam_code;
    delete from public.proctoring_snapshots p where p.exam_code = p_exam_code;
    delete from public.exams                e where e.id        = v_exam_id;

    return jsonb_build_object(
        'success', true,
        'action',  'hard_deleted',
        'message', 'Đã xóa hoàn toàn đề thi và câu hỏi.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.10  restore_exam  (teacher — authenticated, Phase 5.5)
--       Clears the Trash marker. `is_active` is deliberately left false: a
--       restored exam must be re-opened by the teacher on purpose, otherwise
--       students could walk into an exam that was pulled mid-session.
-- ----------------------------------------------------------------------------
create or replace function public.restore_exam(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_owner uuid;
begin
    select e.user_id into v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    update public.exams
       set deleted_at = null
     where code = p_exam_code;

    return jsonb_build_object(
        'success', true,
        'message', 'Đã khôi phục đề thi từ thùng rác.'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.11  purge_expired_exams  (maintenance, Phase 5.5; log retention Phase 5.7)
--       Hard-deletes every exam whose 7-day Trash window has elapsed. This is a
--       global sweep, not an owner-scoped action: it only ever touches rows that
--       are already scheduled for destruction, so triggering it early cannot
--       destroy anything a teacher did not already delete. Cascades take the
--       dependent results / students / questions with it.
--
--       Also trims pg_cron's run history (30 days) so that the daily schedule
--       installed in Section D.3 cannot grow cron.job_run_details without bound
--       — pg_cron never prunes that table itself.
--
--       The prune is guarded rather than assumed: this function must stay
--       creatable and callable on a database where pg_cron was never installed
--       (plpgsql plans statements lazily, so the guarded DELETE is not even
--       resolved when the guard is false).
--
--       RLS note: cron.job_run_details is RLS-enabled (policy
--       `username = CURRENT_USER`). SECURITY DEFINER here runs as `postgres`,
--       which holds BYPASSRLS, so the DELETE is not row-filtered. If ownership
--       ever moved to a role without BYPASSRLS the prune would silently no-op.
-- ----------------------------------------------------------------------------
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

    -- Prune pg_cron's own run history (retain 30 days).
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


-- ----------------------------------------------------------------------------
-- C.12  recalculate_exam_scores  (teacher — authenticated, Phase 5.5)
--       Re-grades every submission of an exam against the CURRENT question_bank
--       keys, which matters after a teacher edits an answer key (C.8 allows
--       content edits even once submissions exist).
--
--       Scoring is delegated to grade_exam_answers (C.4a) — the same function
--       used at submit time — so a re-grade can never apply a different scale
--       than the original grading.
--
--       `answers_json` is exactly the shape grade_exam_answers consumes
--       (questionIndex + selectedIndex/selectedAnswers/selectedAnswerText), so
--       the stored answers are replayed verbatim.
--
--       Returns: { success, updated_count, message }
-- ----------------------------------------------------------------------------
create or replace function public.recalculate_exam_scores(p_exam_code varchar)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id uuid;
    v_owner   uuid;
    v_result  public.exam_results%rowtype;
    v_grade   jsonb;
    v_updated integer := 0;
begin
    select e.id, e.user_id into v_exam_id, v_owner
      from public.exams e
     where e.code = p_exam_code;
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;
    if auth.uid() is null or auth.uid() <> v_owner then
        return jsonb_build_object('success', false, 'message', 'NOT_AUTHORIZED');
    end if;

    for v_result in
        select * from public.exam_results r
         where r.exam_code = p_exam_code
         order by r.submitted_at, r.id
    loop
        v_grade := public.grade_exam_answers(v_exam_id, v_result.answers_json);

        update public.exam_results r
           set score           = (v_grade ->> 'score')::numeric,
               total_questions = (v_grade ->> 'total')::int,
               answers_json    = v_grade -> 'corrected',
               needs_grading   = (v_grade ->> 'needs_grading')::boolean
         where r.id = v_result.id;

        v_updated := v_updated + 1;
    end loop;

    return jsonb_build_object(
        'success',       true,
        'updated_count', v_updated,
        'message',       'Đã chấm lại toàn bộ bài thi theo đáp án mới nhất.'
    );
end;
$$;


-- ============================================================================
-- SECTION D — EXECUTE GRANTS
-- ----------------------------------------------------------------------------
-- RPCs are the ONLY surface exposed to students (anon). Tables stay revoked.
-- ============================================================================
revoke all on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid)   from public;
revoke all on function public.record_student_heartbeat(varchar, varchar, uuid, integer, integer, integer, integer) from public;
revoke all on function public.get_student_exam_payload(varchar, uuid)                                      from public;
revoke all on function public.submit_exam_result(varchar, varchar, uuid, jsonb, jsonb)                     from public;
revoke all on function public.record_proctoring_snapshot(varchar, varchar, uuid, text)                     from public;
revoke all on function public.get_certificate_verification(uuid)                                          from public;
revoke all on function public.verify_student_practice(varchar, varchar)                                    from public;
revoke all on function public.update_exam_questions_safe(varchar, jsonb)                                   from public;
revoke all on function public.grade_exam_answers(uuid, jsonb)                                              from public;
revoke all on function public.delete_exam(varchar)                                                         from public;
revoke all on function public.restore_exam(varchar)                                                        from public;
revoke all on function public.purge_expired_exams()                                                        from public;
revoke all on function public.recalculate_exam_scores(varchar)                                             from public;

grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid)   to anon, authenticated;
grant execute on function public.record_student_heartbeat(varchar, varchar, uuid, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.get_student_exam_payload(varchar, uuid)                                      to anon, authenticated;
grant execute on function public.submit_exam_result(varchar, varchar, uuid, jsonb, jsonb)                     to anon, authenticated;
grant execute on function public.record_proctoring_snapshot(varchar, varchar, uuid, text)                     to anon, authenticated;
grant execute on function public.get_certificate_verification(uuid)                                           to anon, authenticated;
grant execute on function public.verify_student_practice(varchar, varchar)                                     to anon, authenticated;
-- Teacher-only: never exposed to anon (ownership is enforced inside the body).
grant execute on function public.update_exam_questions_safe(varchar, jsonb)                                    to authenticated;
grant execute on function public.delete_exam(varchar)                                                          to authenticated;
grant execute on function public.restore_exam(varchar)                                                         to authenticated;
grant execute on function public.purge_expired_exams()                                                         to authenticated;
grant execute on function public.recalculate_exam_scores(varchar)                                              to authenticated;
-- Internal helper: called only from other SECURITY DEFINER functions, never
-- directly by a client (no EXECUTE grant to anon/authenticated).


-- ============================================================================
-- SECTION D.2 — REALTIME PUBLICATION (D2)
-- ----------------------------------------------------------------------------
-- A table must belong to the `supabase_realtime` publication or Realtime
-- delivers NOTHING for it, even though [realtime] is enabled. Supabase creates
-- the publication empty, and the SQL Editor does not add tables automatically,
-- so the teacher live monitor would silently never receive an event if this
-- section were omitted.
--
--   exam_results    -> live scoreboard (INSERT on submit, UPDATE on grading)
--   active_sessions -> live proctoring feed (INSERT/UPDATE on heartbeat)
--
-- `add table` raises 42710 when the table is already a member, so guard it to
-- keep the script re-runnable.
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

-- Realtime evaluates a `filter` against the row in the WAL record. With the
-- default replica identity an UPDATE/DELETE record carries only the primary
-- key, so a filter on a non-key column (`exam_code`) cannot match and the
-- event is dropped. `exam_results` is keyed on `id`, so its exam_code filter
-- needs the full old row. `active_sessions` keeps exam_code inside its
-- composite primary key and therefore needs no change.
alter table public.exam_results replica identity full;


-- ============================================================================
-- SECTION D.3 — SCHEDULED TRASH PURGE (pg_cron)
-- ----------------------------------------------------------------------------
-- purge_expired_exams() (C.11) is the mechanism behind the "tự động xóa sau 7
-- ngày" promise in delete_exam()'s soft-delete message. Until this section
-- existed, nothing ever called it — the Trash simply grew forever.
--
-- Scheduling lives IN the database rather than in a Worker/Edge Function:
--   * no additional component to deploy, warm, or authorize;
--   * no outbound network path, so zero Cloudflare request-quota cost;
--   * it runs in the same transaction domain as the rows it deletes.
--
-- 0 3 * * * → 03:00 UTC daily → 10:00 giờ Việt Nam (UTC+7).
--
-- `cron.schedule(job_name, ...)` upserts on job_name (verified on pg_cron
-- 1.6.4), so re-running this script replaces the job in place and keeps its
-- jobid. No prior cron.unschedule() is needed — and it would be actively
-- harmful to call unconditionally, since unscheduling an unknown name raises
-- "could not find valid entry for job".
--
-- Deploy note (Supabase free tier): a paused project runs no background
-- workers, so this job is suspended along with the database. The schedule
-- definition survives, and the next wake-up resumes the normal cadence without
-- reconfiguration. The Teacher Web Trash view performs a lazy purge on read
-- (see listTrashedExams), which covers the gap between wake-up and the next
-- 03:00 run.
-- ============================================================================
create extension if not exists pg_cron;

select cron.schedule(
    'purge-expired-exams-daily',
    '0 3 * * *',
    'select public.purge_expired_exams()'
);

commit;


-- ============================================================================
-- SECTION E — VERIFICATION EXAMPLES
-- ----------------------------------------------------------------------------
-- Run these in the Supabase SQL Editor AFTER seeding a test exam. They are
-- commented out so that the DDL above executes cleanly as a single script.
--
-- Seed (as postgres, bypassing RLS; replace :teacher_uid with a real
-- auth.users.id from Authentication > Users):
--
--   insert into public.exams (user_id, code, title, duration_minutes)
--   values (:'teacher_uid', 'ABC123', 'Kiểm tra 45 phút', 45);
--
--   insert into public.question_bank
--       (user_id, exam_id, question_text, question_type, options, correct_answer, position)
--   values
--     (:'teacher_uid', (select id from public.exams where code='ABC123'),
--      'Thủ đô của Việt Nam là gì?', 'MCQ',
--      '["Hà Nội","Huế","Đà Nẵng","TP.HCM"]'::jsonb, '0'::jsonb, 0),
--     (:'teacher_uid', (select id from public.exams where code='ABC123'),
--      'Đúng hay Sai?', 'TRUE_FALSE',
--      '["a) 2+2=4","b) 3>5","c) Trái Đất tròn","d) 1=2"]'::jsonb,
--      '["Đ","S","Đ","S"]'::jsonb, 1),
--     (:'teacher_uid', (select id from public.exams where code='ABC123'),
--      'Tính 1,5 + 1,5 = ?', 'SHORT_ANSWER',
--      '[]'::jsonb, '"3"'::jsonb, 2),
--     (:'teacher_uid', (select id from public.exams where code='ABC123'),
--      'Trình bày cảm nhận của em về quê hương.', 'ESSAY',
--      '[]'::jsonb, null, 3);
--
--   insert into public.students (student_code, full_name, class_name, exam_code)
--   values ('HS001', 'Nguyễn Văn A', '12A1', 'ABC123');
--
-- -- (1) Acquire a session (as anon client):
--   select public.verify_and_acquire_session(
--            'ABC123', 'HS001', 'Nguyễn Văn A', '12A1',
--            'Chrome/Windows', null);
--   -- -> {"success": true, "session_token": "<uuid>", "message": "SESSION_ACQUIRED"}
--
-- -- Reload tolerance: replay with the SAME token returns SESSION_RESUMED.
-- -- Foreign device (different token) while live returns SESSION_ACTIVE_ELSEWHERE.
--
-- -- (2) Sanitized payload — assert NO answer keys leak:
--   select public.get_student_exam_payload('ABC123', '<session_token>'::uuid);
--   -- Expect: questions[].type / .content / .options / .subQuestions[].content
--   --         and ABSENCE of correct_answer / correctIndex / explanation.
--   -- Negative check (should return 0):
--   select count(*)
--     from jsonb_path_query_array(
--              public.get_student_exam_payload('ABC123', '<session_token>'::uuid) -> 'questions',
--              '$[*].correctIndex') as x;
--
-- -- (3) Heartbeat:
--   select public.record_student_heartbeat('ABC123', 'HS001', '<session_token>'::uuid, 1, 1, 0, 0);
--   -- -> {"success": true, "message": "OK", "server_time": "..."}
--
-- -- (4) Submit — server-side scoring (MCQ correct, 4/4 T/F, SHORT correct, ESSAY):
--   select public.submit_exam_result(
--            'ABC123', 'HS001', '<session_token>'::uuid,
--            '[{"questionIndex":0,"selectedIndex":0},
--              {"questionIndex":1,"selectedAnswers":["Đ","S","Đ","S"]},
--              {"questionIndex":2,"selectedAnswerText":"3"},
--              {"questionIndex":3,"selectedAnswerText":"Quê hương em rất đẹp."}]'::jsonb,
--            '{"blurCount":2,"fullscreenExitCount":0,"elapsedSeconds":1720}'::jsonb);
--   -- Expected: score = 1.0 (MCQ) + 1.0 (4/4 T/F) + 1.0 (SHORT) + 0.0 (ESSAY)
--   --           = 3.00 ; total_questions = 4 ; needs_grading = true
--
-- -- (5) Duplicate submission is rejected:
--   select public.submit_exam_result('ABC123', 'HS001', '<session_token>'::uuid, '[]'::jsonb, '{}'::jsonb);
--   -- -> {"success": false, "message": "INVALID_SESSION"}  (session was purged)
--
-- -- (6) Teacher read-back (run as an authenticated teacher with the matching uid):
--   select student_name, student_code, score, total_questions, needs_grading
--     from public.exam_results where exam_code = 'ABC123';
-- ============================================================================
