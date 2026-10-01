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
    created_at       timestamptz  not null default now()
);

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
--      Whitelist verification + single-device lock + reload tolerance.
--      Returns: { success, session_token, message }
--        SESSION_ACQUIRED        -> brand new session
--        SESSION_RESUMED         -> same device reloaded (token matched)
--        SESSION_ACTIVE_ELSEWHERE-> another live device holds the lock
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
    if v_exam.is_active is not true then
        return jsonb_build_object('success', false, 'message', 'EXAM_CLOSED');
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
-- C.4  submit_exam_result
--      Server-authoritative grading (F3). The client's claimed score is never
--      accepted; only raw answers are. Duplicate submission is rejected by the
--      UNIQUE(exam_code, student_code) constraint plus an explicit guard.
--      Returns: { success, message, score, total_questions, needs_grading }
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
    v_exam          public.exams%rowtype;
    v_student       public.students%rowtype;
    v_session       public.active_sessions%rowtype;
    v_q             public.question_bank%rowtype;
    v_ans           jsonb;
    v_idx           integer := 0;
    v_total         integer := 0;
    v_sum           numeric := 0;
    v_score         numeric := 0;
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
    -- 1. Exam.
    select * into v_exam from public.exams where code = p_exam_code;
    if not found then
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

    -- 4. Walk the authoritative question order and grade each answer.
    for v_q in
        select * from public.question_bank q
         where q.exam_id = v_exam.id
         order by q.position, q.created_at, q.id
    loop
        v_type := upper(coalesce(v_q.question_type, ''));

        -- Locate the client answer for this 0-based index (absent = unanswered).
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

    -- 5. Aggregate: clamp(round(sum*100)/100, 0, total).
    v_score := greatest(0, least(v_total, round(v_sum * 100) / 100));

    insert into public.exam_results (
        exam_code, student_code, student_name, class_name,
        score, total_questions, answers_json,
        blur_count, fullscreen_exit_count, elapsed_seconds, needs_grading
    ) values (
        p_exam_code, p_student_code,
        coalesce(v_student.full_name, ''), coalesce(v_student.class_name, ''),
        v_score, v_total, v_corrected,
        coalesce(nullif(regexp_replace(p_metrics ->> 'blurCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'fullscreenExitCount', '\D', '', 'g'), '')::int, 0),
        coalesce(nullif(regexp_replace(p_metrics ->> 'elapsedSeconds', '\D', '', 'g'), '')::int, 0),
        v_needs_grading
    );

    -- 6. Retire the session so the token can never be reused.
    delete from public.active_sessions
     where exam_code = p_exam_code and student_code = p_student_code;

    return jsonb_build_object(
        'success',         true,
        'message',         'SUBMITTED',
        'score',           v_score,
        'total_questions', v_total,
        'needs_grading',   v_needs_grading
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

grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid)   to anon, authenticated;
grant execute on function public.record_student_heartbeat(varchar, varchar, uuid, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.get_student_exam_payload(varchar, uuid)                                      to anon, authenticated;
grant execute on function public.submit_exam_result(varchar, varchar, uuid, jsonb, jsonb)                     to anon, authenticated;
grant execute on function public.record_proctoring_snapshot(varchar, varchar, uuid, text)                     to anon, authenticated;

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
