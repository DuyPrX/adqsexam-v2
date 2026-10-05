-- ============================================================================
-- PHASE 6.3 — get_exam_roster (public, anon)
-- ----------------------------------------------------------------------------
-- The student SPA previously asked the candidate to TYPE their student code,
-- full name and class. Phase 6.1 introduced `pin_mode`, which makes that
-- unworkable: a GLOBAL/INDIVIDUAL exam expects the student to arrive already
-- identified. This RPC lets the SPA show a class + student picker once the exam
-- code is entered, so the identity it submits is exactly the roster row the
-- server will compare against.
--
-- WHAT IT RETURNS: the minimum needed to render the picker — `student_code`,
-- `full_name`, `class_name` — plus the exam title and `pin_mode` so the SPA can
-- decide whether to show the PIN field.
--
-- WHAT IT MUST NEVER RETURN: `pin` and `dob`. Both are exam credentials (dob is
-- the DDMM fallback PIN), so leaking either would hand an anonymous caller the
-- answer to the very gate this feature is about. The projection is written
-- explicitly as three keys — never `s.*` — and Step 27 asserts the absence of
-- both keys rather than trusting the projection to stay correct.
--
-- ACCESS MODEL / ACCEPTED TRADE-OFF
--   This is the ONE student RPC that returns data to a caller who has NOT yet
--   proved they belong to the roster (`get_practice_exam_payload` and
--   `verify_and_acquire_session` both require an identity first). That is
--   unavoidable: the picker exists precisely so the student can find their own
--   name. Anyone holding a live 6-digit exam code can therefore enumerate that
--   exam's names/codes/classes. Mitigations: the code space is 900k, codes are
--   short-lived and distributed out-of-band, and a trashed/closed/not-yet-open
--   exam refuses outright. The exposure is names + class only — no secrets.
--
-- IDEMPOTENT: `create or replace` with an UNCHANGED signature (varchar -> jsonb),
-- so no `drop function` is needed here. Contrast Phase 6.1, where adding `p_pin`
-- created an overload rather than a replacement. Re-running is a no-op.
-- ============================================================================

begin;

create or replace function public.get_exam_roster(
    p_exam_code varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam       public.exams%rowtype;
    v_candidates jsonb;
begin
    -- A blank code must not fall through to a full-table scan.
    if p_exam_code is null or trim(p_exam_code) = '' then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_NOT_FOUND',
            'message', 'Đề thi không tồn tại.'
        );
    end if;

    -- 1. Exam must exist and be visible to a student.
    select * into v_exam
      from public.exams
     where code = upper(trim(p_exam_code));

    if not found then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_NOT_FOUND',
            'message', 'Đề thi không tồn tại.'
        );
    end if;

    -- 1.a A trashed exam is indistinguishable from a missing one (Trash is a
    --     teacher-only concept; revealing it would leak that the code existed).
    --     Same code as a genuine miss, mirroring verify_and_acquire_session.
    if v_exam.deleted_at is not null then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_NOT_FOUND',
            'message', 'Đề thi không tồn tại.'
        );
    end if;

    -- 1.b Teacher open/close switch.
    if v_exam.is_active is not true then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_INACTIVE',
            'message', 'Đề thi hiện đang đóng.'
        );
    end if;

    -- 1.c Scheduling window. A NULL bound means "unbounded on that side".
    if v_exam.starts_at is not null and now() < v_exam.starts_at then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_NOT_STARTED',
            'message', 'Chưa đến giờ làm bài.'
        );
    end if;
    if v_exam.ends_at is not null and now() > v_exam.ends_at then
        return jsonb_build_object(
            'success', false,
            'code',    'EXAM_EXPIRED',
            'message', 'Đề thi đã kết thúc.'
        );
    end if;

    -- 2. Candidates — the three display keys ONLY. `pin` and `dob` are exam
    --    credentials and must never appear in this payload.
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

    -- An empty roster is NOT an error: the SPA falls back to manual entry.
    return jsonb_build_object(
        'success',    true,
        'exam_code',  v_exam.code,
        'title',      v_exam.title,
        'pin_mode',   v_exam.pin_mode,
        'candidates', coalesce(v_candidates, '[]'::jsonb)
    );
end;
$$;

-- The signature is unchanged from any previous run, so this is a plain
-- revoke/grant pair (no stale-signature hazard).
revoke all on function public.get_exam_roster(varchar) from public;
grant execute on function public.get_exam_roster(varchar) to anon, authenticated;

comment on function public.get_exam_roster(varchar) is
    'Phase 6.3: sanitised candidate list (student_code/full_name/class_name + pin_mode) so the student SPA can offer a class + name picker. Never returns pin or dob.';

commit;
