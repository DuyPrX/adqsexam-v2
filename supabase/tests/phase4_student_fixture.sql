-- ============================================================================
-- LOCAL verification fixture for the student SPA (Phase 4).
-- Seeds one exam with all four question types + one whitelisted candidate.
-- Run as postgres (bypasses RLS). Safe to re-run.
-- ============================================================================
\set ON_ERROR_STOP on

-- Resolve any existing teacher so the fixture works regardless of which
-- account the local stack currently holds (no hardcoded UUID).
-- A temp table cannot be used here: psql autocommits each statement, which
-- would drop an `on commit drop` table before the inserts that read it.

delete from public.active_sessions where exam_code = 'STU001';
delete from public.exam_results    where exam_code = 'STU001';
delete from public.students        where exam_code = 'STU001';
delete from public.question_bank   where exam_id in (select id from public.exams where code = 'STU001');
delete from public.exams           where code = 'STU001';

insert into public.exams (user_id, code, title, duration_minutes)
select id, 'STU001', 'Kiểm tra thử Phase 4', 45
  from auth.users order by created_at limit 1;

insert into public.question_bank (user_id, exam_id, question_text, question_type, options, correct_answer, position, explanation)
select t.id, e.id, v.qtext, v.qtype, v.opts::jsonb, v.key::jsonb, v.pos, v.expl
  from (select id from auth.users order by created_at limit 1) t
  cross join public.exams e
  cross join (values
    ('Thủ đô của Việt Nam là gì?', 'MULTIPLE_CHOICE',
     '["Hà Nội","Huế","Đà Nẵng","TP.HCM"]', '0', 1,
     'Hà Nội là thủ đô của Việt Nam từ năm 1010.'),
    ('Xét tính đúng sai của các mệnh đề sau:', 'TRUE_FALSE',
     '["a) 2 + 2 = 4","b) 3 > 5","c) Trái Đất hình cầu","d) 1 = 2"]', '["Đ","S","Đ","S"]', 2,
     null),
    ('Tính 1,5 + 1,5 = ?', 'SHORT_ANSWER',
     '[]', '"3"', 3,
     null),
    ('Trình bày cảm nhận của em về quê hương.', 'ESSAY',
     '[]', null, 4,
     null)
  ) as v(qtext, qtype, opts, key, pos, expl)
 where e.code = 'STU001';

insert into public.students (student_code, full_name, class_name, exam_code)
values ('HS001', 'Nguyễn Văn A', '12A1', 'STU001');

\echo '--- seeded ---'
select (select count(*) from public.exams where code='STU001')         as exams,
       (select count(*) from public.question_bank q
          join public.exams e on e.id = q.exam_id where e.code='STU001') as questions,
       (select count(*) from public.students where exam_code='STU001')   as students;
