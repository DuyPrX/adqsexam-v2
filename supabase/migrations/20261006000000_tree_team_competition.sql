-- ============================================================================
-- PHASE 8.4 — 4-TEAM COMPETITION ARENA
-- ----------------------------------------------------------------------------
-- Upgrades the Tree of Knowledge from one class-wide tree into a four-team
-- competition (Tổ 1..Tổ 4). A class roster row now carries a `team_number`;
-- each accepted answer records the author's team, so the projector can render
-- four trees side by side and the student SPA can render only its own team's.
--
-- THREE CHANGES
--   1. `team_number smallint not null default 1 check (between 1 and 4)` on
--      `class_members`, `students` and `tree_submissions`, plus a
--      `(session_id, team_number)` index for the projector's per-team filter.
--   2. `get_public_tree_session` now returns each candidate's `team_number`
--      and a `team_counts` breakdown `{ "1": n1, ... "4": n4 }` so the SPA can
--      compute a per-team participation denominator.
--   3. `submit_tree_answer` looks the author's team up in `class_members` and
--      records it, with a deterministic round-robin fallback for a student who
--      is not on the roster.
--
-- SIGNATURE SAFETY
--   `create or replace function` matches on the ARGUMENT SIGNATURE. Neither of
--   the two functions below changes its parameter list, so both are supplied
--   with an explicit `drop function if exists <same signature>` first. That is
--   belt-and-braces here (the signature is identical, so `create or replace`
--   alone would suffice) but it keeps this migration safe to re-run and matches
--   the Phase 6.1 / 8.1 discipline that every changed function is dropped first.
--   The revoke/grant pair therefore targets the SAME signatures as before.
--
-- DRAFT CORRECTIONS (the supplied Phase 8.4 SQL was wrong in two places)
--   a. `submit_tree_answer`'s draft returned `v_next_fruit_index` (computed as
--      max+1 BEFORE the insert). On a RESUBMISSION the ON CONFLICT DO UPDATE
--      deliberately does NOT change `fruit_index`, so that value is wrong — the
--      fruit would appear to move. The existing Phase 7.1 contract returns the
--      row's real `fruit_index` via `returning id, fruit_index into ...`, which
--      Step 28f pins ("the edit keeps the original fruit_index"). That behaviour
--      is preserved here and only `team_number` is added to the upsert.
--   b. `team_counts` is built with an explicit `generate_series(1,4) as
--      g(team_num)` alias. The draft's bare `generate_series(1,4) team_num`
--      happens to resolve, but the explicit column alias removes any ambiguity
--      about which identifier names the series value.
--
-- IDEMPOTENT: `add column if not exists`, `create index if not exists`,
-- `drop function if exists` before each recreate, and `create or replace` for
-- the tables' defaults. Re-running logs only NOTICEs and exits 0.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. team_number columns
-- ----------------------------------------------------------------------------
alter table public.class_members
    add column if not exists team_number smallint not null default 1
    check (team_number between 1 and 4);

alter table public.students
    add column if not exists team_number smallint not null default 1
    check (team_number between 1 and 4);

alter table public.tree_submissions
    add column if not exists team_number smallint not null default 1
    check (team_number between 1 and 4);

comment on column public.class_members.team_number is
    'Competition team (Tổ) 1..4 for the Tree of Knowledge arena (Phase 8.4). Defaults to 1.';
comment on column public.tree_submissions.team_number is
    'Team the author belonged to when they submitted; drives per-team tree rendering (Phase 8.4).';

-- ----------------------------------------------------------------------------
-- 2. Per-team projection index
-- ----------------------------------------------------------------------------
-- The projector filters submissions by (session_id, team_number) for each of
-- its four trees; without this the filter is a full scan of the session.
create index if not exists idx_tree_submissions_session_team
    on public.tree_submissions (session_id, team_number);

-- ----------------------------------------------------------------------------
-- 3. get_public_tree_session — add team_number + team_counts
-- ----------------------------------------------------------------------------
drop function if exists public.get_public_tree_session(uuid);

