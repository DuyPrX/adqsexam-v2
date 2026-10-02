/**
 * ============================================================================
 * ADQS Exam v2 — Phase 5 End-to-End Flow Verification
 * ----------------------------------------------------------------------------
 * Exercises the complete production path against the LOCAL Supabase stack:
 *
 *   1. Teacher signs in, creates an exam + 3 questions (exams, question_bank)
 *   2. Seeds a candidate into `students`
 *   3. Student calls verify_and_acquire_session
 *   4. Student calls get_student_exam_payload  -> asserts ZERO answer leaks
 *   5. Student sends 2x record_student_heartbeat with blur increments
 *   6. Student calls submit_exam_result
 *   7. Teacher client detects the submission and the score matches expected
 *   8. Student receives the teacher-facing Realtime event (D2)
 *   9. Post-submit guards (re-login blocked, tables unreadable)
 *  10. Certificate verification (Phase 5.1): a passing result verifies as
 *      valid, while a failing result and an unknown UUID verify as invalid.
 *  11. Self-practice authorization (Phase 5.2): verify_student_practice accepts
 *      a rostered (student_code, class_name) pair and rejects everything else.
 *
 * Usage:
 *   node v2/tests/e2e_flow_verification.mjs
 *
 * Env overrides:
 *   SB_URL          default http://127.0.0.1:54321
 *   SB_PUBLISHABLE  default local publishable key
 *   SB_SECRET       default local service_role key (admin only, for seeding)
 *
 * Exit code 0 = every assertion passed.
 * ============================================================================
 */

const SB_URL = process.env.SB_URL || 'http://127.0.0.1:54321';
const SB_PUBLISHABLE =
  process.env.SB_PUBLISHABLE || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
// Local-only service_role key: used solely to create the teacher auth user.
const SB_SECRET =
  process.env.SB_SECRET ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// supabase-js lives in the teacher app's node_modules; resolve it by URL so the
// script works regardless of the current working directory.
const { createClient } = await import(
  new URL('../web/node_modules/@supabase/supabase-js/dist/index.mjs', import.meta.url).href
);

