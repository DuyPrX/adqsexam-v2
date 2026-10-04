-- ============================================================================
-- PHASE 5.8 — PRACTICE-ENABLED EXAMS & PRACTICE-BY-CODE PAYLOAD
-- ----------------------------------------------------------------------------
-- Until now, self-practice (Phase 5.2) only worked by uploading a personal
-- .docx: the student's browser received the answer keys from the extraction
-- Worker, not from Supabase. That flow cannot serve a teacher-authored exam,
-- because the whole point of F1/F3 is that `question_bank.correct_answer` never
-- reaches the student runtime.
--
-- This migration adds an explicit, teacher-controlled door through that wall:
--
--   * `exams.allow_practice` — opt-in, default FALSE. A live exam used for a
--     real sitting therefore leaks nothing unless the teacher says so. Note the
--     default is what protects every existing exam: adding the column must not
--     silently make already-created exams practiceable.
--
--   * `get_practice_exam_payload()` — the ONLY path that hands out answer keys
--     for a stored exam. It returns questions in original `position ASC` order
--     together with `correct_answer` and `explanation`, and refuses unless
--     `allow_practice` is true.
--
-- Authorization gate (reuses the Phase 5.2 shape):
--   the caller must be ON THIS EXAM'S ROSTER (`students`), matched
--   case/whitespace-insensitively on student_code + class_name. Both parameters
--   are therefore meaningful, and a stranger who merely guesses a 6-digit code
--   cannot harvest the key even when the teacher enabled practice.
--
-- Deliberately NOT gated on `is_active` / the scheduling window: a teacher
-- closes an exam for the official sitting and may still want it practiceable
-- afterwards. Trashed exams ARE refused, to stay consistent with the Phase 5.5
-- rule that the Trash is invisible to students.
--
-- Idempotent: safe to re-run.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. The opt-in flag.
--    NOT NULL DEFAULT false matters: an existing exam must keep its current
--    (locked-down) behaviour after the migration.
-- ----------------------------------------------------------------------------
alter table public.exams
    add column if not exists allow_practice boolean not null default false;

comment on column public.exams.allow_practice is
    'Teacher opt-in (Phase 5.8): permits get_practice_exam_payload to return questions WITH answer keys to a rostered student.';


-- ----------------------------------------------------------------------------
-- 2. get_practice_exam_payload
--      Returns: { success: true, exam: {...}, questions: [...] }
--            or { success: false, message: <CODE> }
--
--      Codes: PRACTICE_NOT_ALLOWED   — allow_practice is false (or exam trashed)
--             STUDENT_NOT_WHITELISTED — caller is not on this exam's roster
--             PRACTICE_EMPTY         — the exam has no questions
--
--      SECURITY DEFINER: the student runtime holds no table privileges at all
--      (schema §B), so the read must be performed with the definer's rights.
--      Ownership is irrelevant here — the *exam owner* authorized practice, and
--      the *caller* is validated against the roster instead.
-- ----------------------------------------------------------------------------
create or replace function public.get_practice_exam_payload(
    p_exam_code    varchar,
    p_student_code varchar,
    p_class_name   varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exam      public.exams%rowtype;
    v_questions jsonb;
    v_total     integer;
begin
    if p_student_code is null or trim(p_student_code) = ''
       or p_class_name is null or trim(p_class_name) = '' then
        return jsonb_build_object('success', false, 'message', 'STUDENT_NOT_WHITELISTED');
    end if;

    select * into v_exam from public.exams where code = p_exam_code;
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

    -- Caller must be on THIS exam's roster (case/whitespace-insensitive, matching
    -- verify_and_acquire_session's identity comparison).
    if not exists (
        select 1
          from public.students s
         where s.exam_code = p_exam_code
           and lower(trim(s.student_code)) = lower(trim(p_student_code))
           and lower(trim(s.class_name))   = lower(trim(p_class_name))
    ) then
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
            'total_questions',  v_total
        ),
        'questions', v_questions
    );
end;
$$;

revoke all on function public.get_practice_exam_payload(varchar, varchar, varchar) from public;
grant execute on function public.get_practice_exam_payload(varchar, varchar, varchar) to anon, authenticated;

commit;
