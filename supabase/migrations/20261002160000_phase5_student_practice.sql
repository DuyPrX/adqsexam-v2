-- ============================================================================
-- PHASE 5.2 — AUTHORIZED SELF-PRACTICE
-- ----------------------------------------------------------------------------
-- Adds verify_student_practice(p_student_code, p_class_name): the authorization
-- gate for practice mode. A (student_code, class_name) pair is eligible when it
-- appears in the whitelist of ANY imported exam roster — practice is not bound
-- to a published exam_code.
--
-- Writes nothing: practice exams are ephemeral and graded client-side.
-- Mirrors the definition in ../../supabase/schema.sql (Section C.7).
-- ============================================================================
begin;

create or replace function public.verify_student_practice(
    p_student_code varchar,
    p_class_name   varchar
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_exists       boolean;
    v_student_name varchar;
begin
    if p_student_code is null or trim(p_student_code) = ''
       or p_class_name is null or trim(p_class_name) = '' then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Vui lòng nhập đầy đủ Mã học sinh và Lớp.'
        );
    end if;

    select exists (
               select 1
                 from public.students s
                where lower(trim(s.student_code)) = lower(trim(p_student_code))
                  and lower(trim(s.class_name))   = lower(trim(p_class_name))
           ),
           max(s.full_name)
      into v_exists, v_student_name
      from public.students s
     where lower(trim(s.student_code)) = lower(trim(p_student_code))
       and lower(trim(s.class_name))   = lower(trim(p_class_name));

    if not v_exists then
        return jsonb_build_object(
            'authorized', false,
            'message',    'Thông tin học sinh không có trong danh sách được phép ôn luyện.'
        );
    end if;

    return jsonb_build_object(
        'authorized',   true,
        'student_name', v_student_name
    );
end;
$$;

revoke all on function public.verify_student_practice(varchar, varchar) from public;
grant execute on function public.verify_student_practice(varchar, varchar) to anon, authenticated;

commit;
