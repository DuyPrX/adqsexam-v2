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

-- Phase 7.1 — trigram similarity for the Tree of Knowledge de-duplication.
-- Installed into `extensions` (Supabase's convention; pgcrypto is already there)
-- and RELOCATED unconditionally, because `create extension if not exists` is a
-- no-op when a prior script already installed it into another schema. Every call
-- site below is schema-qualified (`extensions.similarity`, `extensions.gin_trgm_ops`),
-- since the RPCs pin `search_path = public, pg_temp` and would not otherwise
-- resolve the extension's objects.
create extension if not exists pg_trgm with schema extensions;
alter extension pg_trgm set schema extensions;


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
    -- Practice opt-in (Phase 5.8). Default FALSE so an exam created for an
    -- official sitting never hands its answer keys to the student runtime; the
    -- teacher must explicitly enable practice.
    allow_practice   boolean      not null default false,
    -- PIN policy (Phase 6.1): NONE | GLOBAL | INDIVIDUAL.
    -- INDIVIDUAL is the default because it is the strict mode; it still degrades
    -- to "pass" for a roster carrying neither pin nor dob, so pre-existing exams
    -- keep working. See verify_and_acquire_session() step 3.b.
    pin_mode         varchar(20)  not null default 'INDIVIDUAL',
    -- Shared PIN, used only when pin_mode = 'GLOBAL'.
    global_pin       varchar(50),
    -- Phase 8.7 — per-exam paper-ordering policy. TRUE means the student runtime
    -- may reorder questions (with all TRUE_FALSE items grouped at the end);
    -- FALSE means the authored `position` order is preserved verbatim.
    shuffle_questions boolean     not null default true,
    -- Phase 11.0 / 11.1 Anti-cheat policy
    security_config  jsonb        not null default '{
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
    }'::jsonb,
    created_at       timestamptz  not null default now()
);

-- Idempotency: databases created before Phase 5.4 lack the scheduling columns,
-- and `create table if not exists` would silently skip them.
alter table public.exams add column if not exists starts_at  timestamptz;
alter table public.exams add column if not exists ends_at    timestamptz;
alter table public.exams add column if not exists deleted_at timestamptz;
-- NOT NULL DEFAULT false is load-bearing: an exam that predates this column must
-- stay locked down rather than silently becoming practiceable.
alter table public.exams add column if not exists allow_practice boolean not null default false;
-- Phase 6.1 PIN policy. NOT NULL DEFAULT 'INDIVIDUAL' is load-bearing for the
-- same reason: a NULL pin_mode would make the branch logic in
-- verify_and_acquire_session() fall through to "no verification at all".
alter table public.exams add column if not exists pin_mode   varchar(20) not null default 'INDIVIDUAL';
alter table public.exams add column if not exists global_pin varchar(50);
-- Phase 8.7 shuffle policy. NOT NULL DEFAULT true backfills existing rows in one
-- pass (no NULL window) and preserves the shipped "always shuffled" behaviour;
-- the client treats only an explicit false as "keep the authored order".
alter table public.exams add column if not exists shuffle_questions boolean not null default true;
-- Phase 11.0 / 11.1 / 11.2 Anti-cheat security config policy.
alter table public.exams add column if not exists security_config jsonb not null default '{
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
-- Ensure existing column default is updated
alter table public.exams alter column security_config set default '{
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
-- `add constraint` is not re-runnable, so drop before adding.
alter table public.exams drop constraint if exists chk_pin_mode;
alter table public.exams add constraint chk_pin_mode
    check (pin_mode in ('NONE', 'GLOBAL', 'INDIVIDUAL'));

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
    -- PIN secret (Phase 6.1). `pin` wins; `dob` is the DDMM fallback; both NULL
    -- keeps a legacy row working (no PIN required) under pin_mode = INDIVIDUAL.
    dob          date,
    pin          varchar(50),
    created_at   timestamptz not null default now(),
    -- Phase 8.4 — competition team (Tổ) 1..4, carried over from the class roster.
    team_number  smallint    not null default 1 check (team_number between 1 and 4),
    constraint students_code_exam_uniq unique (student_code, exam_code)
);

-- Idempotency for databases created before Phase 6.1 / 8.4.
alter table public.students add column if not exists dob date;
alter table public.students add column if not exists pin varchar(50);
alter table public.students add column if not exists team_number smallint not null default 1 check (team_number between 1 and 4);

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
-- A.4.1 exam_sessions — durable per-student timing and session completion state.
-- ----------------------------------------------------------------------------
create table if not exists public.exam_sessions (
    id           uuid        primary key default gen_random_uuid(),
    exam_id      uuid        not null references public.exams(id) on delete cascade,
    exam_code    varchar(10) not null,
    student_code varchar(50) not null,
    started_at   timestamptz not null default now(),
    ends_at      timestamptz not null,
    is_completed boolean     not null default false,
    submitted_at timestamptz,
    created_at   timestamptz not null default now(),
    constraint exam_sessions_exam_student_key unique (exam_id, student_code)
);

create index if not exists idx_exam_sessions_exam_student on public.exam_sessions(exam_id, student_code);
create index if not exists idx_exam_sessions_exam_code on public.exam_sessions(exam_code, student_code);

alter table public.exam_sessions enable row level security;

drop policy if exists "Teachers can read their exam sessions" on public.exam_sessions;
drop policy if exists "Teachers can manage their exam sessions" on public.exam_sessions;
create policy "Teachers can manage their exam sessions"
on public.exam_sessions for all
to authenticated
using (
    exists (
        select 1 from public.exams e
        where e.id = exam_sessions.exam_id and e.user_id = auth.uid()
    )
)
with check (
    exists (
        select 1 from public.exams e
        where e.id = exam_sessions.exam_id and e.user_id = auth.uid()
    )
);

comment on table public.exam_sessions is 'Durable anchored session record storing started_at, ends_at, and is_completed.';


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

-- ----------------------------------------------------------------------------
-- A.7  classes — teacher-owned roster container, independent of any exam
--      (Phase 6.1). A class is maintained once and imported into as many exams
--      as needed via import_class_to_exam().
-- ----------------------------------------------------------------------------
create table if not exists public.classes (
    id            uuid         primary key default gen_random_uuid(),
    user_id       uuid         not null references auth.users (id) on delete cascade,
    name          varchar(100) not null,
    academic_year varchar(20)  default '2026-2027',
    -- Phase 8.9 — teacher switch gating personal-.docx self-practice for this
    -- class. Read by the public verify_student_practice() below.
    allow_practice boolean     not null default true,
    created_at    timestamptz  default now(),
    updated_at    timestamptz  default now(),
    constraint classes_user_name_uniq unique (user_id, name)
);

comment on table public.classes is 'Teacher-owned class roster container (Phase 6.1). Imported into exams via import_class_to_exam().';

-- Idempotency for databases created before Phase 8.9. `not null default true`
-- backfills in a single pass, so no row is ever NULL for a column the public
-- gate tests with `IF NOT allow_practice`.
alter table public.classes add column if not exists allow_practice boolean not null default true;
create index if not exists idx_classes_allow_practice on public.classes (allow_practice);

comment on column public.classes.allow_practice is 'Teacher switch: may this class self-practise with a personal .docx (Phase 8.9)? Default true.';

-- ----------------------------------------------------------------------------
-- A.8  class_members — the students belonging to a class (Phase 6.1).
--      `pin` NULL -> DOB (DDMM) fallback; both NULL -> no PIN required.
-- ----------------------------------------------------------------------------
create table if not exists public.class_members (
    id           uuid         primary key default gen_random_uuid(),
    class_id     uuid         not null references public.classes (id) on delete cascade,
    student_code varchar(50)  not null,
    full_name    varchar(100) not null,
    dob          date,
    pin          varchar(50),
    created_at   timestamptz  default now(),
    -- Phase 8.4 — competition team (Tổ) 1..4 for the Tree of Knowledge arena.
    team_number  smallint     not null default 1 check (team_number between 1 and 4),
    -- Phase 8.11 — classroom group (Tổ/Nhóm) 1..8 for seat-work. Deliberately
    -- INDEPENDENT of team_number above: the arena caps at 4 and reads this row's
    -- team, so re-shuffling seat groups must not re-partition the arena's trees.
    group_number smallint     not null default 1 check (group_number between 1 and 8),
    constraint class_members_class_code_uniq unique (class_id, student_code)
);

-- Idempotency for databases created before Phase 8.4. The column's inline CHECK
-- is created only when the column itself is added, so a fresh database (which
-- already got it above) does not end up with two identical constraints.
alter table public.class_members add column if not exists team_number smallint not null default 1 check (team_number between 1 and 4);

-- Idempotency for databases created before Phase 8.11, same rule: the whole
-- statement (inline CHECK included) is skipped when the column already exists.
alter table public.class_members add column if not exists group_number smallint not null default 1 check (group_number between 1 and 8);

create index if not exists idx_class_members_group on public.class_members (class_id, group_number);

comment on table public.class_members is 'Roster rows for a class. `pin` NULL -> DOB (DDMM) fallback; both NULL -> no PIN required.';
comment on column public.class_members.team_number is 'Competition team (Tổ) 1..4 for the Tree of Knowledge arena (Phase 8.4).';
comment on column public.class_members.group_number is 'Classroom group (Tổ/Nhóm) 1..8 for seat-work, independent of the Phase 8.4 arena team_number (1..4). (Phase 8.11)';

-- ----------------------------------------------------------------------------
-- A.9  tree_sessions — teacher-owned "Cây tri thức" activity (Phase 7.1).
--      One open question posed to a class; each student's accepted answer
--      becomes a "fruit" on a shared tree. `max_similarity` is the trigram
--      ceiling that keeps the tree growing with DISTINCT ideas.
--
--      class_id is ON DELETE RESTRICT (not cascade): a class roster is shared
--      with exams, so cascading a class deletion into activity data would be
--      surprising. The teacher deletes the session first.
-- ----------------------------------------------------------------------------
create table if not exists public.tree_sessions (
    id                 uuid         primary key default gen_random_uuid(),
    user_id            uuid         not null references auth.users (id) on delete cascade,
    class_id           uuid         not null references public.classes (id) on delete restrict,
    title              varchar(255) not null,
    question_text      text         not null,
    min_words          integer      not null default 20,
    time_limit_minutes integer      not null default 45,
    max_similarity     numeric(3,2) not null default 0.60,
    tree_seed          integer      not null default floor(random() * 1000000)::integer,
    is_active          boolean      not null default true,
    -- Phase 9.1 — lobby lifecycle. Kept IN SYNC with is_active, which remains the
    -- gate submit_tree_answer has always enforced: `start_tree_session` writes both,
    -- and the teacher web's `endTreeSession` closes them together.
    status             varchar(20)  not null default 'LOBBY'
        constraint tree_sessions_status_check check (status in ('LOBBY', 'ACTIVE', 'FINISHED')),
    -- Phase 9.1 — short human-readable join code for the projector PIN / QR.
    session_code       varchar(12)  not null default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
    -- Phase 9.1 — BRAINSTORM (open keyword) or SPEED_QUIZ (timed MCQ).
    game_mode          varchar(20)  not null default 'BRAINSTORM'
        constraint tree_sessions_game_mode_check check (game_mode in ('BRAINSTORM', 'SPEED_QUIZ')),
    exam_id            uuid         references public.exams (id) on delete set null,
    target_score       integer      not null default 20
        constraint tree_sessions_target_score_check check (target_score > 0),
    participant_config jsonb        not null default '{"absent_ids": [], "assignments": {}}'::jsonb,
    started_at         timestamptz,
    ends_at            timestamptz,
    created_at         timestamptz  not null default now(),
    ended_at           timestamptz,
    constraint tree_sessions_max_similarity_range
        check (max_similarity > 0.0 and max_similarity <= 1.0),
    constraint tree_sessions_min_words_positive check (min_words > 0),
    constraint tree_sessions_time_limit_positive check (time_limit_minutes > 0)
);

-- Idempotency for databases created before Phase 9.1. `status` is added with an
-- explicit backfill rather than inside the CREATE, because `add column ... default
-- 'LOBBY'` would strand every session that is already under way: the corrective
-- UPDATE runs only on the first application, which is what keeps this re-runnable
-- without a migration ledger.
do $$
begin
    if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'tree_sessions'
           and column_name = 'status'
    ) then
        alter table public.tree_sessions add column status varchar(20) not null default 'LOBBY';
        update public.tree_sessions
           set status = case when is_active then 'ACTIVE' else 'FINISHED' end;
    end if;
end $$;

alter table public.tree_sessions add column if not exists session_code varchar(12);
update public.tree_sessions
   set session_code = upper(substr(md5(id::text), 1, 6))
 where session_code is null;
alter table public.tree_sessions alter column session_code set default upper(substr(md5(gen_random_uuid()::text), 1, 6));
alter table public.tree_sessions alter column session_code set not null;
alter table public.tree_sessions add column if not exists game_mode varchar(20) not null default 'BRAINSTORM';
alter table public.tree_sessions add column if not exists exam_id uuid references public.exams (id) on delete set null;
alter table public.tree_sessions add column if not exists target_score integer not null default 20;
alter table public.tree_sessions add column if not exists participant_config jsonb not null default '{"absent_ids": [], "assignments": {}}'::jsonb;
alter table public.tree_sessions add column if not exists started_at timestamptz;
alter table public.tree_sessions add column if not exists ends_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'tree_sessions_game_mode_check') then
        alter table public.tree_sessions add constraint tree_sessions_game_mode_check
            check (game_mode in ('BRAINSTORM', 'SPEED_QUIZ'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'tree_sessions_target_score_check') then
        alter table public.tree_sessions add constraint tree_sessions_target_score_check
            check (target_score > 0);
    end if;
end $$;

create unique index if not exists tree_sessions_session_code_uniq on public.tree_sessions (session_code);
create index if not exists idx_tree_sessions_status on public.tree_sessions (status);

comment on table public.tree_sessions is 'Teacher-owned "Cây tri thức" activity: one open question posed to a class (Phase 7.1).';
comment on column public.tree_sessions.max_similarity is 'Trigram similarity ceiling. An answer at or below this is accepted; above it is rejected as duplicated.';
comment on column public.tree_sessions.tree_seed is 'Deterministic seed so every client renders the same procedural tree.';
comment on column public.tree_sessions.status is 'Lobby lifecycle: LOBBY (waiting room) -> ACTIVE -> FINISHED. Kept in sync with is_active (Phase 9.1).';
comment on column public.tree_sessions.session_code is 'Short human-readable join code shown as the projector PIN / QR payload (Phase 9.1).';
comment on column public.tree_sessions.participant_config is 'Pre-flight roster: {"absent_ids": [member uuid], "assignments": {member uuid: team 1..4}} (Phase 9.1).';
comment on column public.tree_sessions.game_mode is 'BRAINSTORM (open keyword) or SPEED_QUIZ (timed MCQ) (Phase 9.1).';
comment on column public.tree_sessions.target_score is 'Points a team must reach to win in SPEED_QUIZ (Phase 9.1).';

-- ----------------------------------------------------------------------------
-- A.10 tree_submissions — one answer per student per session ("fruit").
--      UNIQUE(session_id, student_code) makes a resubmission an UPDATE rather
--      than a second fruit; the RPC keeps the original fruit_index so the tree
--      does not reshuffle when a student edits their answer.
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
    -- Phase 8.4 — the author's team (Tổ) 1..4, resolved by submit_tree_answer.
    team_number  smallint     not null default 1 check (team_number between 1 and 4),
    constraint tree_submissions_session_student_uniq unique (session_id, student_code),
    constraint tree_submissions_fruit_index_positive check (fruit_index > 0),
    constraint tree_submissions_word_count_nonneg check (word_count >= 0)
);