const TEACHER = { email: 'e2e.teacher@adqsexam.local', password: 'e2e-password-123' };
const EXAM = {
  code: 'E2E' + String(Math.floor(100 + Math.random() * 900)), // 6 chars
  title: 'E2E Phase 5 Verification',
  duration: 45,
};
const STUDENT = {
  code: 'E2EHS01',
  fullName: 'Nguyễn Văn E2E',
  className: '12E2E',
};
const FAILING_STUDENT = {
  code: 'E2EHS02',
  fullName: 'Trần Thị E2E',
  className: '12E2E',
};
const EXPECTED_SCORE = 2.5; // MCQ 1.0 + TRUE_FALSE 3/4 = 0.5 + SHORT_ANSWER 1.0
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------- harness */

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail !== undefined ? `  -> ${detail}` : ''}`);
  }
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `predicate()` is true or the timeout elapses. */
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/* ------------------------------------------------------------ admin setup */

async function ensureTeacher() {
  const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SB_SECRET,
      Authorization: `Bearer ${SB_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: TEACHER.email,
      password: TEACHER.password,
      email_confirm: true,
    }),
  });
  // 422 => already registered, which is fine (idempotent re-runs).
  if (res.ok || res.status === 422) return;
  throw new Error(`Cannot create teacher: ${res.status} ${await res.text()}`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('='.repeat(74));
  console.log('Phase 5 — End-to-End Flow Verification');
  console.log(`Target: ${SB_URL}   Exam: ${EXAM.code}`);
  console.log('='.repeat(74));

  /* --- 1. Teacher session + exam authoring ------------------------------ */
  step(1, 'Teacher signs in and creates an exam with 3 questions');

  await ensureTeacher();

  const teacher = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await teacher.auth.signInWithPassword({
    email: TEACHER.email,
    password: TEACHER.password,
  });
  check('teacher signed in', !signIn.error && !!signIn.data.user, signIn.error?.message);
  const teacherId = signIn.data?.user?.id;

  // Clean up any previous run of this same exam code.
  await teacher.from('exams').delete().eq('code', EXAM.code);

  const examInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: EXAM.code,
      title: EXAM.title,
      duration_minutes: EXAM.duration,
    })
    .select('id, code, title')
    .single();
  check('exam row created', !examInsert.error && !!examInsert.data, examInsert.error?.message);
  const examId = examInsert.data?.id;

  const questions = [
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Thủ đô của Việt Nam là gì?',
      question_type: 'MULTIPLE_CHOICE',
      options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
      correct_answer: 0,
      explanation: 'Hà Nội là thủ đô.',
      position: 1,
    },
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Xét tính đúng sai của các mệnh đề:',
      question_type: 'TRUE_FALSE',
      options: ['a) 2 + 2 = 4', 'b) 3 > 5', 'c) Trái Đất hình cầu', 'd) 1 = 2'],
      // 3 of 4 correct -> 0.5 per the F3 scale.
      correct_answer: ['Đ', 'S', 'Đ', 'S'],
      explanation: null,
      position: 2,
    },
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Tính 1,5 + 1,5 = ?',
      question_type: 'SHORT_ANSWER',
      options: [],
      correct_answer: '3',
      explanation: null,
      position: 3,
    },
  ];

  const qInsert = await teacher.from('question_bank').insert(questions).select('id');
  check(
    '3 questions created',
    !qInsert.error && qInsert.data?.length === 3,
    qInsert.error?.message ?? `got ${qInsert.data?.length}`,
  );

  /* --- 2. Roster -------------------------------------------------------- */
  step(2, 'Seeds the candidate into the whitelist');

  const rosterInsert = await teacher.from('students').insert({
    student_code: STUDENT.code,
    full_name: STUDENT.fullName,
    class_name: STUDENT.className,
    exam_code: EXAM.code,
  });
  check('student whitelisted', !rosterInsert.error, rosterInsert.error?.message);

  /* --- Realtime subscription (teacher side, before any student action) --- */
  step('3', 'Teacher subscribes to Realtime channels (D2)');

  const realtimeEvents = {
    activeSessions: [],
    examResults: [],
  };
  let channelStatus = 'PENDING';

  const channel = teacher
    .channel(`e2e:${EXAM.code}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'active_sessions', filter: `exam_code=eq.${EXAM.code}` },
      (payload) => realtimeEvents.activeSessions.push(payload),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'exam_results', filter: `exam_code=eq.${EXAM.code}` },
      (payload) => realtimeEvents.examResults.push(payload),
    )
    .subscribe((status) => {
      channelStatus = status;
    });

  const subscribed = await waitFor(() => channelStatus === 'SUBSCRIBED', 10_000);
  check('realtime channel SUBSCRIBED', subscribed, channelStatus);

  if (!subscribed) {
    console.log(
      '\n  Realtime is not reachable. Ensure `npx supabase start` is running and the\n' +
        '  tables are in the supabase_realtime publication (schema.sql SECTION D.2).',
    );
  }
  await sleep(500);

  /* --- 4/5/6. Student lifecycle (anon role, publishable key) ------------ */
  const student = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  step(4, 'Student signs in via verify_and_acquire_session');
  const acquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_full_name: STUDENT.fullName,
    p_class_name: STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('session acquired', acquire.data?.success === true, JSON.stringify(acquire.data ?? acquire.error));
  const token = acquire.data?.session_token;
  check('session token returned', typeof token === 'string' && token.length === 36, String(token));

  step(5, 'Student loads the payload — asserting zero answer leaks');
  const payloadRes = await student.rpc('get_student_exam_payload', {
    p_exam_code: EXAM.code,
    p_session_token: token,
  });
  const payload = payloadRes.data;
  check('payload returned', payload?.success === true, JSON.stringify(payloadRes.error ?? payload));
  check('3 questions delivered', payload?.questions?.length === 3, String(payload?.questions?.length));

  const rawPayload = JSON.stringify(payload ?? {});
  for (const leak of ['correct_answer', 'correctIndex', 'correctAnswers', 'explanation', 'isCorrect']) {
    check(`payload does not contain "${leak}"`, !rawPayload.includes(leak));
  }
  check('answer text not leaked', !rawPayload.includes('Hà Nội là thủ đô'));

  step(6, 'Student sends 2 heartbeats with blur/fullscreen increments');

  const hb1 = await student.rpc('record_student_heartbeat', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_current_q: 0,
    p_answered_count: 0,
    p_blur_count: 1,
    p_fs_exit_count: 0,
  });
  check('heartbeat 1 accepted', hb1.data?.success === true, JSON.stringify(hb1.data ?? hb1.error));

  const hb2 = await student.rpc('record_student_heartbeat', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_current_q: 1,
    p_answered_count: 1,
    p_blur_count: 3,
    p_fs_exit_count: 2,
  });
  check('heartbeat 2 accepted', hb2.data?.success === true, JSON.stringify(hb2.data ?? hb2.error));

  // Give Realtime a moment to deliver the two INSERT/UPDATE events.
  await waitFor(() => realtimeEvents.activeSessions.length >= 1, 5_000);

  const sessionRow = await teacher
    .from('active_sessions')
    .select('*')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('proctor row reflects telemetry', !sessionRow.error && sessionRow.data?.blur_count === 3,
    sessionRow.error?.message ?? JSON.stringify(sessionRow.data));
  check('fullscreen exits recorded', sessionRow.data?.fullscreen_exit_count === 2,
    String(sessionRow.data?.fullscreen_exit_count));
  check('current question tracked', sessionRow.data?.current_question === 1,
    String(sessionRow.data?.current_question));

  step(7, 'Student submits; server computes the authoritative score');

  const submit = await student.rpc('submit_exam_result', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 0 },                          // MCQ correct  -> 1.00
      { questionIndex: 1, selectedAnswers: ['Đ', 'S', 'Đ', 'Đ'] },      // T/F 3/4     -> 0.50
      { questionIndex: 2, selectedAnswerText: ' 3 ' },                 // SHORT trim  -> 1.00
    ],
    p_metrics: { blurCount: 3, fullscreenExitCount: 2, elapsedSeconds: 900 },
  });
  check('submission accepted', submit.data?.success === true, JSON.stringify(submit.data ?? submit.error));
  check(
    `server score = ${EXPECTED_SCORE}`,
    Number(submit.data?.score) === EXPECTED_SCORE,
    String(submit.data?.score),
  );
  check('total_questions = 3', Number(submit.data?.total_questions) === 3, String(submit.data?.total_questions));

  const passingResultId = submit.data?.result_id;
  check('submission returns result_id (UUID)', UUID_RE.test(String(passingResultId)), String(passingResultId));

  step(8, 'Teacher side detects the submission (query + Realtime)');

  const resultRow = await teacher
    .from('exam_results')
    .select('*')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();

  check('teacher query sees the result', !resultRow.error && !!resultRow.data, resultRow.error?.message);
  check('persisted score matches', Number(resultRow.data?.score) === EXPECTED_SCORE,
    String(resultRow.data?.score));
  check('blur count persisted', resultRow.data?.blur_count === 3, String(resultRow.data?.blur_count));
  check('fullscreen exits persisted', resultRow.data?.fullscreen_exit_count === 2,
    String(resultRow.data?.fullscreen_exit_count));

  const gotResultEvent = await waitFor(
    () => realtimeEvents.examResults.some((e) => e.eventType === 'INSERT'),
    8_000,
  );
  check('realtime INSERT received on exam_results', gotResultEvent,
    `events=${JSON.stringify(realtimeEvents.examResults.map((e) => e.eventType))}`);
  check('realtime INSERT carries the score',
    realtimeEvents.examResults.some((e) => Number(e.new?.score) === EXPECTED_SCORE),
    JSON.stringify(realtimeEvents.examResults.map((e) => e.new?.score)));

  check(
    'active_sessions realtime events delivered',
    realtimeEvents.activeSessions.length > 0,
    `count=${realtimeEvents.activeSessions.length}`,
  );
  check('session row removed on submit (DELETE event)',
    realtimeEvents.activeSessions.some((e) => e.eventType === 'DELETE'),
    JSON.stringify(realtimeEvents.activeSessions.map((e) => e.eventType)));

  /* --- 9. Post-submit guards ------------------------------------------- */
  step(9, 'Post-submission guards');

  const reAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_full_name: STUDENT.fullName,
    p_class_name: STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('re-login blocked with ALREADY_SUBMITTED',
    reAcquire.data?.message === 'ALREADY_SUBMITTED', JSON.stringify(reAcquire.data));

  const anonTable = await fetch(`${SB_URL}/rest/v1/question_bank?select=correct_answer`, {
    headers: { apikey: SB_PUBLISHABLE },
  });
  check('student cannot read question_bank directly',
    anonTable.status === 401 || anonTable.status === 403 || anonTable.status === 404,
    `status=${anonTable.status}`);

  /* --- 10. Certificate verification (Phase 5.1) ------------------------ */
  step(10, 'Public certificate verification via get_certificate_verification');

  // The anon client is the same one a visitor scanning the QR code would use.
  const passingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: passingResultId,
  });
  check('RPC reachable by anon', !passingVerify.error,
    JSON.stringify(passingVerify.error));
  check('passing result verifies as valid', passingVerify.data?.valid === true,
    JSON.stringify(passingVerify.data));
  check('verification exposes student name',
    passingVerify.data?.student_name === STUDENT.fullName,
    String(passingVerify.data?.student_name));
  check('verification exposes class name',
    passingVerify.data?.class_name === STUDENT.className,
    String(passingVerify.data?.class_name));
  check('verification exposes exam title',
    passingVerify.data?.exam_title === EXAM.title,
    String(passingVerify.data?.exam_title));
  check('verification exposes the score',
    Number(passingVerify.data?.score) === EXPECTED_SCORE,
    String(passingVerify.data?.score));
  check('verification exposes a completion timestamp',
    typeof passingVerify.data?.submitted_at === 'string',
    String(passingVerify.data?.submitted_at));

  const rawVerify = JSON.stringify(passingVerify.data ?? {});
  for (const leak of ['correct_answer', 'correctAnswer', 'explanation', 'session_token']) {
    check(`verification does not leak "${leak}"`, !rawVerify.includes(leak));
  }

  // A UUID that does not exist must never verify.
  const missingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: '00000000-0000-0000-0000-000000000000',
  });
  check('unknown UUID verifies as invalid', missingVerify.data?.valid === false,
    JSON.stringify(missingVerify.data));

  // A real-but-failing result must not verify either.
  await teacher.from('students').insert({
    student_code: FAILING_STUDENT.code,
    full_name: FAILING_STUDENT.fullName,
    class_name: FAILING_STUDENT.className,
    exam_code: EXAM.code,
  });

  const failingAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: FAILING_STUDENT.code,
    p_full_name: FAILING_STUDENT.fullName,
    p_class_name: FAILING_STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('failing candidate acquired a session',
    failingAcquire.data?.success === true, JSON.stringify(failingAcquire.data ?? failingAcquire.error));

  const failingSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: EXAM.code,
    p_student_code: FAILING_STUDENT.code,
    p_session_token: failingAcquire.data?.session_token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 1 },                          // MCQ wrong
      { questionIndex: 1, selectedAnswers: ['S', 'S', 'S', 'S'] },      // T/F 1/4 -> 0.10
      { questionIndex: 2, selectedAnswerText: 'sai' },                 // SHORT wrong
    ],
    p_metrics: {},
  });
  check('failing submission accepted', failingSubmit.data?.success === true,
    JSON.stringify(failingSubmit.data ?? failingSubmit.error));
  check('failing score is below 80%',
    Number(failingSubmit.data?.score) / Number(failingSubmit.data?.total_questions) < 0.8,
    `${failingSubmit.data?.score}/${failingSubmit.data?.total_questions}`);

  const failingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: failingSubmit.data?.result_id,
  });
  check('failing result verifies as invalid', failingVerify.data?.valid === false,
    JSON.stringify(failingVerify.data));
  check('failing result reports NOT_PASSED',
    failingVerify.data?.message === 'NOT_PASSED', String(failingVerify.data?.message));

  /* --- 11. Authorized self-practice gate (Phase 5.2) -------------------- */
  step(11, 'Self-practice authorization via verify_student_practice');

  const practiceOk = await student.rpc('verify_student_practice', {
    p_student_code: STUDENT.code,
    p_class_name: STUDENT.className,
  });
  check('practice RPC reachable by anon', !practiceOk.error, JSON.stringify(practiceOk.error));
  check('whitelisted student is authorized', practiceOk.data?.authorized === true,
    JSON.stringify(practiceOk.data));
  check('authorized response returns the canonical name',
    practiceOk.data?.student_name === STUDENT.fullName, String(practiceOk.data?.student_name));

  // Case- and whitespace-insensitive, mirroring verify_and_acquire_session().
  const practiceLoose = await student.rpc('verify_student_practice', {
    p_student_code: `  ${STUDENT.code.toLowerCase()} `,
    p_class_name: ` ${STUDENT.className.toLowerCase()}  `,
  });
  check('match is case/whitespace-insensitive', practiceLoose.data?.authorized === true,
    JSON.stringify(practiceLoose.data));

  // Not on any roster.
  const practiceBad = await student.rpc('verify_student_practice', {
    p_student_code: 'KHONG-CO',
    p_class_name: '99ZZ',
  });
  check('unknown student is rejected', practiceBad.data?.authorized === false,
    JSON.stringify(practiceBad.data));
  check('rejection carries a Vietnamese message',
    typeof practiceBad.data?.message === 'string' && practiceBad.data.message.length > 0,
    String(practiceBad.data?.message));

  // Right student code, wrong class -> still rejected (both fields must match).
  const practiceWrongClass = await student.rpc('verify_student_practice', {
    p_student_code: STUDENT.code,
    p_class_name: '99ZZ',
  });
  check('mismatched class is rejected', practiceWrongClass.data?.authorized === false,
    JSON.stringify(practiceWrongClass.data));

  // Empty input is rejected without touching the table.
  const practiceEmpty = await student.rpc('verify_student_practice', {
    p_student_code: '',
    p_class_name: '',
  });
  check('empty credentials are rejected', practiceEmpty.data?.authorized === false,
    JSON.stringify(practiceEmpty.data));

  /* --- teardown --------------------------------------------------------- */
  await teacher.removeChannel(channel);
  await teacher.from('exams').delete().eq('code', EXAM.code); // cascades

  console.log(`\n${'='.repeat(74)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) console.log(`Failed: ${failures.join(' | ')}`);
  console.log('='.repeat(74));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFATAL:', error);
  process.exit(1);
});