create or replace function public.get_public_tree_session(
    p_session_id uuid
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
begin
    if p_session_id is null then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    select s.id, s.title, s.question_text, s.min_words, s.time_limit_minutes,
           s.tree_seed, s.is_active, s.created_at, s.class_id
      into v_session
      from public.tree_sessions s
     where s.id = p_session_id;

    if not found then
        return jsonb_build_object('success', false, 'code', 'SESSION_NOT_FOUND', 'message', 'Phiên hoạt động không tồn tại.');
    end if;

    if v_session.is_active is not true then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;

    if now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Phiên hoạt động đã hết thời gian.');
    end if;

    select c.name, count(cm.id)::integer
      into v_class_name, v_total_students
      from public.classes c
      left join public.class_members cm on cm.class_id = c.id
     where c.id = v_session.class_id
     group by c.id, c.name;

    -- Per-team class size. The generate_series guarantees all four keys exist,
    -- so the SPA never has to defend against a missing team.
    select coalesce(
               jsonb_object_agg(t.team_num::text, coalesce(t.cnt, 0)),
               '{"1":0,"2":0,"3":0,"4":0}'::jsonb
           )
      into v_team_counts
      from (
          select g.team_num, tc.cnt
            from generate_series(1, 4) as g(team_num)
            left join (
                select cm.team_number, count(*)::integer as cnt
                  from public.class_members cm
                 where cm.class_id = v_session.class_id
                 group by cm.team_number
            ) tc on tc.team_number = g.team_num
      ) t;

    -- `student_code` + `full_name` + `team_number` ONLY. `pin`/`dob` are
    -- credentials and must never appear in this payload.
    select jsonb_agg(
               jsonb_build_object(
                   'student_code', cm.student_code,
                   'full_name',    cm.full_name,
                   'team_number',  coalesce(cm.team_number, 1)
               )
               order by cm.team_number asc, cm.student_code asc
           )
      into v_candidates
      from public.class_members cm
     where cm.class_id = v_session.class_id;

    return jsonb_build_object(
        'success', true,
        'session', jsonb_build_object(
            'id',                 v_session.id,
            'title',              v_session.title,
            'question_text',      v_session.question_text,
            'min_words',          v_session.min_words,
            'time_limit_minutes', v_session.time_limit_minutes,
            'tree_seed',          v_session.tree_seed,
            'created_at',         v_session.created_at
        ),
        'class_name', v_class_name,
        'total_students', greatest(coalesce(v_total_students, 0), 1),
        'team_counts', coalesce(v_team_counts, '{"1":0,"2":0,"3":0,"4":0}'::jsonb),
        'candidates', coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_public_tree_session(uuid) from public;
grant execute on function public.get_public_tree_session(uuid) to anon, authenticated;

comment on function public.get_public_tree_session(uuid) is
    'Phase 7.4/8.4: check-in payload for a tree session (question, word minimum, tree_seed, class size + per-team counts + sanitised candidate list with team_number). Never returns pin or dob.';

-- ----------------------------------------------------------------------------
-- 4. submit_tree_answer — record the author's team
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
    -- Nullable on purpose: a NULL after the lookup means "not on the roster"
    -- (the column itself is NOT NULL, so it is always resolved before the insert).
    v_team_number       smallint;
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

    if v_session.is_active is not true then
        return jsonb_build_object('success', false, 'code', 'SESSION_INACTIVE', 'message', 'Phiên hoạt động đã kết thúc.');
    end if;

    if now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object('success', false, 'code', 'SESSION_EXPIRED', 'message', 'Đã hết thời gian làm bài.');
    end if;

    -- Phase 8.4 — resolve the author's team from the class roster.
    select cm.team_number
      into v_team_number
      from public.class_members cm
     where cm.class_id = v_session.class_id
       and cm.student_code = v_student_code
     limit 1;

    -- Not on the roster: assign a deterministic round-robin team from the
    -- number of answers already recorded, so a walk-in still lands somewhere
    -- sensible rather than always piling onto team 1.
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

    -- Similarity is checked across the ENTIRE session, so one team cannot copy
    -- another team's answer any more than a classmate's.
    select coalesce(max(extensions.similarity(s.answer_text, v_clean_text)), 0.0)
      into v_max_sim
      from public.tree_submissions s
     where s.session_id = p_session_id
       and s.student_code <> v_student_code;

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

    -- On resubmission fruit_index is NOT updated: the fruit keeps its place. The
    -- RETURNING clause reads the row's REAL fruit_index back, so the returned
    -- value is correct for both an insert and an update.
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

comment on function public.submit_tree_answer(uuid, varchar, varchar, text) is
    'Phase 7.1/8.4: the single write path for a tree activity. Validates the window, the word minimum and the cross-team similarity ceiling, then upserts the answer tagged with the author''s team_number.';

commit;
