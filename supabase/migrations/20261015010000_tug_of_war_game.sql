-- ============================================================================
-- ADQS Exam v2 — Tug of War ("Kéo Co Tri Thức") Schema & Engine
-- Migration: 20261015010000_tug_of_war_game.sql
-- ============================================================================

-- 1. Table: public.tug_of_war_sessions
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

-- Indices
create index if not exists idx_tug_of_war_sessions_class_id on public.tug_of_war_sessions (class_id);
create index if not exists idx_tug_of_war_sessions_user_id on public.tug_of_war_sessions (user_id);
create index if not exists idx_tug_of_war_sessions_status on public.tug_of_war_sessions (status);
create index if not exists idx_tug_of_war_sessions_code on public.tug_of_war_sessions (session_code);

-- Enable RLS
alter table public.tug_of_war_sessions enable row level security;
alter table public.tug_of_war_sessions replica identity full;

-- RLS Policies
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

-- Add to Realtime publication
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tug_of_war_sessions'
    ) then
        alter publication supabase_realtime add table public.tug_of_war_sessions;
    end if;
end $$;

-- 2. RPC: join_tug_of_war_lobby
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

    -- Priority 1: If preferred_team is explicitly requested ('BLUE' or 'RED')
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

    -- Remove existing occurrence from both lists
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_blue_participants
      from jsonb_array_elements(v_blue_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_red_participants
      from jsonb_array_elements(v_red_participants) elem
     where upper(elem->>'student_code') <> v_clean_code;

    -- Insert into chosen team
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

-- 3. RPC: start_tug_of_war_session
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

-- 4. RPC: submit_tug_of_war_answer
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

    -- Retrieve question item
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

-- 5. RPC: get_tug_of_war_session
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
