-- ============================================================================
-- PHASE 9.1 — Tree Arena: lobby / QR waiting room, pre-flight roster config,
--             and game modes
-- ----------------------------------------------------------------------------
-- WHY
--   Phase 7/8.4 shipped a working 2x2 arena: a session is created and is
--   INSTANTLY submittable, with each Tổ's tree fed by `class_members.team_number`.
--   There is no "waiting room": students can answer before the teacher is ready,
--   a teacher cannot mark a student absent, and there is only one activity type
--   (open keyword brainstorm).
--
--   This phase adds the missing lobby vertical:
--     * a LOBBY -> ACTIVE -> FINISHED lifecycle (`status`) with an explicit
--       teacher `start_tree_session` transition,
--     * a pre-flight roster (`participant_config`: absent list + per-student team
--       overrides) so a session can be tuned before it opens,
--     * a short human-readable `session_code` for the projector PIN / QR,
--     * a `game_mode` (`BRAINSTORM` | `SPEED_QUIZ`) + `target_score`, so the
--       projector and SPA can branch.
--
-- SPEC DRIFT (adapted to the real schema, deliberately)
--   The task draft assumed columns and signatures that do not exist here:
--     * `session_code`, `prompt_question`, `duration_minutes`, `started_at`,
--       `ends_at`   -> the real table uses the session UUID as its join key, plus
--                      `question_text` / `time_limit_minutes` / `created_at` /
--                      `ended_at`.
--     * `status` as the ONLY submission gate -> `is_active boolean` is already the
--                      gate and is read by `endTreeSession`, the projector and ~6
--                      test sites. Replacing it outright would have been a
--                      breaking, high-blast-radius change for no functional gain.
--     * `submit_tree_answer(p_session_code, ...)` -> the real signature is
--                      `(p_session_id uuid, p_student_code, p_student_name,
--                        p_answer_text)`. Kept UNCHANGED (only the guards below
--                      are added): changing it would discard its ACL and break
--                      every existing caller for no benefit.
--
--   Decisions taken to stay ADDITIVE and non-regressing:
--     1. `status` is added alongside `is_active`, and the two are kept IN SYNC
--        (`start_tree_session` writes both; `endTreeSession` writes both). For
--        PRE-EXISTING rows `status` is backfilled from `is_active`, so a session
--        that was already open stays submittable — otherwise every historical
--        session would have silently become an un-startable LOBBY.
--     2. `session_code` is added as a NEW unique short code. `get_public_tree_session`
--        accepts EITHER the uuid (existing links) OR the code (new QR/PIN), so no
--        existing join link breaks.
--     3. `get_public_tree_session`'s signature DOES change (uuid -> varchar code +
--        `p_student_code`), because the student-aware lobby screen needs it and the
--        old 1-arg form would otherwise remain as an ambiguous overload. The old
--        function is dropped first — the documented pattern from migration
--        20261005130000 — and the caller sites were updated in the same change.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. tree_sessions — lifecycle, mode, roster config, PIN
-- ----------------------------------------------------------------------------
-- `status` is added INSIDE a DO block rather than with a bare `add column if not
-- exists`: `add column ... default 'LOBBY'` backfills every existing row to
-- 'LOBBY', which would strand sessions that are already under way. The guard lets
-- the corrective UPDATE run exactly once — on the first application — and keeps
-- the whole thing idempotent (and re-runnable) without a migration ledger.
do $$
begin
    if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'tree_sessions'
           and column_name = 'status'
    ) then
        alter table public.tree_sessions
            add column status varchar(20) not null default 'LOBBY';

        -- Backfill: a session that already exists predates the lobby, so it is
        -- already open (or already closed). Without this, every session created
        -- before this phase would refuse submissions with NOT_STARTED.
        update public.tree_sessions
           set status = case when is_active then 'ACTIVE' else 'FINISHED' end;
    end if;
end $$;

alter table public.tree_sessions add column if not exists game_mode varchar(20) not null default 'BRAINSTORM';
alter table public.tree_sessions add column if not exists exam_id uuid references public.exams (id) on delete set null;
alter table public.tree_sessions add column if not exists target_score integer not null default 20;
alter table public.tree_sessions add column if not exists participant_config jsonb not null default '{"absent_ids": [], "assignments": {}}'::jsonb;
alter table public.tree_sessions add column if not exists started_at timestamptz;
alter table public.tree_sessions add column if not exists ends_at timestamptz;

