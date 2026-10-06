-- ============================================================================
-- PHASE 8.7 — per-exam question-shuffle toggle + TRUE_FALSE partitioning
-- ----------------------------------------------------------------------------
-- WHY
--   Two related gaps:
--
--   1. The teacher had no way to say "do NOT reorder my paper". The official
--      sitting ALWAYS shuffled question order client-side (Phase 5.8), which is
--      wrong for exams whose numbering is meaningful (a reading passage that
--      refers to "the text above", a deliberately sequenced derivation).
--
--   2. TRUE_FALSE questions were shuffled into the middle of the paper like any
--      other type. In practice that is hostile: a TRUE_FALSE item is a block of
--      four sub-statements that needs more room and more reading time, and
--      scattering them through the MCQ run breaks the student's rhythm. They are
--      now grouped and pushed to the END of every shuffled paper.
--
-- WHAT
--   * `exams.shuffle_questions BOOLEAN NOT NULL DEFAULT true` — the default is
--     `true` so every pre-existing exam keeps the behaviour it shipped with;
--     a NULL would make the client's `=== false` test ambiguous.
--   * `get_exam_roster` exposes the flag so the student picker knows the policy
--     before the paper is fetched.
--   * `get_student_exam_payload` exposes the flag too. This is REQUIRED, not
--     cosmetic: that RPC is the only source of `state.exam` for an official
--     sitting, so without it the SPA literally cannot honour the toggle.
--   * `get_practice_exam_payload` exposes it for the same reason (its `exam`
--     object feeds the practice run's metadata).
--
-- NOT NULL DEFAULT true is load-bearing
--   `alter table ... add column` with a NOT NULL DEFAULT backfills existing rows
--   in one pass, so there is no window in which a row reads NULL. The client
--   treats only an explicit `false` as "do not shuffle", so a NULL (had one been
--   possible) would have silently read as "shuffle" — the failure mode we want.
--
-- IDEMPOTENT
--   `add column if not exists` is a no-op on re-run. `drop function if exists`
--   followed by `create or replace` is re-runnable; the drop is required anyway
--   because replacing a function does NOT change its argument list, and dropping
--   it discards the ACL, which is why the revoke/grant pair is restated below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The column
-- ----------------------------------------------------------------------------
alter table public.exams
    add column if not exists shuffle_questions boolean not null default true;


-- ----------------------------------------------------------------------------
-- 2. get_exam_roster  (student — anon) — now returns `shuffle_questions`
--
--    Body is UNCHANGED from schema.sql §C.15 (Phase 8.1) apart from the added
--    return key: the empty-input guard and the `deleted_at` check are kept
--    deliberately, rather than adopting the shorter spec draft, so this
--    migration cannot silently relax an existing gate.
-- ----------------------------------------------------------------------------
drop function if exists public.get_exam_roster(varchar, boolean);

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
        'pin_mode',       v_exam.pin_mode,
        -- Lets the practice picker distinguish "closed" from "not open for
        -- practice" without a second round-trip.
        'allow_practice', v_exam.allow_practice,
        -- Phase 8.7 — the paper-ordering policy, so the picker can show it.
        'shuffle_questions', v_exam.shuffle_questions,
        'candidates',     coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_exam_roster(varchar, boolean) from public;
grant execute on function public.get_exam_roster(varchar, boolean) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. get_student_exam_payload  (student — anon) — expose `shuffle_questions`
--
--    Signature and question projection are UNCHANGED; only the `exam` object
--    gains one key. This is the source of `state.exam` for an official sitting,
--    so the SPA needs it to decide whether to shuffle at all.
--
--    The sanitised projection (no `correct_answer`, no `explanation`, no
--    sub-question keys) is untouched — the added key describes the PAPER, not
--    any answer.
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

revoke all on function public.get_student_exam_payload(varchar, uuid) from public;
grant execute on function public.get_student_exam_payload(varchar, uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_practice_exam_payload  (student — anon) — expose `shuffle_questions`
--
--    Same reasoning as §3: the practice run reads its metadata from this `exam`
--    object. Note the practice DISPLAY order is still the student's own toggle
--    (Phase 5.9), not this flag — the flag is surfaced as context only.
-- ----------------------------------------------------------------------------
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

revoke all on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar) from public;
grant execute on function public.get_practice_exam_payload(varchar, varchar, varchar, varchar) to anon, authenticated;
