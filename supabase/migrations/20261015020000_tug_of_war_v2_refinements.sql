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