-- Short, human-readable join code for the projector PIN / QR. Backfilled from
-- md5(id): deterministic (so a re-run produces the same value) and distinct per
-- row. NEW rows get a volatile random default below.
alter table public.tree_sessions add column if not exists session_code varchar(12);
update public.tree_sessions
   set session_code = upper(substr(md5(id::text), 1, 6))
 where session_code is null;
alter table public.tree_sessions alter column session_code set default upper(substr(md5(gen_random_uuid()::text), 1, 6));
alter table public.tree_sessions alter column session_code set not null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'tree_sessions_status_check') then
        alter table public.tree_sessions add constraint tree_sessions_status_check
            check (status in ('LOBBY', 'ACTIVE', 'FINISHED'));
    end if;
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

comment on column public.tree_sessions.status is 'Lobby lifecycle: LOBBY (waiting room) -> ACTIVE -> FINISHED. Kept in sync with is_active (Phase 9.1).';
comment on column public.tree_sessions.session_code is 'Short human-readable join code shown as the projector PIN / QR payload (Phase 9.1).';
comment on column public.tree_sessions.participant_config is 'Pre-flight roster: {"absent_ids": [member uuid], "assignments": {member uuid: team 1..4}} (Phase 9.1).';
comment on column public.tree_sessions.game_mode is 'BRAINSTORM (open keyword) or SPEED_QUIZ (timed MCQ) (Phase 9.1).';
comment on column public.tree_sessions.target_score is 'Points a team must reach to win in SPEED_QUIZ (Phase 9.1).';


-- ----------------------------------------------------------------------------
-- 2. start_tree_session — the atomic LOBBY -> ACTIVE transition
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
    -- derived from the SAME `time_limit_minutes` the old created_at-anchored
    -- deadline used, so the clock does not jump when the teacher starts.
    v_ends_at := v_now + make_interval(mins => v_session.time_limit_minutes);

    -- `is_active` is written here too: it remains the gate `submit_tree_answer`
    -- has always enforced, and the two must never disagree.
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

revoke all on function public.start_tree_session(uuid) from public;
-- Supabase's database default privileges grant EXECUTE to `anon` DIRECTLY, so a
-- `revoke ... from public` alone would leave a student able to start the bout.
revoke all on function public.start_tree_session(uuid) from anon;
grant execute on function public.start_tree_session(uuid) to authenticated;

comment on function public.start_tree_session(uuid) is
    'Teacher-only: LOBBY -> ACTIVE, stamping started_at/ends_at and is_active (Phase 9.1).';


-- ----------------------------------------------------------------------------
-- 3. get_public_tree_session — student-aware, lobby-aware read
-- ----------------------------------------------------------------------------
-- The 1-arg uuid form is dropped first: adding a defaulted second parameter
-- creates a NEW signature, and leaving the old one would make a call that names
-- only `p_session_code` ambiguous ("function is not unique"). Dropping also
-- discards the ACL, so the grants are re-issued below.
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

    -- Per-team class size. generate_series guarantees all four keys exist, so the
    -- SPA never has to defend against a missing team.
    --
    -- Phase 9.1 — a student marked ABSENT is excluded from their team's
    -- denominator: they are spectating, so counting them would make a team's
    -- 100% unreachable. `participant_config.assignments` overrides a member's
    -- team, so the tally has to honour it too, or the projector would show a
    -- different split from the one the SPA resolves.
    v_config := coalesce(v_session.participant_config, '{"absent_ids": [], "assignments": {}}'::jsonb);

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
    -- leave the server here. `team_number` honours the pre-flight override, so
    -- the Tổ a student picks at check-in matches the one `team_counts` and the
    -- projector put them in.
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

revoke all on function public.get_public_tree_session(varchar, varchar) from public;
grant execute on function public.get_public_tree_session(varchar, varchar) to anon, authenticated;

comment on function public.get_public_tree_session(varchar, varchar) is
    'Student-facing read: accepts a session uuid OR its short session_code, plus an optional student_code to resolve team/absent state (Phase 7.4 / 8.4 / 9.1).';


-- ----------------------------------------------------------------------------
-- 4. submit_tree_answer — refuse a LOBBY session and an absent student
-- ----------------------------------------------------------------------------
-- The signature is UNCHANGED (see the header): only the gates below are added.
-- The existing is_active / expiry / min-words / similarity behaviour is kept
-- verbatim so every Phase 7/8.4 assertion still holds.
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

    -- Phase 9.1 — a student the teacher marked absent may not submit. Reported
    -- before the team fallback so an absentee gets a clear reason.
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

revoke all on function public.submit_tree_answer(uuid, varchar, varchar, text) from public;
grant execute on function public.submit_tree_answer(uuid, varchar, varchar, text) to anon, authenticated;