-- Idempotency for databases created before Phase 8.4.
alter table public.tree_submissions add column if not exists team_number smallint not null default 1 check (team_number between 1 and 4);

comment on table public.tree_submissions is 'Student answers ("fruits") for a tree session. UNIQUE(session_id, student_code) makes resubmission an update, not a new fruit.';
comment on column public.tree_submissions.team_number is 'Team the author belonged to when they submitted (Phase 8.4).';


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
-- Phase 6.1 — RLS predicates and the roster join both filter on these.
create index if not exists idx_classes_user_id               on public.classes (user_id);
create index if not exists idx_class_members_class_id        on public.class_members (class_id);
create index if not exists idx_class_members_student_code    on public.class_members (student_code);
-- Phase 7.1 — tree activity.
create index if not exists idx_tree_sessions_class_id         on public.tree_sessions (class_id);
create index if not exists idx_tree_sessions_user_id          on public.tree_sessions (user_id);
create index if not exists idx_tree_submissions_session_id    on public.tree_submissions (session_id);
-- Orders the tree in one pass (the client sorts by fruit_index).
create index if not exists idx_tree_submissions_session_fruit on public.tree_submissions (session_id, fruit_index);
-- Phase 8.4 — the arena projector filters each of its four trees by team.
create index if not exists idx_tree_submissions_session_team  on public.tree_submissions (session_id, team_number);
-- Trigram index backing similarity() lookups. The operator class lives in the
-- `extensions` schema, so it MUST be schema-qualified: an unqualified
-- `gin_trgm_ops` resolves against the current search_path at CREATE INDEX time.
create index if not exists idx_tree_submissions_trgm
    on public.tree_submissions using gin (answer_text extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- A.10 exam_audit_logs — proctoring violations & anti-cheat audit trail (Phase 11.0)
-- ----------------------------------------------------------------------------
create table if not exists public.exam_audit_logs (
    id                uuid         primary key default gen_random_uuid(),
    exam_code         varchar(50)  not null,
    student_code      varchar(50)  not null,
    violation_type    varchar(50)  not null,
    violation_message text,
    metadata          jsonb        default '{}'::jsonb,
    occurred_at       timestamptz  not null default now()
);

create index if not exists idx_exam_audit_logs_lookup
    on public.exam_audit_logs (exam_code, student_code, occurred_at desc);

comment on table public.exam_audit_logs is 'Audit trail for student proctoring violations (Phase 11.0).';


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
-- Phase 6.1 — independent class rosters.
alter table public.classes             enable row level security;
alter table public.class_members       enable row level security;
-- Phase 7.1 — tree activity.
alter table public.tree_sessions       enable row level security;
alter table public.tree_submissions    enable row level security;
-- Phase 11.0 — anti-cheat violation logs.
alter table public.exam_audit_logs     enable row level security;

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

-- --- classes / class_members: full CRUD for the owning teacher (Phase 6.1) ---
drop policy if exists classes_owner_all on public.classes;
create policy classes_owner_all on public.classes
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Membership is scoped through the parent class, mirroring how `students` is
-- scoped through its exam.
drop policy if exists class_members_owner_all on public.class_members;
create policy class_members_owner_all on public.class_members
    for all
    to authenticated
    using (
        exists (
            select 1 from public.classes c
            where c.id = class_members.class_id and c.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.classes c
            where c.id = class_members.class_id and c.user_id = auth.uid()
        )
    );

-- --- tree_sessions / tree_submissions: "Cây tri thức" (Phase 7.1) ----------
drop policy if exists tree_sessions_owner_all on public.tree_sessions;
create policy tree_sessions_owner_all on public.tree_sessions
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Teacher review/export of the answers to their own sessions.
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

-- --- exam_audit_logs: teacher reads violation logs for their exams (Phase 11.0) ---
drop policy if exists exam_audit_logs_teacher_read on public.exam_audit_logs;
create policy exam_audit_logs_teacher_read on public.exam_audit_logs
    for select
    to authenticated
    using (
        exists (
            select 1 from public.exams e
            where e.code = exam_audit_logs.exam_code and e.user_id = auth.uid()
        )
    );

-- The predicate helper is defined HERE rather than in Section C because
-- `create policy` validates its expression immediately, so a forward reference
-- to a not-yet-created function aborts the script.
--
-- It MUST be SECURITY DEFINER: a policy predicate is evaluated AS THE QUERYING
-- ROLE (`anon`), which holds NO privilege on tree_sessions (revoked below), so
-- an inline `exists (select 1 from tree_sessions ...)` raises
-- `permission denied for table tree_sessions` instead of returning rows.
-- Verified locally: the inline form fails as anon, this helper succeeds.
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

-- Students (anon) read the fruits of a session so the tree renders and stays live.
drop policy if exists tree_submissions_public_read on public.tree_submissions;
create policy tree_submissions_public_read on public.tree_submissions
    for select
    to anon, authenticated
    using (public.tree_session_is_public(session_id));

-- --- Privilege hardening -----------------------------------------------------
-- Students (anon) must hold no direct table access whatsoever.
-- Supabase grants ALL on public tables to anon by default; revoke it.
revoke all on public.exams                from anon;
revoke all on public.question_bank        from anon;
revoke all on public.students             from anon;
revoke all on public.active_sessions      from anon;
revoke all on public.exam_results         from anon;
revoke all on public.proctoring_snapshots from anon;
revoke all on public.classes              from anon;
revoke all on public.class_members        from anon;
-- Phase 7.1 — writes are RPC-only; reads go through the policy above.
revoke all on public.tree_sessions        from anon;
revoke all on public.tree_submissions     from anon;
grant select on public.tree_submissions   to anon;
-- Phase 11.0 — student writes only via log_exam_violation RPC; teachers read via RLS.
revoke all on public.exam_audit_logs      from anon;


-- ============================================================================
-- SECTION C — ATOMIC RPCs (SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Run as the function owner (postgres, which owns the tables) so RLS is
-- bypassed internally. search_path is pinned to defeat search_path hijacking.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- C.1  verify_and_acquire_session
--      Whitelist verification + PIN policy + scheduling window + single-device
--      lock + reload tolerance.
--      Returns: { success, session_token, message }
--        SESSION_ACQUIRED        -> brand new session
--        SESSION_RESUMED         -> same device reloaded (token matched)
--        SESSION_ACTIVE_ELSEWHERE-> another live device holds the lock
--        EXAM_INACTIVE           -> teacher closed the exam (is_active = false)
--        EXAM_NOT_STARTED        -> now() is before starts_at
--        EXAM_EXPIRED            -> now() is after ends_at
--        EXAM_NOT_FOUND          -> exam is in the Trash (deleted_at set) or gone
--        INVALID_PIN             -> pin_mode policy not satisfied (Phase 6.1)
--
--      Phase 6.1 adds `p_pin` and the three-mode PIN gate (step 3.b below).
--
--      NOTE ON THE SIGNATURE: the 6-argument version is DROPPED first. Adding a
--      parameter to a function does NOT replace it — `create or replace` matches
--      on the signature — so without the drop the old PIN-LESS overload would
--      survive as a complete bypass (and a call matching both would even raise
--      "is not unique"). Verified on PG15: both definitions survive a bare
--      create-or-replace.
-- ----------------------------------------------------------------------------
drop function if exists public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid);

create or replace function public.verify_and_acquire_session(
    p_exam_code      varchar,
    p_student_code   varchar default null,
    p_full_name      varchar default null,
    p_class_name     varchar default null,
    p_device_info    text    default null,
    p_existing_token uuid    default null,
    p_pin            varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam              public.exams%rowtype;
    v_student           public.students%rowtype;
    v_session           public.active_sessions%rowtype;
    v_exam_session      public.exam_sessions%rowtype;
    v_new_token         uuid := gen_random_uuid();
    v_code              varchar;
    v_name              varchar;
    v_class             varchar;
    v_sec_cfg           jsonb;
    v_now               timestamptz := now();
    v_remaining_seconds int := 0;
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

    if v_exam.starts_at is not null and v_now < v_exam.starts_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_STARTED');
    end if;
    if v_exam.ends_at is not null and v_now > v_exam.ends_at then
        return jsonb_build_object('success', false, 'message', 'EXAM_EXPIRED');
    end if;

    v_sec_cfg := coalesce(v_exam.security_config, '{
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

    -- 4. Check existing submission
    if exists (
        select 1 from public.exam_results
         where exam_code = p_exam_code and student_code = v_student.student_code
    ) then
        return jsonb_build_object(
            'success', false,
            'code', 'EXAM_ALREADY_SUBMITTED',
            'message', 'ALREADY_SUBMITTED'
        );
    end if;

    -- 5. Server-anchored timing recovery via exam_sessions
    select * into v_exam_session
      from public.exam_sessions
     where exam_id = v_exam.id
       and lower(trim(student_code)) = lower(trim(v_student.student_code));

    if found then
        if v_exam_session.is_completed then
            return jsonb_build_object(
                'success', false,
                'code', 'EXAM_ALREADY_SUBMITTED',
                'message', 'ALREADY_SUBMITTED'
            );
        end if;

        v_remaining_seconds := greatest(0, extract(epoch from (v_exam_session.ends_at - v_now))::int);
        if v_remaining_seconds <= 0 then
            update public.exam_sessions
               set is_completed = true,
                   submitted_at = v_now
             where id = v_exam_session.id;

            return jsonb_build_object(
                'success', false,
                'code', 'EXAM_TIME_EXPIRED',
                'message', 'EXAM_TIME_EXPIRED'
            );
        end if;
    else
        -- Initial session creation
        insert into public.exam_sessions (
            exam_id, exam_code, student_code, started_at, ends_at, is_completed
        ) values (
            v_exam.id, p_exam_code, v_student.student_code, v_now,
            v_now + (v_exam.duration_minutes || ' minutes')::interval, false
        ) returning * into v_exam_session;

        v_remaining_seconds := v_exam.duration_minutes * 60;
    end if;

    -- 6. Active sessions lock & recovery
    select * into v_session
      from public.active_sessions
     where exam_code = p_exam_code
       and student_code = v_student.student_code
     for update;

    if found then
        if v_session.last_heartbeat > v_now - interval '60 seconds' then
            if p_existing_token is not null and p_existing_token = v_session.session_token then
                update public.active_sessions
                   set last_heartbeat = v_now,
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
                    'time_remaining_seconds', v_remaining_seconds,
                    'started_at', v_exam_session.started_at,
                    'ends_at', v_exam_session.ends_at,
                    'shuffle_questions', v_exam.shuffle_questions,
                    'security_config', v_sec_cfg,
                    'message', 'SESSION_RESUMED'
                );
            end if;
            return jsonb_build_object('success', false, 'message', 'SESSION_ACTIVE_ELSEWHERE');
        end if;

        update public.active_sessions
           set session_token         = v_new_token,
               last_heartbeat        = v_now,
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
            'time_remaining_seconds', v_remaining_seconds,
            'started_at', v_exam_session.started_at,
            'ends_at', v_exam_session.ends_at,
            'shuffle_questions', v_exam.shuffle_questions,
            'security_config', v_sec_cfg,
            'message', 'SESSION_ACQUIRED'
        );
    end if;

    insert into public.active_sessions (
        student_code, exam_code, session_token, last_heartbeat,
        current_question, answered_count, blur_count, fullscreen_exit_count, device_info
    ) values (
        v_student.student_code, p_exam_code, v_new_token, v_now,
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
        'time_remaining_seconds', v_remaining_seconds,
        'started_at', v_exam_session.started_at,
        'ends_at', v_exam_session.ends_at,
        'shuffle_questions', v_exam.shuffle_questions,
        'security_config', v_sec_cfg,
        'message', 'SESSION_ACQUIRED'
    );

exception
    when unique_violation then
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
            'total_questions',  coalesce(v_total, 0),
            -- Phase 8.7 — false = the teacher wants the authored order kept.
            'shuffle_questions', v_exam.shuffle_questions
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

    -- 5. Mark completed in exam_sessions if present
    update public.exam_sessions
       set is_completed = true,
           submitted_at = now()
     where exam_id = v_exam.id
       and lower(trim(student_code)) = lower(trim(p_student_code));

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
-- C.7  verify_student_practice  (PUBLIC — anon, Phase 5.2 / 8.9)
--      Gate for AUTHORIZED SELF-PRACTICE with a personal .docx.
--
--      Phase 8.9: the gate is the CLASS ROSTER, not an exam roster. The class
--      must exist, its `allow_practice` must be true, and the candidate must be
--      a `class_members` row of THAT class. Previously this matched
--      `public.students` — the whitelist of any exam the candidate had been
--      imported into — which made the gate a side-effect of historical imports
--      and left the teacher no way to switch a class off.
--
--      Consequences, both intentional:
--        * authorisation no longer consults `public.students` at all;
--        * a teacher with no `classes` row now gets CLASS_NOT_FOUND. `classes`
--          is the source of truth (import_class_to_exam() copies it into exams),
--          so the gate now agrees with how rosters are actually maintained.
--
--      Matching is case- and whitespace-insensitive on every field (NFC is the
--      client's job; SQL collapses UTF-8 whitespace), mirroring
--      verify_and_acquire_session().
--
--      This is an authorization probe only: it writes nothing, reveals no exam
--      content, and echoes the caller's own identity back.
--
--      The SIGNATURE is unchanged from Phase 8.1, so this is a plain create or
--      replace — no drop, hence no window without the function and no lost ACL.
--      (The older 2-arg overload was dropped back in Phase 8.1; see the history.)
-- ----------------------------------------------------------------------------
drop function if exists public.verify_student_practice(varchar, varchar);

create or replace function public.verify_student_practice(
    p_class_name   varchar,
    p_full_name    varchar,
    p_student_code varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_class   public.classes%rowtype;
    v_member  public.class_members%rowtype;
    v_name    varchar;
    v_class_n varchar;
    -- Tracked explicitly rather than relying on FOUND: a skipped branch would
    -- otherwise leave FOUND holding whatever the previous statement set. (Testing
    -- an unassigned RECORD with `IS NULL` also raises "record is not assigned
    -- yet".)
    v_matched boolean := false;
begin
    if p_class_name is null or trim(p_class_name) = '' then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_REQUIRED',
            'message', 'Vui lòng nhập hoặc chọn tên lớp.'
        );
    end if;

    if p_full_name is null or trim(p_full_name) = '' then
        return jsonb_build_object(
            'success', false,
            'code',    'NAME_REQUIRED',
            'message', 'Vui lòng nhập họ và tên của bạn.'
        );
    end if;

    v_class_n := lower(regexp_replace(trim(p_class_name), '\s+', ' ', 'g'));
    v_name    := lower(regexp_replace(trim(p_full_name),  '\s+', ' ', 'g'));

    -- 1. Resolve the class by normalized name.
    --
    --    `classes` is per-teacher, so two teachers may own a class of the same
    --    name. ORDER BY puts an ENABLED class first, which is load-bearing:
    --    get_public_practice_classes() lists a name when ANY teacher permits
    --    practice, so a name offered in that pick-list must actually verify.
    --    Ordering by id alone could resolve a listed name to a different
    --    tenant's disabled class and refuse it with CLASS_PRACTICE_DISABLED.
    select * into v_class
      from public.classes c
     where lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')) = v_class_n
     order by c.allow_practice desc, c.id
     limit 1;

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_NOT_FOUND',
            'message', 'Lớp học không tồn tại trên hệ thống. Vui lòng kiểm tra lại tên lớp!'
        );
    end if;

    -- 2. The teacher's permission switch.
    if not v_class.allow_practice then
        return jsonb_build_object(
            'success', false,
            'code',    'CLASS_PRACTICE_DISABLED',
            'message', 'Lớp của bạn hiện đang tạm khóa quyền tự luyện tập. Vui lòng liên hệ giáo viên!'
        );
    end if;

    -- 3. Candidate must be a member of THAT class. Fast path by student_code when
    --    supplied, else the normalized full name; both scoped to `class_id`, so
    --    membership of another class never authorises.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select * into v_member
          from public.class_members m
         where m.class_id = v_class.id
           and lower(trim(m.student_code)) = lower(trim(p_student_code))
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        select * into v_member
          from public.class_members m
         where m.class_id = v_class.id
           and lower(regexp_replace(trim(m.full_name), '\s+', ' ', 'g')) = v_name
         -- A class may hold two students with the same name ((class_id,
         -- student_code) is the unique key, not the name); the lowest code is a
         -- stable pick and cannot escalate — it only echoes that row's identity.
         order by m.student_code
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        return jsonb_build_object(
            'success', false,
            'code',    'STUDENT_NOT_FOUND',
            'message', 'Thông tin học sinh không có trong danh sách của lớp này.'
        );
    end if;

    return jsonb_build_object(
        'success',      true,
        'class_name',   v_class.name,
        'full_name',    v_member.full_name,
        'student_code', v_member.student_code
    );
end;
$$;

comment on function public.verify_student_practice(varchar, varchar, varchar) is
    'Public gate for personal-.docx self-practice. Class must exist and have allow_practice = true, and the candidate must be a class_members row of THAT class (Phase 8.9).';


-- ----------------------------------------------------------------------------
-- C.7b  get_public_practice_classes  (PUBLIC — anon, Phase 8.9)
--       Distinct class names whose teacher permits self-practice, for the SPA's
--       class pick-list. Anon-executable BY DESIGN: the SPA populates a datalist
--       before the student has identified themselves. Exposes class NAMES only —
--       no member, credential or result data. DISTINCT because `classes` is
--       per-teacher and two teachers may share a class name.
-- ----------------------------------------------------------------------------
create or replace function public.get_public_practice_classes()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_classes jsonb;
begin
    select jsonb_agg(distinct c.name order by c.name asc)
      into v_classes
      from public.classes c
     where c.allow_practice = true;

    return jsonb_build_object(
        'success', true,
        -- coalesce, not `[]`: jsonb_agg over zero rows yields NULL, and the
        -- client iterates this unconditionally.
        'classes', coalesce(v_classes, '[]'::jsonb)
    );
end;
$$;

comment on function public.get_public_practice_classes() is
    'Distinct class names with allow_practice = true, for the student SPA class pick-list (Phase 8.9).';


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


-- ----------------------------------------------------------------------------
-- C.13  get_practice_exam_payload  (student — anon, Phase 5.8)
--       The ONLY path that hands out answer keys for a STORED exam. Self-practice
--       used to require a personal .docx because F1/F3 keep question_bank keys
--       away from the student runtime; this is the narrow, teacher-controlled
--       exception: it returns questions in original `position ASC` order WITH
--       `correct_answer` + `explanation`, and refuses unless the teacher set
--       `exams.allow_practice = true`.
--
--       Returning: { success: true, exam: {...}, questions: [...] }
--              or: { success: false, message: <CODE> }
--       Codes: PRACTICE_NOT_ALLOWED / STUDENT_NOT_WHITELISTED / PRACTICE_EMPTY
--              (a trashed or missing exam reports EXAM_NOT_FOUND).
--
--       Authorization: the caller must be ON THIS EXAM'S ROSTER (`students`),
--       matched case/whitespace-insensitively. Phase 8.1 widens this from
--       student_code + class_name to EITHER:
--           * p_student_code (when supplied), or
--           * (p_full_name, p_class_name)
--       because the student SPA no longer shows a student-code input.
--
--       Deliberately NOT gated on is_active / the scheduling window (a teacher
--       who closes an exam for the sitting may still want it practiceable), but
--       trashed exams ARE refused (Phase 5.5: Trash is invisible to students).
--
--       Phase 8.1: the signature gained p_full_name, so the OLD 3-arg function is
--       dropped first — `create or replace` would otherwise leave both versions
--       in place and make a matching call ambiguous.
-- ----------------------------------------------------------------------------
drop function if exists public.get_practice_exam_payload(varchar, varchar, varchar);

create or replace function public.get_practice_exam_payload(
    p_exam_code    varchar,
    p_student_code varchar default null,
    p_class_name   varchar default null,
    p_full_name    varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_match     public.students%rowtype;
    v_matched   boolean := false;
    v_questions jsonb;
    v_total     integer;
begin
    select * into v_exam from public.exams where code = upper(trim(coalesce(p_exam_code, '')));
    if not found then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- Trashed exams stay invisible to students (mirrors verify_and_acquire_session).
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'message', 'EXAM_NOT_FOUND');
    end if;

    -- The teacher's explicit consent is the ONLY thing that unlocks the key.
    if v_exam.allow_practice is not true then
        return jsonb_build_object('success', false, 'message', 'PRACTICE_NOT_ALLOWED');
    end if;

    -- Flexible whitelist check: by student_code when supplied, otherwise by
    -- (full_name + class_name). `v_matched` is tracked explicitly rather than
    -- relying on FOUND, which an if/elsif with no branch would leave stale.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select * into v_match
          from public.students s
         where s.exam_code = v_exam.code
           and lower(trim(s.student_code)) = lower(trim(p_student_code))
         limit 1;
        v_matched := found;
    elsif p_full_name is not null and trim(p_full_name) <> ''
      and p_class_name is not null and trim(p_class_name) <> '' then
        select * into v_match
          from public.students s
         where s.exam_code = v_exam.code
           and lower(trim(s.full_name))  = lower(trim(p_full_name))
           and lower(trim(s.class_name)) = lower(trim(p_class_name))
         order by s.student_code
         limit 1;
        v_matched := found;
    end if;

    if not v_matched then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    -- Original order. Position ASC is the contract: practice must NOT shuffle,
    -- so that a student reviewing "Câu 7" sees the same numbering as the paper.
    -- `correct_answer` and `explanation` are included on purpose.
    with ordered as (
        select q.*,
               (row_number() over (order by q.position, q.created_at, q.id) - 1) as idx
          from public.question_bank q
         where q.exam_id = v_exam.id
    )
    select
        coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'index',          o.idx,
                    'question_text',  o.question_text,
                    'question_type',  o.question_type,
                    'options',        o.options,
                    'correct_answer', o.correct_answer,
                    'explanation',    o.explanation
                )
                order by o.idx
            ),
            '[]'::jsonb
        ),
        count(*)
      into v_questions, v_total
      from ordered o;

    if coalesce(v_total, 0) = 0 then
        return jsonb_build_object('success', false, 'message', 'PRACTICE_EMPTY');
    end if;

    return jsonb_build_object(
        'success', true,
        'exam', jsonb_build_object(
            'code',             v_exam.code,
            'title',            v_exam.title,
            'duration_minutes', v_exam.duration_minutes,
            'total_questions',  v_total,
            -- Phase 8.7 — context only; the practice order is the student's toggle.
            'shuffle_questions', v_exam.shuffle_questions
        ),
        -- The roster row is authoritative: the client displays this rather than
        -- echoing whatever identity was typed.
        'student_name', v_match.full_name,
        'questions', v_questions
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.14  import_class_to_exam  (teacher — authenticated, Phase 6.1)
--       Copies one or more class rosters into an exam's `students` whitelist.
--
--       Re-importing the same class REFRESHES name/class/dob/pin rather than
--       failing, so a teacher who fixes a typo in a class roster can simply
--       re-import. Returns the number of rows inserted/updated.
--
--       SECURITY DEFINER with an explicit ownership check: auth.uid() reads the
--       JWT (not the SQL role), so it still resolves to the calling teacher even
--       though the body runs as the function owner.
--
--       Signalling: unlike the other RPCs here this RETURNS integer and RAISES
--       on failure, by contract (a batch import is all-or-nothing for the UI).
-- ----------------------------------------------------------------------------
create or replace function public.import_class_to_exam(
    p_exam_code varchar,
    p_class_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam_id        uuid;
    v_inserted_count integer;
begin
    -- 1. The caller must own this exam and it must not be trashed.
    select e.id into v_exam_id
      from public.exams e
     where e.code = upper(trim(p_exam_code))
       and e.user_id = auth.uid()
       and e.deleted_at is null;
    if v_exam_id is null then
        raise exception 'UNAUTHORIZED_OR_EXAM_NOT_FOUND';
    end if;

    -- 2. Import. ON CONFLICT targets students_code_exam_uniq.
    --    The join to `classes` re-checks ownership, so a class id belonging to
    --    another teacher contributes nothing even if it was passed in.
    insert into public.students (exam_code, student_code, full_name, class_name, dob, pin)
    select
        upper(trim(p_exam_code)),
        cm.student_code,
        cm.full_name,
        c.name,
        cm.dob,
        cm.pin
      from public.class_members cm
      join public.classes c on c.id = cm.class_id
     where cm.class_id = any(p_class_ids)
       and c.user_id = auth.uid()
    on conflict (exam_code, student_code) do update
       set full_name  = excluded.full_name,
           class_name = excluded.class_name,
           dob        = excluded.dob,
           pin        = excluded.pin;

    get diagnostics v_inserted_count = row_count;
    return coalesce(v_inserted_count, 0);
end;
$$;


-- ----------------------------------------------------------------------------
-- C.15  get_exam_roster  (student — anon, Phase 6.3)
--       Powers the student SPA's class + student picker. Returns the candidate
--       list for an OPEN exam so the student selects their own name instead of
--       typing it, which is what makes the Phase 6.1 PIN flow usable.
--
--       Returning: { success: true, exam_code, title, pin_mode, candidates: [
--                      { student_code, full_name, class_name } ] }
--              or: { success: false, code, message }
--       Codes: EXAM_NOT_FOUND / EXAM_INACTIVE / EXAM_NOT_STARTED / EXAM_EXPIRED
--
--       NEVER returns `pin` or `dob` — both are exam credentials (dob is the
--       DDMM fallback PIN). The projection is written as three explicit keys,
--       never `s.*`.
--
--       This is the ONE anon RPC that answers BEFORE the caller proves roster
--       membership (the picker exists so they can find themselves). The trade-off
--       is documented in migration 20261005110000: a live exam code reveals that
--       exam's names/codes/classes, but no secret. An empty roster is not an
--       error — the SPA falls back to manual entry.
--
--       Phase 8.1: `p_for_practice = true` returns the roster of a
--       practice-enabled exam even when it is CLOSED or outside its window, so a
--       student can self-practise after the sitting. It still refuses a trashed
--       exam and one with `allow_practice = false`. The signature gained a
--       parameter, so the OLD 1-arg function is dropped first (overload hazard).
-- ----------------------------------------------------------------------------
drop function if exists public.get_exam_roster(varchar);

create or replace function public.get_exam_roster(
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

    -- Trashed exams stay invisible to students (mirrors verify_and_acquire_session).
    if v_exam.deleted_at is not null then
        return jsonb_build_object('success', false, 'code', 'EXAM_NOT_FOUND', 'message', 'Đề thi không tồn tại.');
    end if;

    if p_for_practice then
        -- Practice mode: the ONLY gate is the teacher's explicit consent. The
        -- open/close switch and the schedule are deliberately NOT consulted —
        -- that is the point of this parameter (self-study after the sitting).
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
            return jsonb_build_object('success', false, 'code', 'EXAM_EXPIRED', 'message', 'Đề thi đã kết thúc.');
        end if;
    end if;

    v_sec_cfg := coalesce(v_exam.security_config, '{
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
    }'::jsonb);

    -- Three display keys ONLY: `pin`/`dob` must never leave the server here.
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
        -- Phase 8.8 — lets the login banner show the paper's length before the
        -- student commits, without a second round-trip.
        'duration_minutes', v_exam.duration_minutes,
        'pin_mode',       v_exam.pin_mode,
        -- Lets the practice picker distinguish "closed" from "not open for
        -- practice" without a second round-trip.
        'allow_practice', v_exam.allow_practice,
        -- Phase 8.7 — the paper-ordering policy, so the picker can show it.
        'shuffle_questions', v_exam.shuffle_questions,
        'security_config', v_sec_cfg,
        'candidates',     coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.16  log_exam_violation  (student — anon, Phase 11.0)
--       Records client-side proctoring violation event into exam_audit_logs.
-- ----------------------------------------------------------------------------
create or replace function public.log_exam_violation(
    p_exam_code       varchar,
    p_student_code    varchar,
    p_violation_type  varchar,
    p_message         text default null,
    p_metadata        jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if p_exam_code is null or p_student_code is null or p_violation_type is null then
        return jsonb_build_object('success', false, 'code', 'INVALID_ARGS');
    end if;

    insert into public.exam_audit_logs (
        exam_code, student_code, violation_type, violation_message, metadata, occurred_at
    ) values (
        upper(trim(p_exam_code)),
        trim(p_student_code),
        trim(p_violation_type),
        p_message,
        coalesce(p_metadata, '{}'::jsonb),
        now()
    );

    return jsonb_build_object('success', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- C.17  proctor_force_submit_exam  (teacher — authenticated, Phase 11.2)
--       Allows teachers/proctors to forcibly end a candidate exam session and log
--       the action to exam_audit_logs.
-- ----------------------------------------------------------------------------
create or replace function public.proctor_force_submit_exam(
  p_exam_code varchar,
  p_student_code varchar,
  p_reason text default 'Giám thị thu bài trực tiếp'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid;
  v_exam record;
begin
  v_teacher_id := auth.uid();
  if v_teacher_id is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
  end if;

  select id, code, user_id
  into v_exam
  from public.exams
  where code = upper(trim(p_exam_code)) and user_id = v_teacher_id;

  if not found then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  end if;

  -- Insert audit record of forced submission
  insert into public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) values (
    v_exam.code,
    trim(p_student_code),
    'PROCTOR_FORCE_SUBMIT',
    coalesce(p_reason, 'Giám thị thu bài cưỡng chế'),
    jsonb_build_object('proctor_id', v_teacher_id, 'forced', true),
    now()
  );

  -- Remove from active_sessions if exists
  delete from public.active_sessions
  where exam_code = v_exam.code 
    and lower(trim(student_code)) = lower(trim(p_student_code));

  -- Close session in exam_sessions if table exists
  if exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' and table_name = 'exam_sessions'
  ) then
    execute 'update public.exam_sessions set is_completed = true, submitted_at = now() where exam_id = $1 and lower(trim(student_code)) = lower(trim($2))'
    using v_exam.id, p_student_code;
  end if;

  return jsonb_build_object('success', true, 'exam_code', v_exam.code, 'student_code', p_student_code);
end;
$$;

-- ----------------------------------------------------------------------------
-- C.15.2  reset_student_exam_attempt (teacher — authenticated)
--         Deletes previous candidate submission, active session, and exam_session.
-- ----------------------------------------------------------------------------
create or replace function public.reset_student_exam_attempt(
  p_exam_code varchar,
  p_student_code varchar,
  p_reason text default 'Giáo viên cấp lại lượt thi mới'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid;
  v_exam record;
  v_clean_code varchar;
  v_clean_student varchar;
begin
  v_teacher_id := auth.uid();
  if v_teacher_id is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
  end if;

  v_clean_code := upper(trim(p_exam_code));
  v_clean_student := trim(p_student_code);

  select id, code, user_id into v_exam
  from public.exams
  where code = v_clean_code and user_id = v_teacher_id;

  if not found then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  end if;

  delete from public.active_sessions
  where exam_code = v_clean_code and lower(trim(student_code)) = lower(v_clean_student);

  delete from public.exam_results
  where exam_code = v_clean_code and lower(trim(student_code)) = lower(v_clean_student);

  delete from public.exam_sessions
  where exam_id = v_exam.id and lower(trim(student_code)) = lower(v_clean_student);

  insert into public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) values (
    v_clean_code, v_clean_student, 'TEACHER_RESET_ATTEMPT', coalesce(p_reason, 'Cấp lại lượt thi'),
    jsonb_build_object('proctor_id', v_teacher_id), now()
  );

  return jsonb_build_object('success', true, 'exam_code', v_clean_code, 'student_code', v_clean_student);
end;
$$;

revoke all on function public.reset_student_exam_attempt(varchar, varchar, text) from public;
revoke all on function public.reset_student_exam_attempt(varchar, varchar, text) from anon;
grant execute on function public.reset_student_exam_attempt(varchar, varchar, text) to authenticated;

-- ----------------------------------------------------------------------------
-- C.15.3  reopen_student_exam_session (teacher — authenticated)
--         Reopens an exam session and extends its ends_at by p_extra_minutes.
-- ----------------------------------------------------------------------------
create or replace function public.reopen_student_exam_session(
  p_exam_code varchar,
  p_student_code varchar,
  p_extra_minutes int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid;
  v_exam record;
  v_clean_code varchar;
  v_clean_student varchar;
  v_new_ends_at timestamptz;
  v_mins int := coalesce(p_extra_minutes, 5);
begin
  v_teacher_id := auth.uid();
  if v_teacher_id is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập.');
  end if;

  v_clean_code := upper(trim(p_exam_code));
  v_clean_student := trim(p_student_code);

  select id, code, user_id into v_exam
  from public.exams
  where code = v_clean_code and user_id = v_teacher_id;

  if not found then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN', 'message', 'Không tìm thấy đề thi hoặc bạn không có quyền.');
  end if;

  select ends_at into v_new_ends_at
  from public.exam_sessions
  where exam_id = v_exam.id and lower(trim(student_code)) = lower(v_clean_student);

  if not found then
    v_new_ends_at := now() + (v_mins || ' minutes')::interval;
    insert into public.exam_sessions (
      exam_id, exam_code, student_code, started_at, ends_at, is_completed
    ) values (
      v_exam.id, v_clean_code, v_clean_student, now(), v_new_ends_at, false
    );
  else
    v_new_ends_at := greatest(now(), v_new_ends_at) + (v_mins || ' minutes')::interval;

    update public.exam_sessions
    set is_completed = false,
        submitted_at = null,
        ends_at = v_new_ends_at
    where exam_id = v_exam.id and lower(trim(student_code)) = lower(v_clean_student);
  end if;

  delete from public.exam_results
  where exam_code = v_clean_code and lower(trim(student_code)) = lower(v_clean_student);

  delete from public.active_sessions
  where exam_code = v_clean_code and lower(trim(student_code)) = lower(v_clean_student);

  insert into public.exam_audit_logs (
    exam_code, student_code, violation_type, violation_message, metadata, occurred_at
  ) values (
    v_clean_code, v_clean_student, 'TEACHER_REOPEN_SESSION', 'Mở lại bài thi và gia hạn ' || v_mins || ' phút',
    jsonb_build_object('proctor_id', v_teacher_id, 'new_ends_at', v_new_ends_at), now()
  );

  return jsonb_build_object('success', true, 'new_ends_at', v_new_ends_at);
end;
$$;

revoke all on function public.reopen_student_exam_session(varchar, varchar, int) from public;
revoke all on function public.reopen_student_exam_session(varchar, varchar, int) from anon;
grant execute on function public.reopen_student_exam_session(varchar, varchar, int) to authenticated;



-- ----------------------------------------------------------------------------
-- C.16  submit_tree_answer  (student — anon, Phase 7.1 / 8.4)
--       The single write path for the Tree of Knowledge. Validates the session
--       window, enforces the minimum word count, rejects text too similar to an
--       existing answer, then upserts and returns the fruit ordinal.
--
--       Returns { success: true, submission_id, fruit_index, team_number,
--                 word_count, message }
--            or { success: false, code, ... }
--       Codes: SESSION_NOT_FOUND / SESSION_INACTIVE / SESSION_EXPIRED /
--              IDENTITY_REQUIRED / MIN_WORDS_NOT_MET / SIMILARITY_EXCEEDED
--
--       The similarity check EXCLUDES the caller's own prior submission
--       (student_code <>), otherwise a student editing their answer would be
--       compared against their own previous text and could never improve it.
--       It deliberately spans the WHOLE session, so cross-team plagiarism is
--       rejected exactly like a classmate's copy.
--
--       Phase 8.4 — the author's `team_number` is read from `class_members` and
--       recorded, with a deterministic round-robin fallback for a walk-in who is
--       not on the roster.
--
--       `fruit_index` is NOT updated on resubmission (the fruit keeps its place),
--       and the RETURNING clause reads the row's REAL value back, so the returned
--       ordinal is correct for both an insert and an update.
--
--       similarity() is schema-qualified (`extensions.similarity`) because
--       search_path is pinned to public,pg_temp and pg_trgm lives in `extensions`.
-- ----------------------------------------------------------------------------
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
    v_team_number       smallint;
    v_config            jsonb;
    v_member_id         uuid;
begin
    v_student_code := trim(coalesce(p_student_code, ''));
    v_student_name := trim(coalesce(p_student_name, ''));

    if p_session_id is null then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;
    if v_student_code = '' or v_student_name = '' then
        return jsonb_build_object('success', false, 'code', 'IDENTITY_REQUIRED', 'message', 'Thiếu thông tin học sinh.');
    end if;

    select * into v_session from public.tree_sessions where id = p_session_id;
    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    -- Phase 9.1 — the lobby gate. Checked BEFORE `is_active` so a not-yet-started
    -- session reports the actionable "chờ giáo viên" rather than "đã kết thúc".
    if v_session.status = 'LOBBY' then
        return jsonb_build_object('success', false, 'code', 'NOT_STARTED', 'message', 'Trận đấu chưa bắt đầu. Vui lòng chờ giáo viên!');
    end if;

    if v_session.status = 'FINISHED' or v_session.is_active is not true then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;

    -- Once started, the deadline is `ends_at` (stamped by start_tree_session).
    -- Falls back to the legacy created_at anchor for any session that was made
    -- ACTIVE without going through the lobby.
    if v_session.ends_at is not null then
        if now() > v_session.ends_at then
            return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Đã hết thời gian làm bài.');
        end if;
    elsif now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Đã hết thời gian làm bài.');
    end if;

    v_config := coalesce(v_session.participant_config, '{"absent_ids": [], "assignments": {}}'::jsonb);

    -- Phase 8.4 — resolve the author's team from the class roster.
    select cm.id, cm.team_number
      into v_member_id, v_team_number
      from public.class_members cm
     where cm.class_id = v_session.class_id
       and cm.student_code = v_student_code
     limit 1;

    -- Phase 9.1 — a student the teacher marked absent may not submit.
    if v_member_id is not null and (v_config->'absent_ids' ? v_member_id::text) then
        return jsonb_build_object('success', false, 'code', 'STUDENT_ABSENT', 'message', 'Bạn đã được đánh dấu vắng mặt ở hoạt động này.');
    end if;

    -- Phase 9.1 — the pre-flight override wins over the roster's own team, so the
    -- Tổ a student is placed in on the projector is the one they actually score for.
    if v_member_id is not null and v_config->'assignments' ? v_member_id::text then
        v_team_number := nullif(v_config->'assignments'->>v_member_id::text, '')::smallint;
    end if;

    -- Not on the roster: a deterministic round-robin team from the number of
    -- answers already recorded, so a walk-in lands somewhere sensible rather
    -- than always piling onto team 1.
    if v_team_number is null then
        select (((count(*)) % 4) + 1)::smallint
          into v_team_number
          from public.tree_submissions
         where session_id = p_session_id;
    end if;

    -- Normalise all whitespace (newlines/tabs) to single spaces, then count.
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

    select coalesce(max(extensions.similarity(s.answer_text, v_clean_text)), 0.0)
      into v_max_sim
      from public.tree_submissions s
     where s.session_id = p_session_id
       and s.student_code <> v_student_code;

    -- Strict `>`: a score exactly at the ceiling is permitted.
    if v_max_sim > v_session.max_similarity then
        return jsonb_build_object(
            'success',            false,
            'code',               'SIMILARITY_EXCEEDED',
            'similarity_percent', round(v_max_sim * 100, 1),
            'message',            format('Câu trả lời bị trùng lặp %s%% với bài đã nộp. Vui lòng tự diễn đạt lại!', round(v_max_sim * 100, 1))
        );
    end if;

    select coalesce(max(s.fruit_index), 0) + 1
      into v_next_fruit_index
      from public.tree_submissions s
     where s.session_id = p_session_id;

    -- On resubmission fruit_index is NOT updated: the fruit keeps its place.
    insert into public.tree_submissions (
        session_id, student_code, student_name, answer_text, word_count, fruit_index, team_number
    ) values (
        p_session_id, v_student_code, v_student_name, v_clean_text, v_word_count, v_next_fruit_index, v_team_number
    )
    on conflict (session_id, student_code) do update
        set answer_text  = excluded.answer_text,
            word_count   = excluded.word_count,
            student_name = excluded.student_name,
            team_number  = excluded.team_number,
            submitted_at = now()
    returning id, fruit_index into v_submission_id, v_next_fruit_index;

    return jsonb_build_object(
        'success',       true,
        'submission_id', v_submission_id,
        'fruit_index',   v_next_fruit_index,
        'team_number',   v_team_number,
        'word_count',    v_word_count,
        'message',       'Đóng góp thành công! Giọt sương tri thức đã hòa vào cây của Tổ bạn. 🌱💧'
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.15b start_tree_session  (teacher — authenticated, Phase 9.1)
--       The atomic LOBBY -> ACTIVE transition. Stamps `started_at`/`ends_at` from
--       the session's own `time_limit_minutes` and sets `is_active = true`, so the
--       richer `status` lifecycle can never disagree with the boolean gate
--       `submit_tree_answer` has enforced since Phase 7.1.
--
--       SECURITY DEFINER (house pattern for teacher RPCs), so RLS is bypassed in
--       the body and ownership is asserted EXPLICITLY against `tree_sessions.user_id`.
--       Revoked from PUBLIC and `anon` (Supabase grants anon EXECUTE directly, so a
--       PUBLIC-only revoke is not enough); granted to `authenticated` only.
--       Codes: UNAUTHORIZED / NOT_FOUND / INVALID_STATE
-- ----------------------------------------------------------------------------
create or replace function public.start_tree_session(
    p_session_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id uuid;
    v_session    public.tree_sessions%rowtype;
    v_now        timestamptz := now();
    v_ends_at    timestamptz;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
    end if;

    select * into v_session
      from public.tree_sessions
     where id = p_session_id
       and user_id = v_teacher_id;

    if not found then
        return jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'message', 'Không tìm thấy phiên Cây Tri Thức hoặc bạn không có quyền.');
    end if;

    if v_session.status <> 'LOBBY' then
        return jsonb_build_object('success', false, 'code', 'INVALID_STATE', 'message', 'Phiên thi đấu đã bắt đầu hoặc đã kết thúc.');
    end if;

    -- `ends_at` is what the projector countdown and the SPA timer read; it is
    -- derived from the SAME `time_limit_minutes` the pre-9.1 created_at-anchored
    -- deadline used, so the clock does not jump when the teacher starts.
    v_ends_at := v_now + make_interval(mins => v_session.time_limit_minutes);

    update public.tree_sessions
       set status     = 'ACTIVE',
           is_active  = true,
           started_at = v_now,
           ends_at    = v_ends_at
     where id = p_session_id;

    return jsonb_build_object(
        'success',    true,
        'session_id', p_session_id,
        'status',     'ACTIVE',
        'started_at', v_now,
        'ends_at',    v_ends_at
    );
end;
$$;

comment on function public.start_tree_session(uuid) is
    'Teacher-only: LOBBY -> ACTIVE, stamping started_at/ends_at and is_active (Phase 9.1).';


-- ----------------------------------------------------------------------------
-- C.17  get_public_tree_session  (student — anon, Phase 7.4 / 8.4 / 9.1)
--       Powers the student SPA's tree check-in screen and the LOBBY waiting room:
--       resolves a session from its uuid OR its short `session_code`, and returns
--       the question, the word minimum, the renderer seed, the class roster to pick
--       a name from, the lobby state, and — when a `p_student_code` is supplied —
--       that student's resolved team and absent flag.
--
--       Returns { success: true, class_name, total_students, team_counts,
--                 session: { id, title, question_text, min_words,
--                            time_limit_minutes, tree_seed, created_at,
--                            session_code, status, game_mode, exam_id,
--                            target_score, time_remaining_seconds,
--                            is_absent, team_number, student_name },
--                 candidates: [ { student_code, full_name, team_number } ] }
--            or { success: false, code, message }
--       Codes: SESSION_NOT_FOUND / SESSION_INACTIVE / SESSION_EXPIRED
--
--       Phase 9.1 — a LOBBY session is READABLE (the waiting room must render);
--       only a FINISHED / is_active = false session is refused. `is_absent` and the
--       effective `team_number` come from `participant_config`, and an absent
--       student is excluded from `team_counts` so a team's 100% stays reachable.
--
--       Phase 8.4 — `team_counts` is `{ "1": n1, ... "4": n4 }`, the per-team
--       participation denominator the arena needs, and every candidate carries
--       its `team_number`.
--
--       The SIGNATURE changed in Phase 9.1 (uuid -> varchar code, + p_student_code),
--       so the old 1-arg function is dropped first: leaving it would make a call
--       that names only `p_session_code` ambiguous.
--
--       `tree_seed` is NOT a credential — it is the shared input every client
--       feeds the deterministic renderer so the whole class sees the same tree.
--
--       NEVER returns `pin` or `dob` (both are credentials; dob is the DDMM
--       fallback PIN). The projection is two explicit keys, never `cm.*`.
--
--       Like get_exam_roster, this answers BEFORE identity is proven — the picker
--       exists so the student can find their own name. The trade-off (a live
--       session UUID reveals that class's names/codes, but no secret and no answer
--       content) is documented in migration 20261005130000. Reaching `anon` at all
--       requires a SECURITY DEFINER function: Section B revokes every table
--       privilege from anon, so tree_sessions/class_members are unreadable directly.
-- ----------------------------------------------------------------------------
drop function if exists public.get_public_tree_session(uuid);

create or replace function public.get_public_tree_session(
    p_session_code varchar,
    p_student_code varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session        record;
    v_class_name     varchar;
    v_total_students integer;
    v_team_counts    jsonb;
    v_candidates     jsonb;
    v_config         jsonb;
    v_member_id      uuid;
    v_member_name    varchar;
    v_assigned_team  smallint;
    v_is_absent      boolean := false;
    v_time_remaining integer := 0;
begin
    if p_session_code is null or trim(p_session_code) = '' then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    -- Accept EITHER the uuid (legacy `?session=` links) or the short code (the
    -- new QR/PIN). A uuid can never equal a 6-char code, so the two predicates
    -- cannot collide.
    select s.id, s.title, s.question_text, s.min_words, s.time_limit_minutes,
           s.tree_seed, s.is_active, s.created_at, s.class_id,
           s.status, s.game_mode, s.exam_id, s.participant_config, s.target_score,
           s.session_code, s.started_at, s.ends_at
      into v_session
      from public.tree_sessions s
     where s.id::text = lower(trim(p_session_code))
        or s.session_code = upper(trim(p_session_code));

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    -- A LOBBY session is legitimately readable: the waiting room must be able to
    -- show its own state, and a LOBBY session is deliberately `is_active = false`
    -- (the boolean is the pre-start gate). Only FINISHED / a closed ACTIVE
    -- session is refused.
    if v_session.status = 'FINISHED' then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;
    if v_session.status = 'ACTIVE' and v_session.is_active is not true then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;

    -- Expiry is anchored on `ends_at` once the bout has started, and on the old
    -- `created_at + time_limit_minutes` while still in the lobby (so a session
    -- left open overnight does not become immortal).
    if v_session.status = 'ACTIVE' and v_session.ends_at is not null then
        if now() > v_session.ends_at then
            return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Phiên hoạt động đã hết thời gian.');
        end if;
        v_time_remaining := greatest(0, extract(epoch from (v_session.ends_at - now()))::integer);
    elsif now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Phiên hoạt động đã hết thời gian.');
    else
        v_time_remaining := v_session.time_limit_minutes * 60;
    end if;

    select c.name, count(cm.id)::integer
      into v_class_name, v_total_students
      from public.classes c
      left join public.class_members cm on cm.class_id = c.id
     where c.id = v_session.class_id
     group by c.id, c.name;

    v_config := coalesce(v_session.participant_config, '{"absent_ids": [], "assignments": {}}'::jsonb);

    -- Per-team class size. generate_series guarantees all four keys exist, so the
    -- SPA never has to defend against a missing team.
    --
    -- Phase 9.1 — a student marked ABSENT is excluded from their team's
    -- denominator: they are spectating, so counting them would make a team's
    -- 100% unreachable. `participant_config.assignments` overrides a member's
    -- team, so the tally honours it too, or the projector would show a different
    -- split from the one the SPA resolves.
    select coalesce(
               jsonb_object_agg(t.team_num::text, coalesce(t.cnt, 0)),
               '{"1":0,"2":0,"3":0,"4":0}'::jsonb
           )
      into v_team_counts
      from (
          select g.team_num, tc.cnt
            from generate_series(1, 4) as g(team_num)
            left join (
                select effective.team, count(*)::integer as cnt
                  from (
                      select coalesce(
                                 nullif(v_config->'assignments'->>cm.id::text, '')::integer,
                                 cm.team_number,
                                 1
                             ) as team
                        from public.class_members cm
                       where cm.class_id = v_session.class_id
                         and not (v_config->'absent_ids' ? cm.id::text)
                  ) effective
                 group by effective.team
            ) tc on tc.team = g.team_num
      ) t;

    -- `student_code` + `full_name` + `team_number` ONLY: `pin`/`dob` must never
    -- leave the server here.
    select jsonb_agg(
               jsonb_build_object(
                   'student_code', cm.student_code,
                   'full_name',    cm.full_name,
                   'team_number',  coalesce(
                                       nullif(v_config->'assignments'->>cm.id::text, '')::integer,
                                       cm.team_number,
                                       1
                                   )
               )
               order by coalesce(
                            nullif(v_config->'assignments'->>cm.id::text, '')::integer,
                            cm.team_number, 1
                        ) asc,
                        cm.student_code asc
           )
      into v_candidates
      from public.class_members cm
     where cm.class_id = v_session.class_id;

    -- Resolve the calling student's identity when a code is supplied: their
    -- effective team and whether the teacher marked them absent.
    if p_student_code is not null and trim(p_student_code) <> '' then
        select cm.id, cm.full_name
          into v_member_id, v_member_name
          from public.class_members cm
         where cm.class_id = v_session.class_id
           and lower(trim(cm.student_code)) = lower(trim(p_student_code))
         limit 1;

        if found then
            if v_config->'absent_ids' ? v_member_id::text then
                v_is_absent := true;
            end if;
            v_assigned_team := coalesce(
                nullif(v_config->'assignments'->>v_member_id::text, '')::smallint,
                (select cm.team_number from public.class_members cm where cm.id = v_member_id),
                1
            );
        end if;
    end if;

    return jsonb_build_object(
        'success', true,
        'session', jsonb_build_object(
            'id',                 v_session.id,
            'title',              v_session.title,
            'question_text',      v_session.question_text,
            'min_words',          v_session.min_words,
            'time_limit_minutes', v_session.time_limit_minutes,
            'tree_seed',          v_session.tree_seed,
            'created_at',         v_session.created_at,
            -- Phase 9.1 — the bout's real anchor. Vitality must be measured from
            -- the START, not from creation, or a session that waited in the lobby
            -- would look artificially slow before the first answer arrived.
            'started_at',         v_session.started_at,
            'ends_at',            v_session.ends_at,
            'session_code',       v_session.session_code,
            'status',             v_session.status,
            'game_mode',          v_session.game_mode,
            'exam_id',            v_session.exam_id,
            'target_score',       v_session.target_score,
            'time_remaining_seconds', v_time_remaining,
            'is_absent',          v_is_absent,
            'team_number',        case when v_is_absent then null else v_assigned_team end,
            'student_name',       v_member_name
        ),
        'class_name', v_class_name,
        'total_students', greatest(coalesce(v_total_students, 0), 1),
        'team_counts', coalesce(v_team_counts, '{"1":0,"2":0,"3":0,"4":0}'::jsonb),
        'candidates', coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;


-- ----------------------------------------------------------------------------
-- C.18  update_class_member_group  (teacher — authenticated, Phase 8.11)
--       C.19  auto_balance_class_groups  (teacher — authenticated, Phase 8.11)
--
--       Classroom grouping (Tổ/Nhóm, 1..8) for seat-work. Kept INDEPENDENT of the
--       Phase 8.4 arena `team_number` (1..4): the arena caps at four and reads that
--       row's team, so re-shuffling seat groups must not re-partition its trees.
--
--       Both are SECURITY DEFINER — the house pattern for teacher RPCs (see
--       import_class_to_exam above), chosen so they behave identically whether
--       called through PostgREST or psql. RLS is therefore BYPASSED inside the
--       body, so each re-checks ownership EXPLICITLY against `classes.user_id`.
--
--       Callers that must not reach them: students. Both are revoked from PUBLIC
--       AND from `anon` (Supabase's database default privileges grant EXECUTE to
--       `anon` directly, so a `revoke ... from public` alone is not enough) and
--       granted to `authenticated` only.
-- ----------------------------------------------------------------------------
create or replace function public.update_class_member_group(
    p_member_id    uuid,
    p_group_number int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id uuid;
    v_class_id   uuid;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object(
            'success', false,
            'code',    'UNAUTHORIZED',
            'message', 'Yêu cầu đăng nhập giáo viên.'
        );
    end if;

    -- Validated here rather than left to the CHECK constraint: a raw 23514 would
    -- surface to the teacher as an untranslated Postgres error.
    if p_group_number is null or p_group_number < 1 or p_group_number > 8 then
        return jsonb_build_object(
            'success', false,
            'code',    'INVALID_GROUP',
            'message', 'Số tổ phải nằm trong khoảng từ 1 đến 8.'
        );
    end if;

    -- SECURITY DEFINER bypasses RLS, so ownership is asserted explicitly: the
    -- member's parent class must belong to the caller. The join also proves the
    -- member id is real, collapsing "unknown member" and "not yours" into one
    -- indistinguishable answer — a foreign teacher learns nothing either way.
    select cm.class_id into v_class_id
      from public.class_members cm
      join public.classes c on c.id = cm.class_id
     where cm.id = p_member_id
       and c.user_id = v_teacher_id;

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'NOT_FOUND',
            'message', 'Không tìm thấy học sinh hoặc bạn không có quyền.'
        );
    end if;

    update public.class_members
       set group_number = p_group_number::smallint
     where id = p_member_id;

    return jsonb_build_object(
        'success',      true,
        'member_id',    p_member_id,
        'group_number', p_group_number
    );
end;
$$;

comment on function public.update_class_member_group(uuid, int) is
    'Teacher-only: set one class_members.group_number (1..8). Ownership asserted via classes.user_id (Phase 8.11).';

create or replace function public.auto_balance_class_groups(
    p_class_id   uuid,
    p_num_groups int     default 4,
    p_randomize  boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id     uuid;
    v_total_assigned int;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object(
            'success', false,
            'code',    'UNAUTHORIZED',
            'message', 'Yêu cầu đăng nhập giáo viên.'
        );
    end if;

    if p_num_groups is null or p_num_groups < 1 or p_num_groups > 8 then
        return jsonb_build_object(
            'success', false,
            'code',    'INVALID_GROUP_COUNT',
            'message', 'Số lượng tổ phải từ 1 đến 8.'
        );
    end if;

    -- Same explicit ownership check as above (SECURITY DEFINER bypasses RLS).
    if not exists (
        select 1 from public.classes c
         where c.id = p_class_id
           and c.user_id = v_teacher_id
    ) then
        return jsonb_build_object(
            'success', false,
            'code',    'NOT_FOUND',
            'message', 'Lớp học không tồn tại hoặc bạn không có quyền.'
        );
    end if;

    -- Round-robin over a RANKED list. Assigning `rank % n + 1` gives group sizes
    -- that differ by at most 1 for ANY member count — 13 members over 4 groups
    -- become 4/3/3/3 — which is exactly the balance guarantee Step 43 asserts.
    --
    -- `case when p_randomize then random() end` (no ELSE) yields NULL for every
    -- row when randomising is off; NULLs compare equal, so the sort falls
    -- through to `full_name` — i.e. "chia theo thứ tự danh sách" is a plain
    -- alphabetical split, and the same class always splits the same way.
    -- `id` is the final tie-break so two identically-named students still get a
    -- deterministic order.
    with ordered_members as (
        select cm.id,
               row_number() over (
                   order by case when p_randomize then random() end,
                            cm.full_name asc,
                            cm.id asc
               ) - 1 as row_idx
          from public.class_members cm
         where cm.class_id = p_class_id
    ),
    assignments as (
        select om.id,
               ((om.row_idx % p_num_groups) + 1)::smallint as assigned_group
          from ordered_members om
    )
    update public.class_members cm
       set group_number = a.assigned_group
      from assignments a
     where cm.id = a.id;

    -- ROW_COUNT after a joined UPDATE is the number of rows actually written.
    get diagnostics v_total_assigned = row_count;

    return jsonb_build_object(
        'success',        true,
        'class_id',       p_class_id,
        'total_assigned', v_total_assigned,
        'num_groups',     p_num_groups
    );
end;
$$;

comment on function public.auto_balance_class_groups(uuid, int, boolean) is
    'Teacher-only: re-partition a class into 1..8 balanced groups, randomly or in name order. Group sizes differ by at most 1 (Phase 8.11).';


-- ============================================================================
-- SECTION D — EXECUTE GRANTS
-- ----------------------------------------------------------------------------
-- RPCs are the ONLY surface exposed to students (anon). Tables stay revoked.
-- ============================================================================
-- Phase 6.1: the 6-arg signature was DROPPED and replaced by the 7-arg one that
-- adds p_pin. These lines must use the NEW signature — `revoke ... on function`
-- raises "function ... does not exist" for a stale one, which would abort this
-- entire script.
revoke all on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar)   from public;
revoke all on function public.record_student_heartbeat(varchar, varchar, uuid, integer, integer, integer, integer) from public;
revoke all on function public.get_student_exam_payload(varchar, uuid)                                      from public;
revoke all on function public.submit_exam_result(varchar, varchar, uuid, jsonb, jsonb)                     from public;
revoke all on function public.record_proctoring_snapshot(varchar, varchar, uuid, text)                     from public;
revoke all on function public.get_certificate_verification(uuid)                                          from public;
revoke all on function public.verify_student_practice(varchar, varchar, varchar)                           from public;
-- Phase 8.9 — student-facing class pick-list for personal-.docx practice.
revoke all on function public.get_public_practice_classes()                                               from public;
revoke all on function public.update_exam_questions_safe(varchar, jsonb)                                   from public;
revoke all on function public.grade_exam_answers(uuid, jsonb)                                              from public;
revoke all on function public.delete_exam(varchar)                                                         from public;
revoke all on function public.restore_exam(varchar)                                                        from public;
revoke all on function public.purge_expired_exams()                                                        from public;
revoke all on function public.recalculate_exam_scores(varchar)                                             from public;
revoke all on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar)                   from public;
-- Phase 6.3 / 8.1 — student-facing. Returns a sanitised roster (no pin/dob);
-- `p_for_practice=true` also serves a practice-enabled exam that is closed.
revoke all on function public.get_exam_roster(varchar, boolean)                                          from public;
-- Phase 7.1 — student-facing write path for the tree activity.
revoke all on function public.submit_tree_answer(uuid, varchar, varchar, text)                            from public;
-- Phase 7.4 — student-facing check-in read for the tree activity. Phase 9.1 moved
-- it from the uuid to a (code, student_code) signature, so it is dropped and
-- re-created above.
revoke all on function public.get_public_tree_session(varchar, varchar)                                   from public;
-- Phase 9.1 — teacher-only lobby transition. The `from anon` revoke is REQUIRED:
-- Supabase's database default privileges grant EXECUTE to `anon` directly, and an
-- explicit grant survives a `revoke ... from public`, which would let a student
-- start the bout.
revoke all on function public.start_tree_session(uuid)                                                    from public;
revoke all on function public.start_tree_session(uuid)                                                    from anon;
-- Phase 7.1 — RLS predicate helper, needs EXECUTE from the policy's role.
revoke all on function public.tree_session_is_public(uuid)                                                from public;
-- Phase 8.11 — teacher-only group management. The `from anon` revoke is REQUIRED
-- for the same reason as import_class_to_exam below: Supabase's database default
-- privileges grant EXECUTE to `anon` directly, and an explicit grant survives a
-- `revoke ... from public`.
revoke all on function public.update_class_member_group(uuid, int)                                        from public;
revoke all on function public.update_class_member_group(uuid, int)                                        from anon;
revoke all on function public.auto_balance_class_groups(uuid, int, boolean)                               from public;
revoke all on function public.auto_balance_class_groups(uuid, int, boolean)                               from anon;
-- Phase 11.0 — public RPC for client-side proctoring violation logs.
revoke all on function public.log_exam_violation(varchar, varchar, varchar, text, jsonb)                   from public;

grant execute on function public.verify_and_acquire_session(varchar, varchar, varchar, varchar, text, uuid, varchar)   to anon, authenticated;
grant execute on function public.record_student_heartbeat(varchar, varchar, uuid, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.get_student_exam_payload(varchar, uuid)                                      to anon, authenticated;
grant execute on function public.submit_exam_result(varchar, varchar, uuid, jsonb, jsonb)                     to anon, authenticated;
grant execute on function public.record_proctoring_snapshot(varchar, varchar, uuid, text)                     to anon, authenticated;
grant execute on function public.get_certificate_verification(uuid)                                           to anon, authenticated;
grant execute on function public.verify_student_practice(varchar, varchar, varchar)                             to anon, authenticated;
-- Phase 8.9 — anon by design: the SPA lists valid classes BEFORE the student has
-- an identity. Exposes class names only (no member/credential/result data).
grant execute on function public.get_public_practice_classes()                                                 to anon, authenticated;
-- Phase 5.8: student-facing, but the body gates on the exam roster + allow_practice.
grant execute on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar)                  to anon, authenticated;
-- Phase 6.3 / 8.1 — student-facing: the roster picker must work BEFORE the student
-- has an identity, so this is anon-executable by design.
grant execute on function public.get_exam_roster(varchar, boolean)                                             to anon, authenticated;
-- Phase 11.0 — anon-callable: students record anti-cheat violations during exam sitting.
grant execute on function public.log_exam_violation(varchar, varchar, varchar, text, jsonb)                        to anon, authenticated;
-- Phase 7.1 — student-facing. The similarity rules live inside the body, so a
-- caller cannot bypass them by touching the table (anon holds no table rights).
grant execute on function public.submit_tree_answer(uuid, varchar, varchar, text)                              to anon, authenticated;
-- Phase 7.4 — student-facing check-in read: the SPA must open a session link
-- BEFORE it has any identity, so this is anon-executable by design. It returns
-- no credentials (never pin/dob) and no answer content.
grant execute on function public.get_public_tree_session(varchar, varchar)                                    to anon, authenticated;
-- Phase 9.1 — teacher-only lobby transition (ownership re-checked in the body).
grant execute on function public.start_tree_session(uuid)                                                      to authenticated;
-- Phase 7.1 — required for the tree_submissions RLS policy to evaluate as anon.
-- It leaks only a boolean.
grant execute on function public.tree_session_is_public(uuid)                                                 to anon, authenticated;
-- Teacher-only: never exposed to anon (ownership is enforced inside the body).
grant execute on function public.update_exam_questions_safe(varchar, jsonb)                                    to authenticated;
grant execute on function public.delete_exam(varchar)                                                          to authenticated;
grant execute on function public.restore_exam(varchar)                                                         to authenticated;
-- Phase 11.2 — teacher-only live proctoring force submit.
revoke all on function public.proctor_force_submit_exam(varchar, varchar, text)                                from public;
revoke all on function public.proctor_force_submit_exam(varchar, varchar, text)                                from anon;
grant execute on function public.proctor_force_submit_exam(varchar, varchar, text)                             to authenticated;
grant execute on function public.purge_expired_exams()                                                         to authenticated;
grant execute on function public.recalculate_exam_scores(varchar)                                              to authenticated;
-- Phase 8.11 — teacher-only group management (ownership re-checked in the body).
grant execute on function public.update_class_member_group(uuid, int)                                          to authenticated;
grant execute on function public.auto_balance_class_groups(uuid, int, boolean)                                 to authenticated;
-- Phase 6.1 — teacher-only. The explicit `from anon` revoke is REQUIRED:
-- Supabase's database default privileges grant EXECUTE to `anon` directly, and an
-- explicit grant survives `revoke ... from public` (verified locally: after a
-- PUBLIC revoke, has_function_privilege('anon', ...) was still true).
--
-- Phase 8.5 hardening — the same `from anon` revoke is now applied to the five
-- PRE-EXISTING teacher-only RPCs below. They were only ever protected by their
-- internal auth.uid() body checks; a direct anon call would reach the function
-- and be refused there. Removing the grant makes the ACL match the documented
-- "teacher-only" intent, so the privilege table is no longer misleading.
revoke all on function public.import_class_to_exam(varchar, uuid[])                                          from public;
revoke all on function public.import_class_to_exam(varchar, uuid[])                                          from anon;
revoke all on function public.update_exam_questions_safe(varchar, jsonb)                                     from anon;
revoke all on function public.delete_exam(varchar)                                                           from anon;
revoke all on function public.restore_exam(varchar)                                                          from anon;
revoke all on function public.purge_expired_exams()                                                          from anon;
revoke all on function public.recalculate_exam_scores(varchar)                                               from anon;
grant execute on function public.import_class_to_exam(varchar, uuid[])                                       to authenticated;
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
--   tree_submissions-> live Tree of Knowledge growth (INSERT/UPDATE on submit)
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

    -- Phase 7.1 — every accepted fruit must reach the whole class live.
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tree_submissions'
    ) then
        alter publication supabase_realtime add table public.tree_submissions;
    end if;

    -- Phase 11.2 — Live Proctoring: stream audit log events to proctors
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'exam_audit_logs'
    ) then
        alter publication supabase_realtime add table public.exam_audit_logs;
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
alter table public.exam_audit_logs replica identity full;

-- Phase 7.1 — clients filter tree events by `session_id`, a non-key column, and
-- resubmissions arrive as UPDATEs. Without `full` those edits would be dropped.
alter table public.tree_submissions replica identity full;


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

-- ============================================================================
-- SECTION A.10 — TUG OF WAR ("KÉO CO TRI THỨC") ENGINE
-- ============================================================================

create table if not exists public.tug_of_war_sessions (
    id                   uuid primary key default gen_random_uuid(),
    user_id              uuid not null references auth.users(id) on delete cascade,
    class_id             uuid not null references public.classes(id) on delete cascade,
    exam_id              uuid not null references public.exams(id) on delete cascade,
    session_code         varchar(10) not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
    title                text not null,
    status               varchar(20) not null default 'LOBBY' check (status in ('LOBBY', 'ACTIVE', 'FINISHED')),
    blue_group_number    int not null check (blue_group_number between 1 and 8),
    red_group_number     int not null check (red_group_number between 1 and 8),
    blue_team_name       text not null default 'Đội Xanh',
    red_team_name        text not null default 'Đội Đỏ',
    question_count       int not null default 10 check (question_count > 0),
    duration_seconds     int not null default 120 check (duration_seconds >= 30),
    win_gap              int not null default 3 check (win_gap >= 0),
    freeze_seconds       int not null default 3 check (freeze_seconds >= 0),
    questions_pool       jsonb not null default '[]'::jsonb,
    blue_question_order  jsonb not null default '[]'::jsonb,
    red_question_order   jsonb not null default '[]'::jsonb,
    blue_current_idx     int not null default 0,
    red_current_idx      int not null default 0,
    blue_score           int not null default 0,
    red_score            int not null default 0,
    blue_frozen_until    timestamptz,
    red_frozen_until     timestamptz,
    joined_participants  jsonb not null default '{"blue": [], "red": []}'::jsonb,
    winner               varchar(10) check (winner in ('BLUE', 'RED', 'DRAW') or winner is null),
    started_at           timestamptz,
    ends_at              timestamptz,
    created_at           timestamptz not null default now()
);

create index if not exists idx_tug_of_war_sessions_class_id on public.tug_of_war_sessions (class_id);
create index if not exists idx_tug_of_war_sessions_user_id on public.tug_of_war_sessions (user_id);
create index if not exists idx_tug_of_war_sessions_status on public.tug_of_war_sessions (status);
create index if not exists idx_tug_of_war_sessions_code on public.tug_of_war_sessions (session_code);

alter table public.tug_of_war_sessions enable row level security;
alter table public.tug_of_war_sessions replica identity full;

drop policy if exists tug_of_war_sessions_teacher_all on public.tug_of_war_sessions;
create policy tug_of_war_sessions_teacher_all on public.tug_of_war_sessions
    for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

drop policy if exists tug_of_war_sessions_anon_read on public.tug_of_war_sessions;
create policy tug_of_war_sessions_anon_read on public.tug_of_war_sessions
    for select to anon
    using (true);

drop policy if exists tug_of_war_sessions_auth_read on public.tug_of_war_sessions;
create policy tug_of_war_sessions_auth_read on public.tug_of_war_sessions
    for select to authenticated
    using (true);

grant select on public.tug_of_war_sessions to anon, authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tug_of_war_sessions'
    ) then
        alter publication supabase_realtime add table public.tug_of_war_sessions;
    end if;
end $$;

create or replace function public.join_tug_of_war_lobby(
    p_session_code varchar,
    p_student_code varchar,
    p_preferred_team varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session           public.tug_of_war_sessions%rowtype;
    v_member            record;
    v_team              varchar(10);
    v_full_name         varchar(150);
    v_group_num         int;
    v_joined            jsonb;
    v_blue_participants jsonb;
    v_red_participants  jsonb;
    v_blue_count        int;
    v_red_count         int;
    v_clean_code        varchar(50);
begin
    if p_session_code is null or trim(p_session_code) = '' then
        return jsonb_build_object('success', false, 'code', 'INVALID_SESSION_CODE', 'message', 'Mã phiên không hợp lệ.');
    end if;

    v_clean_code := upper(trim(p_student_code));
    if v_clean_code is null or v_clean_code = '' then
        return jsonb_build_object('success', false, 'code', 'INVALID_STUDENT_CODE', 'message', 'Mã học sinh không hợp lệ.');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where session_code = upper(trim(p_session_code))
       for update;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    select cm.full_name, cm.group_number
      into v_member
      from public.class_members cm
     where cm.class_id = v_session.class_id
       and upper(trim(cm.student_code)) = v_clean_code
     limit 1;

    if found then
        v_full_name := v_member.full_name;
        v_group_num := v_member.group_number;
    else
        v_full_name := v_clean_code;
        v_group_num := null;
    end if;

    v_joined := coalesce(v_session.joined_participants, '{"blue": [], "red": []}'::jsonb);
    v_blue_participants := coalesce(v_joined->'blue', '[]'::jsonb);
    v_red_participants  := coalesce(v_joined->'red', '[]'::jsonb);

    if upper(trim(coalesce(p_preferred_team, ''))) in ('BLUE', 'RED') then
        v_team := upper(trim(p_preferred_team));
    elsif exists (select 1 from jsonb_array_elements(v_blue_participants) elem where upper(elem->>'student_code') = v_clean_code) then
        v_team := 'BLUE';
    elsif exists (select 1 from jsonb_array_elements(v_red_participants) elem where upper(elem->>'student_code') = v_clean_code) then
        v_team := 'RED';
    elsif v_group_num is not null and v_group_num = v_session.blue_group_number then
        v_team := 'BLUE';
    elsif v_group_num is not null and v_group_num = v_session.red_group_number then
        v_team := 'RED';
    else
        v_blue_count := jsonb_array_length(v_blue_participants);
        v_red_count  := jsonb_array_length(v_red_participants);
        if v_blue_count <= v_red_count then
            v_team := 'BLUE';
        else
            v_team := 'RED';
        end if;
    end if;

    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_blue_participants
      from jsonb_array_elements(v_blue_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_red_participants
      from jsonb_array_elements(v_red_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    if v_team = 'BLUE' then
        v_blue_participants := v_blue_participants || jsonb_build_object(
            'student_code', v_clean_code,
            'full_name', v_full_name,
            'group_number', v_group_num
        );
    else
        v_red_participants := v_red_participants || jsonb_build_object(
            'student_code', v_clean_code,
            'full_name', v_full_name,
            'group_number', v_group_num
        );
    end if;

    v_joined := jsonb_build_object('blue', v_blue_participants, 'red', v_red_participants);

    update public.tug_of_war_sessions
       set joined_participants = v_joined
     where id = v_session.id;

    return jsonb_build_object(
        'success', true,
        'session_id', v_session.id,
        'session_code', v_session.session_code,
        'assigned_team', v_team,
        'student_code', v_clean_code,
        'full_name', v_full_name,
        'group_number', v_group_num,
        'title', v_session.title,
        'status', v_session.status,
        'blue_team_name', v_session.blue_team_name,
        'red_team_name', v_session.red_team_name,
        'joined_participants', v_joined
    );
end;
$$;

revoke all on function public.join_tug_of_war_lobby(varchar, varchar, varchar) from public;
grant execute on function public.join_tug_of_war_lobby(varchar, varchar, varchar) to anon, authenticated;

create or replace function public.start_tug_of_war_session(
    p_session_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id uuid;
    v_session    public.tug_of_war_sessions%rowtype;
    v_now        timestamptz := now();
    v_ends_at    timestamptz;
begin
    v_teacher_id := auth.uid();
    if v_teacher_id is null then
        return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where id = p_session_id
       and user_id = v_teacher_id;

    if not found then
        return jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'message', 'Không tìm thấy phiên Kéo Co hoặc bạn không có quyền.');
    end if;

    if v_session.status <> 'LOBBY' then
        return jsonb_build_object('success', false, 'code', 'INVALID_STATE', 'message', 'Phiên thi đấu đã bắt đầu hoặc đã kết thúc.');
    end if;

    v_ends_at := v_now + make_interval(secs => v_session.duration_seconds);

    update public.tug_of_war_sessions
       set status     = 'ACTIVE',
           started_at = v_now,
           ends_at    = v_ends_at
     where id = p_session_id;

    return jsonb_build_object(
        'success',    true,
        'session_id', p_session_id,
        'status',     'ACTIVE',
        'started_at', v_now,
        'ends_at',    v_ends_at
    );
end;
$$;

revoke all on function public.start_tug_of_war_session(uuid) from public;
grant execute on function public.start_tug_of_war_session(uuid) to authenticated;

create or replace function public.submit_tug_of_war_answer(
    p_session_code varchar,
    p_team varchar,
    p_question_idx int,
    p_selected_option int,
    p_student_code varchar default 'BOARD'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_team             varchar(10);
    v_session          public.tug_of_war_sessions%rowtype;
    v_current_idx      int;
    v_pool_idx         int;
    v_question         jsonb;
    v_correct_option   int;
    v_is_correct       boolean;
    v_new_blue_score   int;
    v_new_red_score    int;
    v_new_blue_idx     int;
    v_new_red_idx      int;
    v_new_blue_frozen  timestamptz;
    v_new_red_frozen   timestamptz;
    v_status           varchar(20);
    v_winner           varchar(10);
    v_order            jsonb;
begin
    v_team := upper(trim(p_team));
    if v_team not in ('BLUE', 'RED') then
        return jsonb_build_object('success', false, 'code', 'INVALID_TEAM', 'message', 'Đội không hợp lệ (phải là BLUE hoặc RED).');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where session_code = upper(trim(p_session_code))
       for update;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên thi đấu không tồn tại.');
    end if;

    if v_session.status <> 'ACTIVE' then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_ACTIVE', 'message', 'Trận đấu chưa bắt đầu hoặc đã kết thúc.', 'status', v_session.status, 'winner', v_session.winner);
    end if;

    if v_session.ends_at is not null and now() > v_session.ends_at then
        v_winner := case
            when v_session.blue_score > v_session.red_score then 'BLUE'
            when v_session.red_score > v_session.blue_score then 'RED'
            else 'DRAW'
        end;
        update public.tug_of_war_sessions
           set status = 'FINISHED', winner = v_winner
         where id = v_session.id;

        return jsonb_build_object(
            'success', false,
            'code', 'SESSION_EXPIRED',
            'message', 'Hết thời gian thi đấu!',
            'status', 'FINISHED',
            'winner', v_winner,
            'blue_score', v_session.blue_score,
            'red_score', v_session.red_score
        );
    end if;

    if v_team = 'BLUE' and v_session.blue_frozen_until is not null and now() < v_session.blue_frozen_until then
        return jsonb_build_object(
            'success', false,
            'code', 'TEAM_FROZEN',
            'message', 'Đội Xanh đang bị đóng băng!',
            'frozen_until', v_session.blue_frozen_until,
            'remaining_ms', greatest(0, round(extract(epoch from (v_session.blue_frozen_until - now())) * 1000))
        );
    end if;

    if v_team = 'RED' and v_session.red_frozen_until is not null and now() < v_session.red_frozen_until then
        return jsonb_build_object(
            'success', false,
            'code', 'TEAM_FROZEN',
            'message', 'Đội Đỏ đang bị đóng băng!',
            'frozen_until', v_session.red_frozen_until,
            'remaining_ms', greatest(0, round(extract(epoch from (v_session.red_frozen_until - now())) * 1000))
        );
    end if;

    v_current_idx := case when v_team = 'BLUE' then v_session.blue_current_idx else v_session.red_current_idx end;

    if p_question_idx <> v_current_idx then
        return jsonb_build_object(
            'success', false,
            'code', 'STALE_QUESTION',
            'message', 'Câu hỏi đã được cập nhật!',
            'current_idx', v_current_idx
        );
    end if;

    if v_current_idx >= v_session.question_count then
        return jsonb_build_object(
            'success', false,
            'code', 'ALL_QUESTIONS_ANSWERED',
            'message', 'Đội đã hoàn thành hết các câu hỏi!'
        );
    end if;

    v_order := case when v_team = 'BLUE' then v_session.blue_question_order else v_session.red_question_order end;
    v_pool_idx := (v_order->>v_current_idx)::int;
    v_question := v_session.questions_pool->v_pool_idx;
    v_correct_option := coalesce((v_question->>'correct_option')::int, 0);

    v_is_correct := (p_selected_option = v_correct_option);
    v_new_blue_score := v_session.blue_score;
    v_new_red_score  := v_session.red_score;
    v_new_blue_idx   := v_session.blue_current_idx;
    v_new_red_idx    := v_session.red_current_idx;
    v_new_blue_frozen := v_session.blue_frozen_until;
    v_new_red_frozen  := v_session.red_frozen_until;
    v_status := v_session.status;
    v_winner := v_session.winner;

    if v_is_correct then
        if v_team = 'BLUE' then
            v_new_blue_score := v_new_blue_score + 1;
            v_new_blue_idx := v_new_blue_idx + 1;
        else
            v_new_red_score := v_new_red_score + 1;
            v_new_red_idx := v_new_red_idx + 1;
        end if;

        if v_session.win_gap > 0 and abs(v_new_blue_score - v_new_red_score) >= v_session.win_gap then
            v_status := 'FINISHED';
            v_winner := case when v_new_blue_score > v_new_red_score then 'BLUE' else 'RED' end;
        elsif (v_team = 'BLUE' and v_new_blue_idx >= v_session.question_count and v_new_blue_score > v_new_red_score)
           or (v_team = 'RED' and v_new_red_idx >= v_session.question_count and v_new_red_score > v_new_blue_score)
           or (v_new_blue_idx >= v_session.question_count and v_new_red_idx >= v_session.question_count) then
            v_status := 'FINISHED';
            v_winner := case
                when v_new_blue_score > v_new_red_score then 'BLUE'
                when v_new_red_score > v_new_blue_score then 'RED'
                else 'DRAW'
            end;
        end if;
    else
        if v_team = 'BLUE' then
            v_new_blue_idx := v_new_blue_idx + 1;
            v_new_blue_frozen := now() + make_interval(secs => v_session.freeze_seconds);
        else
            v_new_red_idx := v_new_red_idx + 1;
            v_new_red_frozen := now() + make_interval(secs => v_session.freeze_seconds);
        end if;

        if v_new_blue_idx >= v_session.question_count and v_new_red_idx >= v_session.question_count then
            v_status := 'FINISHED';
            v_winner := case
                when v_new_blue_score > v_new_red_score then 'BLUE'
                when v_new_red_score > v_new_blue_score then 'RED'
                else 'DRAW'
            end;
        end if;
    end if;

    update public.tug_of_war_sessions
       set blue_score = v_new_blue_score,
           red_score = v_new_red_score,
           blue_current_idx = v_new_blue_idx,
           red_current_idx = v_new_red_idx,
           blue_frozen_until = v_new_blue_frozen,
           red_frozen_until = v_new_red_frozen,
           status = v_status,
           winner = v_winner
     where id = v_session.id;

    return jsonb_build_object(
        'success', true,
        'is_correct', v_is_correct,
        'team', v_team,
        'blue_score', v_new_blue_score,
        'red_score', v_new_red_score,
        'blue_current_idx', v_new_blue_idx,
        'red_current_idx', v_new_red_idx,
        'blue_frozen_until', v_new_blue_frozen,
        'red_frozen_until', v_new_red_frozen,
        'status', v_status,
        'winner', v_winner
    );
end;
$$;

revoke all on function public.submit_tug_of_war_answer(varchar, varchar, int, int, varchar) from public;
grant execute on function public.submit_tug_of_war_answer(varchar, varchar, int, int, varchar) to anon, authenticated;

create or replace function public.get_tug_of_war_session(
    p_session_code varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session public.tug_of_war_sessions%rowtype;
    v_winner  varchar(10);
begin
    select * into v_session
      from public.tug_of_war_sessions
     where session_code = upper(trim(p_session_code))
        or id::text = lower(trim(p_session_code));

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên thi đấu không tồn tại.');
    end if;

    if v_session.status = 'ACTIVE' and v_session.ends_at is not null and now() > v_session.ends_at then
        v_winner := case
            when v_session.blue_score > v_session.red_score then 'BLUE'
            when v_session.red_score > v_session.blue_score then 'RED'
            else 'DRAW'
        end;
        update public.tug_of_war_sessions
           set status = 'FINISHED', winner = v_winner
         where id = v_session.id;
        v_session.status := 'FINISHED';
        v_session.winner := v_winner;
    end if;

    return jsonb_build_object(
        'success', true,
        'session', row_to_json(v_session)
    );
end;
$$;

revoke all on function public.get_tug_of_war_session(varchar) from public;
grant execute on function public.get_tug_of_war_session(varchar) to anon, authenticated;

-- ============================================================================
-- ADQS Exam v2 — Tug of War ("Kéo Co Tri Thức") Refinements (Phase 13.0)
-- Migration: 20261015020000_tug_of_war_v2_refinements.sql
--
-- Features:
-- 1. Add keybindings, blue_questions, red_questions, blue_controller, red_controller
-- 2. Single-Device Controller Lock in join_tug_of_war_lobby with reconnection token
-- 3. Teacher controller reset RPC reset_tug_of_war_controller
-- 4. Independent per-team question and option order evaluation in submit_tug_of_war_answer
-- ============================================================================

-- 1. Alter table columns
alter table public.tug_of_war_sessions
    add column if not exists keybindings jsonb not null default '{"blue": ["Q","W","A","S"], "red": ["O","P","K","L"]}'::jsonb,
    add column if not exists blue_questions jsonb not null default '[]'::jsonb,
    add column if not exists red_questions jsonb not null default '[]'::jsonb,
    add column if not exists blue_controller jsonb default null,
    add column if not exists red_controller jsonb default null;

-- 2. Drop existing join_tug_of_war_lobby signature to avoid overloading ambiguity
drop function if exists public.join_tug_of_war_lobby(varchar, varchar, varchar);
drop function if exists public.join_tug_of_war_lobby(varchar, varchar, varchar, varchar);

-- Re-create join_tug_of_war_lobby with controller lock
create or replace function public.join_tug_of_war_lobby(
    p_session_code varchar,
    p_student_code varchar,
    p_preferred_team varchar default null,
    p_controller_token varchar default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_session           public.tug_of_war_sessions%rowtype;
    v_member            record;
    v_team              varchar(10);
    v_full_name         varchar(150);
    v_group_num         int;
    v_joined            jsonb;
    v_blue_participants jsonb;
    v_red_participants  jsonb;
    v_blue_count        int;
    v_red_count         int;
    v_clean_code        varchar(50);
    v_target_controller jsonb;
    v_token             varchar(64);
begin
    if p_session_code is null or trim(p_session_code) = '' then
        return jsonb_build_object('success', false, 'code', 'INVALID_SESSION_CODE', 'message', 'Mã phiên không hợp lệ.');
    end if;

    v_clean_code := upper(trim(p_student_code));
    if v_clean_code is null or v_clean_code = '' then
        return jsonb_build_object('success', false, 'code', 'INVALID_STUDENT_CODE', 'message', 'Mã học sinh không hợp lệ.');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where session_code = upper(trim(p_session_code))
       for update;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    -- Look up student in class_members
    select cm.full_name, cm.group_number
      into v_member
      from public.class_members cm
     where cm.class_id = v_session.class_id
       and upper(trim(cm.student_code)) = v_clean_code
     limit 1;

    if found then
        v_full_name := v_member.full_name;
        v_group_num := v_member.group_number;
    else
        v_full_name := v_clean_code;
        v_group_num := null;
    end if;

    v_joined := coalesce(v_session.joined_participants, '{"blue": [], "red": []}'::jsonb);
    v_blue_participants := coalesce(v_joined->'blue', '[]'::jsonb);
    v_red_participants  := coalesce(v_joined->'red', '[]'::jsonb);

    -- Priority 1: Explicit preferred team ('BLUE' or 'RED')
    if upper(trim(coalesce(p_preferred_team, ''))) in ('BLUE', 'RED') then
        v_team := upper(trim(p_preferred_team));
    -- Priority 2: Student already in a team
    elsif exists (select 1 from jsonb_array_elements(v_blue_participants) elem where upper(elem->>'student_code') = v_clean_code) then
        v_team := 'BLUE';
    elsif exists (select 1 from jsonb_array_elements(v_red_participants) elem where upper(elem->>'student_code') = v_clean_code) then
        v_team := 'RED';
    -- Priority 3: Match group number
    elsif v_group_num is not null and v_group_num = v_session.blue_group_number then
        v_team := 'BLUE';
    elsif v_group_num is not null and v_group_num = v_session.red_group_number then
        v_team := 'RED';
    -- Priority 4: Balance team size
    else
        v_blue_count := jsonb_array_length(v_blue_participants);
        v_red_count  := jsonb_array_length(v_red_participants);
        if v_blue_count <= v_red_count then
            v_team := 'BLUE';
        else
            v_team := 'RED';
        end if;
    end if;

    -- Single-Device Controller Lock Verification
    if v_team = 'BLUE' then
        v_target_controller := v_session.blue_controller;
    else
        v_target_controller := v_session.red_controller;
    end if;

    if v_target_controller is not null and (v_target_controller->>'token') is not null then
        -- Check if current device holds the matching token (reconnection / reload recovery)
        if p_controller_token is not null and trim(p_controller_token) = (v_target_controller->>'token') then
            v_token := p_controller_token;
        else
            -- Another device has already claimed the controller role for this team!
            return jsonb_build_object(
                'success', false,
                'code', 'TEAM_SLOT_TAKEN',
                'message', 'Đội của bạn đã có thiết bị đại diện kết nối! Cả nhóm hãy cùng thảo luận và bấm trên thiết bị đó nhé.',
                'assigned_team', v_team,
                'controller', v_target_controller
            );
        end if;
    else
        -- Slot is free, assign controller role
        if p_controller_token is not null and trim(p_controller_token) <> '' then
            v_token := trim(p_controller_token);
        else
            v_token := md5(gen_random_uuid()::text);
        end if;
        if v_team = 'BLUE' then
            v_session.blue_controller := jsonb_build_object(
                'token', v_token,
                'student_code', v_clean_code,
                'full_name', v_full_name,
                'connected_at', now()
            );
        else
            v_session.red_controller := jsonb_build_object(
                'token', v_token,
                'student_code', v_clean_code,
                'full_name', v_full_name,
                'connected_at', now()
            );
        end if;
    end if;

    -- Update joined_participants lists
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_blue_participants
      from jsonb_array_elements(v_blue_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_red_participants
      from jsonb_array_elements(v_red_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    if v_team = 'BLUE' then
        v_blue_participants := v_blue_participants || jsonb_build_object(
            'student_code', v_clean_code,
            'full_name', v_full_name,
            'group_number', v_group_num
        );
    else
        v_red_participants := v_red_participants || jsonb_build_object(
            'student_code', v_clean_code,
            'full_name', v_full_name,
            'group_number', v_group_num
        );
    end if;

    v_joined := jsonb_build_object('blue', v_blue_participants, 'red', v_red_participants);

    update public.tug_of_war_sessions
       set joined_participants = v_joined,
           blue_controller = v_session.blue_controller,
           red_controller = v_session.red_controller
     where id = v_session.id;

    return jsonb_build_object(
        'success', true,
        'session_id', v_session.id,
        'session_code', v_session.session_code,
        'assigned_team', v_team,
        'controller_token', v_token,
        'is_controller', true,
        'student_code', v_clean_code,
        'full_name', v_full_name,
        'group_number', v_group_num,
        'title', v_session.title,
        'status', v_session.status,
        'blue_team_name', v_session.blue_team_name,
        'red_team_name', v_session.red_team_name,
        'blue_controller', v_session.blue_controller,
        'red_controller', v_session.red_controller,
        'joined_participants', v_joined
    );
end;
$$;

revoke all on function public.join_tug_of_war_lobby(varchar, varchar, varchar, varchar) from public;
grant execute on function public.join_tug_of_war_lobby(varchar, varchar, varchar, varchar) to anon, authenticated;

-- 3. Teacher Reset Controller RPC: reset_tug_of_war_controller
create or replace function public.reset_tug_of_war_controller(
    p_session_id uuid,
    p_team varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_teacher_id uuid := auth.uid();
    v_team varchar(10) := upper(trim(p_team));
    v_session public.tug_of_war_sessions%rowtype;
begin
    if v_teacher_id is null then
        return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED', 'message', 'Yêu cầu đăng nhập giáo viên.');
    end if;

    if v_team not in ('BLUE', 'RED') then
        return jsonb_build_object('success', false, 'code', 'INVALID_TEAM', 'message', 'Đội không hợp lệ (phải là BLUE hoặc RED).');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where id = p_session_id and user_id = v_teacher_id
       for update;

    if not found then
        return jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'message', 'Không tìm thấy phiên Kéo Co hoặc bạn không có quyền.');
    end if;

    if v_team = 'BLUE' then
        update public.tug_of_war_sessions
           set blue_controller = null
         where id = p_session_id;
    else
        update public.tug_of_war_sessions
           set red_controller = null
         where id = p_session_id;
    end if;

    return jsonb_build_object(
        'success', true,
        'session_id', p_session_id,
        'team', v_team,
        'reset_team', v_team,
        'message', 'Đã đặt lại thiết bị đại diện cho ' || case when v_team = 'BLUE' then 'Đội Xanh' else 'Đội Đỏ' end
    );
end;
$$;

revoke all on function public.reset_tug_of_war_controller(uuid, varchar) from public;
grant execute on function public.reset_tug_of_war_controller(uuid, varchar) to authenticated;

-- 4. Update submit_tug_of_war_answer to check blue_questions / red_questions independently
create or replace function public.submit_tug_of_war_answer(
    p_session_code varchar,
    p_team varchar,
    p_question_idx int,
    p_selected_option int,
    p_student_code varchar default 'BOARD'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_team             varchar(10);
    v_session          public.tug_of_war_sessions%rowtype;
    v_current_idx      int;
    v_pool_idx         int;
    v_question         jsonb;
    v_correct_option   int;
    v_is_correct       boolean;
    v_new_blue_score   int;
    v_new_red_score    int;
    v_new_blue_idx     int;
    v_new_red_idx      int;
    v_new_blue_frozen  timestamptz;
    v_new_red_frozen   timestamptz;
    v_status           varchar(20);
    v_winner           varchar(10);
    v_order            jsonb;
begin
    v_team := upper(trim(p_team));
    if v_team not in ('BLUE', 'RED') then
        return jsonb_build_object('success', false, 'code', 'INVALID_TEAM', 'message', 'Đội không hợp lệ (phải là BLUE hoặc RED).');
    end if;

    select * into v_session
      from public.tug_of_war_sessions
     where session_code = upper(trim(p_session_code))
       for update;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên thi đấu không tồn tại.');
    end if;

    if v_session.status <> 'ACTIVE' then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_ACTIVE', 'message', 'Trận đấu chưa bắt đầu hoặc đã kết thúc.', 'status', v_session.status, 'winner', v_session.winner);
    end if;

    -- Check session duration expiry
    if v_session.ends_at is not null and now() > v_session.ends_at then
        v_winner := case
            when v_session.blue_score > v_session.red_score then 'BLUE'
            when v_session.red_score > v_session.blue_score then 'RED'
            else 'DRAW'
        end;
        update public.tug_of_war_sessions
           set status = 'FINISHED', winner = v_winner
         where id = v_session.id;

        return jsonb_build_object(
            'success', false,
            'code', 'SESSION_EXPIRED',
            'message', 'Hết thời gian thi đấu!',
            'status', 'FINISHED',
            'winner', v_winner,
            'blue_score', v_session.blue_score,
            'red_score', v_session.red_score
        );
    end if;

    -- Check team frozen status
    if v_team = 'BLUE' and v_session.blue_frozen_until is not null and now() < v_session.blue_frozen_until then
        return jsonb_build_object(
            'success', false,
            'code', 'TEAM_FROZEN',
            'message', 'Đội Xanh đang bị đóng băng!',
            'frozen_until', v_session.blue_frozen_until,
            'remaining_ms', greatest(0, round(extract(epoch from (v_session.blue_frozen_until - now())) * 1000))
        );
    end if;

    if v_team = 'RED' and v_session.red_frozen_until is not null and now() < v_session.red_frozen_until then
        return jsonb_build_object(
            'success', false,
            'code', 'TEAM_FROZEN',
            'message', 'Đội Đỏ đang bị đóng băng!',
            'frozen_until', v_session.red_frozen_until,
            'remaining_ms', greatest(0, round(extract(epoch from (v_session.red_frozen_until - now())) * 1000))
        );
    end if;

    v_current_idx := case when v_team = 'BLUE' then v_session.blue_current_idx else v_session.red_current_idx end;

    -- Prevent race conditions / duplicate taps on previous question
    if p_question_idx <> v_current_idx then
        return jsonb_build_object(
            'success', false,
            'code', 'STALE_QUESTION',
            'message', 'Câu hỏi đã được cập nhật!',
            'current_idx', v_current_idx
        );
    end if;

    if v_current_idx >= v_session.question_count then
        return jsonb_build_object(
            'success', false,
            'code', 'ALL_QUESTIONS_ANSWERED',
            'message', 'Đội đã hoàn thành hết các câu hỏi!'
        );
    end if;

    -- Retrieve question item and correct_option
    -- 1. Check if independent per-team questions exist
    if v_team = 'BLUE' and v_session.blue_questions is not null and jsonb_array_length(v_session.blue_questions) > v_current_idx then
        v_question := v_session.blue_questions->v_current_idx;
        v_correct_option := coalesce((v_question->>'correct_option')::int, 0);
    elsif v_team = 'RED' and v_session.red_questions is not null and jsonb_array_length(v_session.red_questions) > v_current_idx then
        v_question := v_session.red_questions->v_current_idx;
        v_correct_option := coalesce((v_question->>'correct_option')::int, 0);
    else
        -- Fallback to questions_pool with blue/red_question_order
        v_order := case when v_team = 'BLUE' then v_session.blue_question_order else v_session.red_question_order end;
        v_pool_idx := (v_order->>v_current_idx)::int;
        v_question := v_session.questions_pool->v_pool_idx;
        v_correct_option := coalesce((v_question->>'correct_option')::int, 0);
    end if;

    v_is_correct := (p_selected_option = v_correct_option);
    v_new_blue_score := v_session.blue_score;
    v_new_red_score  := v_session.red_score;
    v_new_blue_idx   := v_session.blue_current_idx;
    v_new_red_idx    := v_session.red_current_idx;
    v_new_blue_frozen := v_session.blue_frozen_until;
    v_new_red_frozen  := v_session.red_frozen_until;
    v_status := v_session.status;
    v_winner := v_session.winner;

    if v_is_correct then
        if v_team = 'BLUE' then
            v_new_blue_score := v_new_blue_score + 1;
            v_new_blue_idx := v_new_blue_idx + 1;
        else
            v_new_red_score := v_new_red_score + 1;
            v_new_red_idx := v_new_red_idx + 1;
        end if;

        -- Win gap condition
        if v_session.win_gap > 0 and abs(v_new_blue_score - v_new_red_score) >= v_session.win_gap then
            v_status := 'FINISHED';
            v_winner := case when v_new_blue_score > v_new_red_score then 'BLUE' else 'RED' end;
        -- Completion condition
        elsif (v_team = 'BLUE' and v_new_blue_idx >= v_session.question_count and v_new_blue_score > v_new_red_score)
           or (v_team = 'RED' and v_new_red_idx >= v_session.question_count and v_new_red_score > v_new_blue_score)
           or (v_new_blue_idx >= v_session.question_count and v_new_red_idx >= v_session.question_count) then
            v_status := 'FINISHED';
            v_winner := case
                when v_new_blue_score > v_new_red_score then 'BLUE'
                when v_new_red_score > v_new_blue_score then 'RED'
                else 'DRAW'
            end;
        end if;
    else
        -- Wrong answer penalty
        if v_team = 'BLUE' then
            v_new_blue_idx := v_new_blue_idx + 1;
            v_new_blue_frozen := now() + make_interval(secs => v_session.freeze_seconds);
        else
            v_new_red_idx := v_new_red_idx + 1;
            v_new_red_frozen := now() + make_interval(secs => v_session.freeze_seconds);
        end if;

        if v_new_blue_idx >= v_session.question_count and v_new_red_idx >= v_session.question_count then
            v_status := 'FINISHED';
            v_winner := case
                when v_new_blue_score > v_new_red_score then 'BLUE'
                when v_new_red_score > v_new_blue_score then 'RED'
                else 'DRAW'
            end;
        end if;
    end if;

    update public.tug_of_war_sessions
       set blue_score = v_new_blue_score,
           red_score = v_new_red_score,
           blue_current_idx = v_new_blue_idx,
           red_current_idx = v_new_red_idx,
           blue_frozen_until = v_new_blue_frozen,
           red_frozen_until = v_new_red_frozen,
           status = v_status,
           winner = v_winner
     where id = v_session.id;

    return jsonb_build_object(
        'success', true,
        'is_correct', v_is_correct,
        'team', v_team,
        'blue_score', v_new_blue_score,
        'red_score', v_new_red_score,
        'blue_current_idx', v_new_blue_idx,
        'red_current_idx', v_new_red_idx,
        'blue_frozen_until', v_new_blue_frozen,
        'red_frozen_until', v_new_red_frozen,
        'status', v_status,
        'winner', v_winner
    );
end;
$$;

revoke all on function public.submit_tug_of_war_answer(varchar, varchar, int, int, varchar) from public;
grant execute on function public.submit_tug_of_war_answer(varchar, varchar, int, int, varchar) to anon, authenticated;

