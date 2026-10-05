-- ============================================================================
-- PHASE 7.4 — get_public_tree_session (public, anon)
-- ----------------------------------------------------------------------------
-- The student SPA opens a Tree of Knowledge session from a link
-- (`?session=<id>` / `?tree=<id>`) and must render a check-in screen before it
-- can do anything else: the session's question, its word minimum and the class's
-- roster to pick a name from.
--
-- `tree_sessions` and `class_members` are both unreadable to `anon` (Section B
-- revokes every table privilege), so this ONE SECURITY DEFINER read RPC supplies
-- the check-in payload without opening the tables.
--
-- WHAT IT RETURNS
--   { success: true, session: { id, title, question_text, min_words,
--                               time_limit_minutes, tree_seed, created_at },
--     class_name, total_students, candidates: [ { student_code, full_name } ] }
--   or { success: false, code, message }
--   Codes: SESSION_NOT_FOUND / SESSION_INACTIVE / SESSION_EXPIRED
--
-- WHY `tree_seed` IS SAFE TO EXPOSE: it is not a credential. It is the input the
-- deterministic renderer uses so every client draws the SAME tree; publishing it
-- is the whole mechanism, and it reveals nothing about other students' answers.
--
-- WHAT IT MUST NEVER RETURN: `pin` and `dob`, exactly like `get_exam_roster`.
-- Both are credentials (dob is the DDMM fallback PIN), so the candidate
-- projection is written as two EXPLICIT keys — never `cm.*` — and Step 31 asserts
-- the absence of both keys rather than trusting the projection to stay correct.
--
-- ACCESS MODEL / ACCEPTED TRADE-OFF
--   This is the second anon RPC that answers BEFORE the caller proves identity
--   (`get_exam_roster` is the first). Unavoidable: the check-in picker exists so
--   the student can find their own name. Anyone holding a live session UUID can
--   therefore enumerate that class's names + codes. Mitigations mirror 6.3: a
--   session UUID is 122 bits of entropy (not enumerable), it is distributed
--   out-of-band as a QR code, and a closed/expired session refuses outright. The
--   exposure is names + codes only — no secrets, and no answer content.
--
-- IDEMPOTENT: `create or replace` with an UNCHANGED signature (uuid -> jsonb), so
-- there is no stale-overload hazard (contrast Phase 6.1's added `p_pin`). The
-- revoke/grant pair is safe to re-run.
-- ============================================================================

begin;

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
    v_candidates     jsonb;
begin
    -- A NULL id must not fall through to a scan of every session.
    if p_session_id is null then
        return jsonb_build_object(
            'success', false,
            'code',    'SESSION_NOT_FOUND',
            'message', 'Phiên hoạt động không tồn tại.'
        );
    end if;

    -- 1. The session must exist and still be joinable.
    select s.id, s.title, s.question_text, s.min_words, s.time_limit_minutes,
           s.tree_seed, s.is_active, s.created_at, s.class_id
      into v_session
      from public.tree_sessions s
     where s.id = p_session_id;

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'SESSION_NOT_FOUND',
            'message', 'Phiên hoạt động không tồn tại.'
        );
    end if;

    -- 1.a Teacher closed the activity early (Phase 7.3's "Kết thúc hoạt động").
    if v_session.is_active is not true then
        return jsonb_build_object(
            'success', false,
            'code',    'SESSION_INACTIVE',
            'message', 'Phiên hoạt động đã kết thúc.'
        );
    end if;

    -- 1.b Time limit. Mirrors submit_tree_answer's own window check so the
    --     check-in screen cannot accept a student the write path would refuse.
    if now() > v_session.created_at + make_interval(mins => v_session.time_limit_minutes) then
        return jsonb_build_object(
            'success', false,
            'code',    'SESSION_EXPIRED',
            'message', 'Phiên hoạt động đã hết thời gian.'
        );
    end if;

    -- 2. Class name and size. `N` is the participation denominator the renderer
    --    divides by; the LEFT JOIN keeps a (hypothetical) memberless class from
    --    dropping the row entirely, and the count then reads 0.
    select c.name, count(cm.id)::integer
      into v_class_name, v_total_students
      from public.classes c
      left join public.class_members cm on cm.class_id = c.id
     where c.id = v_session.class_id
     group by c.id, c.name;

    -- 3. Candidates — `student_code` + `full_name` ONLY. `pin`/`dob` are
    --    credentials and must never appear in this payload.
    select jsonb_agg(
               jsonb_build_object(
                   'student_code', cm.student_code,
                   'full_name',    cm.full_name
               )
               order by cm.student_code asc
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
        -- Floor at 1: the client divides participation by this, so 0 would make
        -- the ratio Infinity/NaN on an empty roster.
        'total_students', greatest(coalesce(v_total_students, 0), 1),
        -- An empty roster is NOT an error: the SPA still shows the question and
        -- lets the student fall back to typing their identity.
        'candidates', coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

revoke all on function public.get_public_tree_session(uuid) from public;
grant execute on function public.get_public_tree_session(uuid) to anon, authenticated;

comment on function public.get_public_tree_session(uuid) is
    'Phase 7.4: check-in payload for a tree session (question, word minimum, tree_seed, class size + sanitised candidate list). Never returns pin or dob.';

commit;
