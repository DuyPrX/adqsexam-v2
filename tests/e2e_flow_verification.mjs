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
 *  12. Scheduling window (Phase 5.4): verify_and_acquire_session rejects before
 *      starts_at / after ends_at / when is_active = false, and accepts inside.
 *  13. Safe question CRUD (Phase 5.4): update_exam_questions_safe rewrites the
 *      bank freely before any submission, then locks structure afterwards.
 *  14. Multi-variant sub-sampling (Phase 5.4): generateExamVariants draws K of N
 *      with contiguous 1..K positions, unique codes, and synced answer keys.
 *  15. Timezone helpers (Phase 5.5): the local <-> UTC converters round-trip the
 *      exact same instant and match the platform's own offset.
 *  16. Hard delete (Phase 5.5): an exam with 0 submissions is wiped from every
 *      dependent table.
 *  17. Soft delete / Trash (Phase 5.5): an exam with submissions is soft-deleted,
 *      becomes unreachable to students, and can be restored.
 *  18. Re-grading (Phase 5.5): editing an answer key + recalculate_exam_scores
 *      updates the stored score to match.
 *  19. Rule-engine DOCX parsing (Phase 5.6): sample/test4.docx yields 22 MCQ +
 *      2 TRUE_FALSE with uppercase A-D Part II sub-items and trailing ĐÁP ÁN
 *      keys, no answer-block leakage, in well under the CPU budget.
 *  20. Smart AI fallback (Phase 5.6): a structurally mismatched document in
 *      `auto` mode trips the anomaly linter and hands over to Engine 2.
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
// Local Supabase database container, used only by Step 21 (cron.* is not
// reachable through PostgREST, so its rows are probed over psql).
const SB_DB_CONTAINER = process.env.SB_DB_CONTAINER || 'supabase_db_v2';

// supabase-js lives in the teacher app's node_modules; resolve it by URL so the
// script works regardless of the current working directory.
const { createClient } = await import(
  new URL('../web/node_modules/@supabase/supabase-js/dist/index.mjs', import.meta.url).href
);

// Phase 5.4 Step 14 exercises the web app's TypeScript shuffle module directly,
// and Phase 5.6 Steps 19-20 load the Worker's parser + Hono app. Node strips
// types natively but cannot handle every TS construct the sources use
// (parameter properties, decorators, enums), nor does it resolve the
// extensionless `./utils` imports or the Worker's own node_modules. A single
// module hook covers all three: it retries bare specifiers against the Worker
// package, appends `.ts` for extensionless relatives, and transpiles any `.ts`
// file with the Worker's own esbuild.
const { register } = await import('node:module');
const WORKER_NODE_MODULES = new URL('../worker/node_modules/', import.meta.url).href;
const WORKER_PACKAGE = new URL('../worker/package.json', import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const WORKER_NODE_MODULES = ${JSON.stringify(WORKER_NODE_MODULES)};
const WORKER_PACKAGE = ${JSON.stringify(WORKER_PACKAGE)};
const { transform } = await import(new URL('esbuild/lib/main.js', WORKER_NODE_MODULES).href);

function isBare(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (isBare(specifier)) {
      return nextResolve(specifier, { ...context, parentURL: WORKER_PACKAGE });
    }
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`)}`,
);
const { generateExamVariants } = await import(
  new URL('../web/src/lib/shuffle.ts', import.meta.url).href
);

// Phase 5.5 Step 15 exercises the timezone helpers. `date.ts` has no imports of
// its own, so it loads directly through the same extension-resolving hook.
const { toLocalDatetimeString, toUtcIsoString, daysUntil } = await import(
  new URL('../web/src/lib/date.ts', import.meta.url).href
);

// Phase 5.6 Steps 19-20 — the Worker parser and the full Hono app.
const { preprocessDocx } = await import(
  new URL('../worker/src/parser/xml-preprocessor.ts', import.meta.url).href
);
const { extractWithRules } = await import(
  new URL('../worker/src/parser/rule-engine.ts', import.meta.url).href
);
const { detectParsingAnomalies } = await import(
  new URL('../worker/src/parser/anomaly-linter.ts', import.meta.url).href
);
const { zipSync, strToU8 } = await import(
  new URL('../worker/node_modules/fflate/esm/index.mjs', import.meta.url).href
);
const { default: workerApp } = await import(
  new URL('../worker/src/index.ts', import.meta.url).href
);
const { readFileSync } = await import('node:fs');
// Step 21 seeds/inspects cron.job_run_details, which is not API-exposed.
const { execFileSync } = await import('node:child_process');

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
// Phase 5.4 — dedicated actors so the scheduling / CRUD steps stay isolated.
const SCHED_EXAM = {
  code: 'SCH' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Scheduling Window',
  duration: 30,
};
const SCHED_STUDENT = {
  code: 'E2ESCH01',
  fullName: 'Lê Văn Lịch',
  className: '12SCH',
};
const EDIT_EXAM = {
  code: 'EDT' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Question CRUD',
  duration: 30,
};
const EXPECTED_SCORE = 2.5; // MCQ 1.0 + TRUE_FALSE 3/4 = 0.5 + SHORT_ANSWER 1.0
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Phase 5.5 — dedicated exams for the deletion / re-grading steps.
const HARD_DEL_EXAM = {
  code: 'HDL' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Hard Delete',
  duration: 30,
};
const SOFT_DEL_EXAM = {
  code: 'SDL' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Soft Delete',
  duration: 30,
};
const SOFT_DEL_STUDENT = {
  code: 'E2ESDL01',
  fullName: 'Phạm Thị Rác',
  className: '12SDL',
};

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

  /* --- 12. Scheduling window (Phase 5.4) -------------------------------- */
  step(12, 'Scheduling window enforced by verify_and_acquire_session');

  const acquireOn = async (suffix) => {
    // A fresh candidate per probe: `active_sessions` has a SELECT-only teacher
    // policy, so a leftover session cannot be deleted from here and would
    // otherwise surface SESSION_ACTIVE_ELSEWHERE instead of the window verdict.
    const code = `E2ESCH-${suffix}`.toUpperCase();
    await teacher.from('students').upsert(
      {
        student_code: code,
        full_name: SCHED_STUDENT.fullName,
        class_name: SCHED_STUDENT.className,
        exam_code: SCHED_EXAM.code,
      },
      { onConflict: 'student_code,exam_code' },
    );
    const res = await student.rpc('verify_and_acquire_session', {
      p_exam_code: SCHED_EXAM.code,
      p_student_code: code,
      p_full_name: SCHED_STUDENT.fullName,
      p_class_name: SCHED_STUDENT.className,
      p_device_info: `e2e-sched/${suffix}`,
      p_existing_token: null,
    });
    return res.data;
  };

  // Re-create the scheduling exam fresh (idempotent re-runs).
  await teacher.from('exams').delete().eq('code', SCHED_EXAM.code);
  const schedInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: SCHED_EXAM.code,
      title: SCHED_EXAM.title,
      duration_minutes: SCHED_EXAM.duration,
      is_active: true,
      starts_at: null,
      ends_at: null,
    })
    .select('id')
    .single();
  check('scheduling exam created', !schedInsert.error, schedInsert.error?.message);

  // Sanity: with no window and is_active, login is allowed.
  const schedBaseline = await acquireOn('baseline');
  check('open exam with no window accepts login',
    schedBaseline?.success === true, JSON.stringify(schedBaseline));

  // Not started: starts_at in the future.
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await teacher.from('exams').update({ starts_at: future }).eq('code', SCHED_EXAM.code);
  const beforeStart = await acquireOn('before');
  check('login before starts_at is rejected',
    beforeStart?.success === false && beforeStart?.message === 'EXAM_NOT_STARTED',
    JSON.stringify(beforeStart));

  // Expired: ends_at in the past.
  await teacher
    .from('exams')
    .update({ starts_at: null, ends_at: new Date(Date.now() - 3_600_000).toISOString() })
    .eq('code', SCHED_EXAM.code);
  const afterEnd = await acquireOn('after');
  check('login after ends_at is rejected',
    afterEnd?.success === false && afterEnd?.message === 'EXAM_EXPIRED',
    JSON.stringify(afterEnd));

  // Inside the window: past start, future end.
  await teacher
    .from('exams')
    .update({
      starts_at: new Date(Date.now() - 3_600_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .eq('code', SCHED_EXAM.code);
  const inWindow = await acquireOn('inside');
  check('login inside the window is accepted',
    inWindow?.success === true, JSON.stringify(inWindow));

  // Teacher closed the exam regardless of the window.
  await teacher.from('exams').update({ is_active: false }).eq('code', SCHED_EXAM.code);
  const inactive = await acquireOn('inactive');
  check('login with is_active = false is rejected as EXAM_INACTIVE',
    inactive?.success === false && inactive?.message === 'EXAM_INACTIVE',
    JSON.stringify(inactive));

  /* --- 13. Safe question CRUD (Phase 5.4) ------------------------------- */
  step(13, 'update_exam_questions_safe before and after a submission');

  await teacher.from('exams').delete().eq('code', EDIT_EXAM.code);
  const editInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: EDIT_EXAM.code,
      title: EDIT_EXAM.title,
      duration_minutes: EDIT_EXAM.duration,
    })
    .select('id')
    .single();
  check('edit exam created', !editInsert.error, editInsert.error?.message);
  const editExamId = editInsert.data?.id;

  const seedBank = async (count) => {
    await teacher.from('question_bank').delete().eq('exam_id', editExamId);
    const rows = Array.from({ length: count }, (_, i) => ({
      user_id: teacherId,
      exam_id: editExamId,
      question_text: `Câu gốc ${i + 1}`,
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      explanation: null,
      position: i + 1,
    }));
    return teacher.from('question_bank').insert(rows);
  };

  await seedBank(5);

  // (a) No submissions: a full rewrite is allowed — drop to 3 questions.
  const beforeSubmit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: Array.from({ length: 3 }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sửa ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 1,
      explanation: null,
    })),
  });
  check('pre-submission rewrite of 5 -> 3 is allowed',
    beforeSubmit.data?.success === true, JSON.stringify(beforeSubmit.data ?? beforeSubmit.error));
  check('pre-submission rewrite reports REPLACED',
    beforeSubmit.data?.message === 'REPLACED', String(beforeSubmit.data?.message));

  const afterRewrite = await teacher
    .from('question_bank')
    .select('position, question_text, correct_answer')
    .eq('exam_id', editExamId)
    .order('position', { ascending: true });
  check('rewrite leaves exactly 3 rows', afterRewrite.data?.length === 3,
    String(afterRewrite.data?.length));
  check('rewrite renumbers positions 1..3',
    JSON.stringify(afterRewrite.data?.map((r) => r.position)) === '[1,2,3]',
    JSON.stringify(afterRewrite.data?.map((r) => r.position)));
  check('rewrite applied the new content',
    afterRewrite.data?.[0]?.question_text === 'Câu sửa 1',
    String(afterRewrite.data?.[0]?.question_text));

  // A JSON null key must land as SQL NULL, not the JSONB literal 'null'
  // (which `#>> '{}'` would render as the string "null" and corrupt scoring).
  const nullKeyRewrite = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: Array.from({ length: 3 }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sửa ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: null,
      explanation: null,
    })),
  });
  check('rewrite with a null key is accepted',
    nullKeyRewrite.data?.success === true, JSON.stringify(nullKeyRewrite.data));
  const nullKeyRow = await teacher
    .from('question_bank')
    .select('correct_answer')
    .eq('exam_id', editExamId)
    .limit(1)
    .maybeSingle();
  check('JSON null key is stored as SQL NULL (not JSONB "null")',
    nullKeyRow.data?.correct_answer === null, JSON.stringify(nullKeyRow.data?.correct_answer));

  // Restore a real key for the post-submission phase.
  await seedBank(3);

  // (b) Now create a submission so the structure freezes.
  await teacher.from('students').insert({
    student_code: SCHED_STUDENT.code,
    full_name: SCHED_STUDENT.fullName,
    class_name: SCHED_STUDENT.className,
    exam_code: EDIT_EXAM.code,
  });
  const editAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EDIT_EXAM.code,
    p_student_code: SCHED_STUDENT.code,
    p_full_name: SCHED_STUDENT.fullName,
    p_class_name: SCHED_STUDENT.className,
    p_device_info: 'e2e-edit/1.0',
    p_existing_token: null,
  });
  check('edit-exam candidate acquired a session',
    editAcquire.data?.success === true, JSON.stringify(editAcquire.data ?? editAcquire.error));
  const editSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: EDIT_EXAM.code,
    p_student_code: SCHED_STUDENT.code,
    p_session_token: editAcquire.data?.session_token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 1 },
      { questionIndex: 1, selectedIndex: 1 },
      { questionIndex: 2, selectedIndex: 1 },
    ],
    p_metrics: {},
  });
  check('edit-exam submission accepted', editSubmit.data?.success === true,
    JSON.stringify(editSubmit.data ?? editSubmit.error));

  const questionPayload = (count) =>
    Array.from({ length: count }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sau nộp ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 2,
      explanation: 'giải thích mới',
    }));

  // (c) Deletion (a count change) must be rejected.
  const deleteBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(2),
  });
  check('deletion after submission is blocked',
    deleteBlocked.data?.success === false
      && deleteBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(deleteBlocked.data));
  check('block carries a Vietnamese detail message',
    typeof deleteBlocked.data?.detail === 'string' && deleteBlocked.data.detail.length > 0,
    String(deleteBlocked.data?.detail));

  // (d) Addition (count change) must also be rejected.
  const addBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(4),
  });
  check('addition after submission is blocked',
    addBlocked.data?.success === false
      && addBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(addBlocked.data));

  // (e) In-place content edit of the same count/type is allowed.
  const contentEdit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(3),
  });
  check('in-place content edit after submission is allowed',
    contentEdit.data?.success === true, JSON.stringify(contentEdit.data ?? contentEdit.error));
  check('content edit reports CONTENT_UPDATED',
    contentEdit.data?.message === 'CONTENT_UPDATED', String(contentEdit.data?.message));

  const afterEdit = await teacher
    .from('question_bank')
    .select('position, question_text, correct_answer')
    .eq('exam_id', editExamId)
    .order('position', { ascending: true });
  check('content edit applied without changing the count',
    afterEdit.data?.length === 3, String(afterEdit.data?.length));
  check('content edit updated the text',
    afterEdit.data?.[0]?.question_text === 'Câu sau nộp 1',
    String(afterEdit.data?.[0]?.question_text));

  // (f) A type change at the same count is structural.
  const typeChanged = questionPayload(3);
  typeChanged[1].question_type = 'SHORT_ANSWER';
  const typeBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: typeChanged,
  });
  check('type change after submission is blocked',
    typeBlocked.data?.success === false
      && typeBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(typeBlocked.data));

  // (g) Ownership: an anonymous caller must never be able to edit.
  const anonEdit = await student.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(3),
  });
  check('anon cannot call update_exam_questions_safe',
    !!anonEdit.error || anonEdit.data?.success === false,
    JSON.stringify(anonEdit.error ?? anonEdit.data));

  /* --- 14. Multi-variant sub-sampling (Phase 5.4) ----------------------- */
  step(14, 'generateExamVariants subsamples K of N with contiguous positions');

  const pool = Array.from({ length: 5 }, (_, i) => ({
    position: i + 1,
    question_type: 'MULTIPLE_CHOICE',
    question_text: `Pool ${i + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correct_answer: 0,
    explanation: null,
  }));

  const variants = generateExamVariants(pool, {
    variantCount: 4,
    questionCountPerExam: 3,
    shuffleDistractors: true,
  });

  check('generates the requested number of variants', variants.length === 4, String(variants.length));
  check('every variant draws exactly K questions',
    variants.every((v) => v.questions.length === 3),
    JSON.stringify(variants.map((v) => v.questions.length)));
  check('positions are strictly contiguous 1..K',
    variants.every((v) => JSON.stringify(v.questions.map((q) => q.position)) === '[1,2,3]'),
    JSON.stringify(variants.map((v) => v.questions.map((q) => q.position))));
  check('questions within a variant are unique',
    variants.every((v) => new Set(v.questions.map((q) => q.question_text)).size === 3),
    JSON.stringify(variants.map((v) => v.questions.map((q) => q.question_text))));
  check('every variant has a 6-char code',
    variants.every((v) => typeof v.code === 'string' && v.code.length === 6),
    JSON.stringify(variants.map((v) => v.code)));
  check('variant codes are unique',
    new Set(variants.map((v) => v.code)).size === variants.length,
    JSON.stringify(variants.map((v) => v.code)));

  // Distractor shuffle must keep correct_answer pointing at the marked content.
  // Every pool question marks 'A' (index 0), so after a shuffle the key must
  // still resolve to the option whose text is 'A'.
  check('distractor shuffle keeps the answer key in sync',
    variants.every((v) => v.questions.every((q) => q.options[q.correct_answer] === 'A')),
    JSON.stringify(variants[0]?.questions.map((q) => ({ opts: q.options, key: q.correct_answer }))));

  // The same pool can be sampled without replacement, so K <= N is enforced.
  const capped = generateExamVariants(pool, { variantCount: 1, questionCountPerExam: 99 });
  check('K is capped at the pool size N', capped[0]?.questions.length === 5,
    String(capped[0]?.questions.length));

  /* --- 15. Timezone helpers (Phase 5.5) --------------------------------- */
  step(15, 'Timezone helpers round-trip the exact same instant');

  const sampleIso = '2026-10-02T01:30:00.000Z';
  const localValue = toLocalDatetimeString(sampleIso);
  check('UTC ISO converts to a datetime-local string',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue), localValue);

  // The local wall clock must reflect the platform's real UTC offset for that
  // instant — parsed back on its own it is a LOCAL date, so re-deriving the UTC
  // instant from it must land on the original timestamp.
  const [datePart, timePart] = localValue.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const localReconstructed = new Date(y, mo - 1, d, h, mi, 0, 0);
  check('local string reflects the platform UTC offset',
    localReconstructed.getTime() === new Date(sampleIso).getTime(),
    `${localReconstructed.toISOString()} vs ${sampleIso}`);

  // Round-trip: local -> UTC must reproduce the same instant (minute precision).
  const roundTripped = toUtcIsoString(localValue);
  check('local string converts back to the same UTC instant',
    roundTripped === sampleIso, `${roundTripped} vs ${sampleIso}`);
  check('round-trip preserves the exact epoch millisecond',
    new Date(roundTripped).getTime() === new Date(sampleIso).getTime(),
    String(new Date(roundTripped).getTime()));

  // An offset with a non-zero minute component (e.g. UTC+05:45) must survive the
  // round-trip rather than being truncated to a whole hour. This assertion holds
  // in ANY host timezone, since both directions use the same local calendar.
  const minuteOffsetIso = '2026-01-15T06:15:00.000Z';
  check('minute-level offsets survive the round-trip',
    toUtcIsoString(toLocalDatetimeString(minuteOffsetIso)) === minuteOffsetIso,
    String(toUtcIsoString(toLocalDatetimeString(minuteOffsetIso))));

  // Null / invalid inputs must degrade to "no bound" rather than throw.
  check('null ISO yields an empty input value', toLocalDatetimeString(null) === '');
  check('null local yields a null bound', toUtcIsoString(null) === null);
  check('empty local yields a null bound', toUtcIsoString('   ') === null);
  check('invalid local yields a null bound', toUtcIsoString('not-a-date') === null);

  // daysUntil drives the Trash "time remaining" label.
  const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString();
  check('daysUntil reports 7 days for a fresh 7-day window', daysUntil(inSevenDays) === 7,
    String(daysUntil(inSevenDays)));
  check('daysUntil reports 0 once the deadline has passed',
    daysUntil(new Date(Date.now() - 1000).toISOString()) === 0,
    String(daysUntil(new Date(Date.now() - 1000).toISOString())));

  /* --- 16. Hard delete (Phase 5.5) -------------------------------------- */
  step(16, 'delete_exam hard-deletes an exam with zero submissions');

  await teacher.from('exams').delete().eq('code', HARD_DEL_EXAM.code);
  const hardInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: HARD_DEL_EXAM.code,
      title: HARD_DEL_EXAM.title,
      duration_minutes: HARD_DEL_EXAM.duration,
    })
    .select('id')
    .single();
  check('hard-delete exam created', !hardInsert.error, hardInsert.error?.message);
  const hardExamId = hardInsert.data?.id;

  const hardRoster = await teacher.from('students').insert({
    student_code: SOFT_DEL_STUDENT.code,
    full_name: SOFT_DEL_STUDENT.fullName,
    class_name: SOFT_DEL_STUDENT.className,
    exam_code: HARD_DEL_EXAM.code,
  });
  check('hard-delete roster seeded', !hardRoster.error, hardRoster.error?.message);

  const hardQuestions = await teacher.from('question_bank').insert([
    {
      user_id: teacherId,
      exam_id: hardExamId,
      question_text: 'Câu sẽ bị xóa',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      position: 1,
    },
  ]);
  check('hard-delete questions seeded', !hardQuestions.error, hardQuestions.error?.message);

  const hardDelete = await teacher.rpc('delete_exam', { p_exam_code: HARD_DEL_EXAM.code });
  check('hard delete reported success', hardDelete.data?.success === true,
    JSON.stringify(hardDelete.data ?? hardDelete.error));
  check('hard delete reports action = hard_deleted',
    hardDelete.data?.action === 'hard_deleted', String(hardDelete.data?.action));

  const hardGoneExam = await teacher
    .from('exams')
    .select('id')
    .eq('code', HARD_DEL_EXAM.code);
  check('exam row is gone after hard delete', hardGoneExam.data?.length === 0,
    String(hardGoneExam.data?.length));

  const hardGoneQuestions = await teacher
    .from('question_bank')
    .select('id')
    .eq('exam_id', hardExamId);
  check('question_bank rows are gone after hard delete', hardGoneQuestions.data?.length === 0,
    String(hardGoneQuestions.data?.length));

  const hardGoneRoster = await teacher
    .from('students')
    .select('id')
    .eq('exam_code', HARD_DEL_EXAM.code);
  check('roster rows are gone after hard delete', hardGoneRoster.data?.length === 0,
    String(hardGoneRoster.data?.length));

  // Deleting an already-deleted (or unknown) exam must not raise.
  const hardDeleteAgain = await teacher.rpc('delete_exam', { p_exam_code: HARD_DEL_EXAM.code });
  check('re-deleting a vanished exam is rejected cleanly',
    hardDeleteAgain.data?.success === false && hardDeleteAgain.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(hardDeleteAgain.data));

  /* --- 17. Soft delete & Trash (Phase 5.5) ------------------------------ */
  step(17, 'delete_exam soft-deletes an exam that has submissions');

  await teacher.from('exams').delete().eq('code', SOFT_DEL_EXAM.code);
  const softInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: SOFT_DEL_EXAM.code,
      title: SOFT_DEL_EXAM.title,
      duration_minutes: SOFT_DEL_EXAM.duration,
    })
    .select('id')
    .single();
  check('soft-delete exam created', !softInsert.error, softInsert.error?.message);
  const softExamId = softInsert.data?.id;

  await teacher.from('students').insert({
    student_code: SOFT_DEL_STUDENT.code,
    full_name: SOFT_DEL_STUDENT.fullName,
    class_name: SOFT_DEL_STUDENT.className,
    exam_code: SOFT_DEL_EXAM.code,
  });

  const softBank = await teacher.from('question_bank').insert([
    {
      user_id: teacherId,
      exam_id: softExamId,
      question_text: 'Câu hỏi gốc',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      position: 1,
    },
    {
      user_id: teacherId,
      exam_id: softExamId,
      question_text: 'Câu hỏi phụ',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 1,
      position: 2,
    },
  ]);
  check('soft-delete questions seeded', !softBank.error, softBank.error?.message);

  // Produce one real submission so the exam becomes soft-delete eligible.
  const softAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_full_name: SOFT_DEL_STUDENT.fullName,
    p_class_name: SOFT_DEL_STUDENT.className,
    p_device_info: 'e2e-softdel/1.0',
    p_existing_token: null,
  });
  check('soft-delete candidate acquired a session',
    softAcquire.data?.success === true, JSON.stringify(softAcquire.data ?? softAcquire.error));

  const softSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_session_token: softAcquire.data?.session_token,
    // Answer Q1 correctly (A=0), Q2 wrongly (marked 1, submitted 0) => 1.0 / 2.
    p_answers: [
      { questionIndex: 0, selectedIndex: 0 },
      { questionIndex: 1, selectedIndex: 0 },
    ],
    p_metrics: {},
  });
  check('soft-delete submission accepted', softSubmit.data?.success === true,
    JSON.stringify(softSubmit.data ?? softSubmit.error));
  check('initial score is 1 of 2', Number(softSubmit.data?.score) === 1,
    String(softSubmit.data?.score));

  const softDelete = await teacher.rpc('delete_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('soft delete reported success', softDelete.data?.success === true,
    JSON.stringify(softDelete.data ?? softDelete.error));
  check('soft delete reports action = soft_deleted',
    softDelete.data?.action === 'soft_deleted', String(softDelete.data?.action));
  check('soft delete returns a purge_at 7 days out',
    !!softDelete.data?.purge_at
      && Math.abs(
        new Date(softDelete.data.purge_at).getTime() - (Date.now() + 7 * 86_400_000),
      ) < 60_000,
    String(softDelete.data?.purge_at));

  const softRow = await teacher
    .from('exams')
    .select('deleted_at, is_active')
    .eq('code', SOFT_DEL_EXAM.code)
    .maybeSingle();
  check('deleted_at is stamped', !!softRow.data?.deleted_at, JSON.stringify(softRow.data));
  check('soft-deleted exam is forced inactive', softRow.data?.is_active === false,
    String(softRow.data?.is_active));

  // A trashed exam must be unreachable to students.
  const softLoginAfterDelete = await student.rpc('verify_and_acquire_session', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_full_name: SOFT_DEL_STUDENT.fullName,
    p_class_name: SOFT_DEL_STUDENT.className,
    p_device_info: 'e2e-softdel/2.0',
    p_existing_token: null,
  });
  check('student login into a trashed exam is rejected as EXAM_NOT_FOUND',
    softLoginAfterDelete.data?.success === false
      && softLoginAfterDelete.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(softLoginAfterDelete.data));

  // ...and it must not appear as a live exam.
  const liveAfterDelete = await teacher
    .from('exams')
    .select('code')
    .is('deleted_at', null)
    .eq('code', SOFT_DEL_EXAM.code);
  check('trashed exam is excluded from the live list', liveAfterDelete.data?.length === 0,
    String(liveAfterDelete.data?.length));

  const trashAfterDelete = await teacher
    .from('exams')
    .select('code')
    .not('deleted_at', 'is', null)
    .eq('code', SOFT_DEL_EXAM.code);
  check('trashed exam appears in the Trash list', trashAfterDelete.data?.length === 1,
    String(trashAfterDelete.data?.length));

  // Restore clears the marker but leaves the exam closed.
  const restored = await teacher.rpc('restore_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('restore reported success', restored.data?.success === true,
    JSON.stringify(restored.data ?? restored.error));

  const restoredRow = await teacher
    .from('exams')
    .select('deleted_at, is_active')
    .eq('code', SOFT_DEL_EXAM.code)
    .maybeSingle();
  check('restore clears deleted_at', restoredRow.data?.deleted_at === null,
    JSON.stringify(restoredRow.data));
  check('restore deliberately leaves the exam closed', restoredRow.data?.is_active === false,
    String(restoredRow.data?.is_active));

  // purge_expired_exams must NOT touch a freshly-restored (live) exam.
  const purgeSweep = await teacher.rpc('purge_expired_exams');
  check('purge sweep runs', purgeSweep.data?.success === true,
    JSON.stringify(purgeSweep.data ?? purgeSweep.error));
  const survivesPurge = await teacher
    .from('exams')
    .select('code')
    .eq('code', SOFT_DEL_EXAM.code);
  check('a live exam survives the purge sweep', survivesPurge.data?.length === 1,
    String(survivesPurge.data?.length));

  // Ownership: an anonymous caller must never delete or restore.
  const anonDelete = await student.rpc('delete_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('anon cannot call delete_exam',
    !!anonDelete.error || anonDelete.data?.success === false,
    JSON.stringify(anonDelete.error ?? anonDelete.data));

  /* --- 18. Re-grading (Phase 5.5) --------------------------------------- */
  step(18, 'recalculate_exam_scores re-grades against the latest keys');

  // The verification exam (EXAM.code) has STUDENT's submission at EXPECTED_SCORE.
  // Flip Q3's SHORT_ANSWER key from "3" to "5" so the candidate's stored "3"
  // becomes wrong: 2.5 - 1.0 = 1.5.
  const keyEdit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EXAM.code,
    p_questions: [
      {
        position: 1,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Thủ đô của Việt Nam là gì?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
        correct_answer: 0,
        explanation: 'Hà Nội là thủ đô.',
      },
      {
        position: 2,
        question_type: 'TRUE_FALSE',
        question_text: 'Xét tính đúng sai của các mệnh đề:',
        options: ['a) 2 + 2 = 4', 'b) 3 > 5', 'c) Trái Đất hình cầu', 'd) 1 = 2'],
        correct_answer: ['Đ', 'S', 'Đ', 'S'],
        explanation: null,
      },
      {
        position: 3,
        question_type: 'SHORT_ANSWER',
        question_text: 'Tính 1,5 + 1,5 = ?',
        options: [],
        correct_answer: '5',
        explanation: null,
      },
    ],
  });
  check('answer key edit accepted after submission',
    keyEdit.data?.success === true, JSON.stringify(keyEdit.data ?? keyEdit.error));

  const beforeRegrade = await teacher
    .from('exam_results')
    .select('score')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('stored score is still the stale value before re-grading',
    Number(beforeRegrade.data?.score) === EXPECTED_SCORE, String(beforeRegrade.data?.score));

  const regrade = await teacher.rpc('recalculate_exam_scores', { p_exam_code: EXAM.code });
  check('re-grade reported success', regrade.data?.success === true,
    JSON.stringify(regrade.data ?? regrade.error));
  // Two candidates submitted to EXAM.code (the passing student and the failing one).
  check('re-grade updated every submission (2)',
    regrade.data?.updated_count === 2, String(regrade.data?.updated_count));
  check('re-grade returns the Vietnamese confirmation',
    regrade.data?.message === 'Đã chấm lại toàn bộ bài thi theo đáp án mới nhất.',
    String(regrade.data?.message));

  const afterRegrade = await teacher
    .from('exam_results')
    .select('score, answers_json')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('re-graded score drops by the rekeyed question (2.5 -> 1.5)',
    Number(afterRegrade.data?.score) === 1.5, String(afterRegrade.data?.score));

  const correctedQ3 = (afterRegrade.data?.answers_json ?? []).find((a) => a.questionIndex === 2);
  check('re-graded answers_json marks Q3 incorrect',
    correctedQ3?.isCorrect === false, JSON.stringify(correctedQ3));
  check('re-graded answers_json carries the NEW correct answer',
    correctedQ3?.correctAnswer === '5', JSON.stringify(correctedQ3));

  // Ownership: re-grading someone else's exam must be refused.
  const anonRegrade = await student.rpc('recalculate_exam_scores', { p_exam_code: EXAM.code });
  check('anon cannot call recalculate_exam_scores',
    !!anonRegrade.error || anonRegrade.data?.success === false,
    JSON.stringify(anonRegrade.error ?? anonRegrade.data));

  /* --- 19. Rule-engine DOCX parsing (Phase 5.6) ------------------------- */
  step(19, 'Rule engine parses the Ministry-format test4.docx in < 15ms');

  const test4Bytes = new Uint8Array(
    readFileSync(new URL('../../sample/test4.docx', import.meta.url)),
  );
  const test4Pre = preprocessDocx(test4Bytes);
  const parseStarted = performance.now();
  const test4 = extractWithRules(test4Pre.text);
  const parseElapsed = performance.now() - parseStarted;

  check('test4 extracts exactly 24 questions', test4.question_count === 24,
    String(test4.question_count));

  const test4Mcq = test4.data.filter((q) => q.question_type === 'MULTIPLE_CHOICE');
  const test4Tf = test4.data.filter((q) => q.question_type === 'TRUE_FALSE');
  check('test4 yields 22 MCQ (Part I)', test4Mcq.length === 22, String(test4Mcq.length));
  check('test4 yields 2 TRUE_FALSE (Part II)', test4Tf.length === 2, String(test4Tf.length));

  // Part II questions are the last two positions (23, 24) — Part I is 1..22.
  check('Part II questions occupy positions 23 and 24',
    test4Tf.length === 2
      && test4Tf[0]?.position === 23
      && test4Tf[1]?.position === 24,
    JSON.stringify(test4Tf.map((q) => q.position)));

  check('Part II Câu 1 carries 4 statement options',
    test4Tf[0]?.options.length === 4, String(test4Tf[0]?.options.length));
  check('Part II Câu 2 carries 4 statement options',
    test4Tf[1]?.options.length === 4, String(test4Tf[1]?.options.length));

  // Keys come from the trailing "ĐÁP ÁN: A. Đúng B. Sai C. Đúng D. Đúng" block.
  check('Part II Câu 1 key is ["Đ","S","Đ","Đ"]',
    JSON.stringify(test4Tf[0]?.correct_answer) === JSON.stringify(['Đ', 'S', 'Đ', 'Đ']),
    JSON.stringify(test4Tf[0]?.correct_answer));
  check('Part II Câu 2 key is ["Đ","S","S","Đ"]',
    JSON.stringify(test4Tf[1]?.correct_answer) === JSON.stringify(['Đ', 'S', 'S', 'Đ']),
    JSON.stringify(test4Tf[1]?.correct_answer));

  // The key block must never reach the student-visible strings.
  const leaked = test4.data.some(
    (q) =>
      q.question_text.includes('ĐÁP ÁN') ||
      q.options.some((option) => option.includes('ĐÁP ÁN')),
  );
  check('no question text or option contains "ĐÁP ÁN"', leaked === false, String(leaked));
  check('Part II stems do not retain the answer-block marker',
    test4Tf.every((q) => !/đáp\s*án/i.test(q.question_text)),
    JSON.stringify(test4Tf.map((q) => q.question_text.slice(-40))));

  check('rule-engine parsing stays under the 15ms bar',
    parseElapsed < 15, `${parseElapsed.toFixed(2)}ms`);
  console.log(`  · parse time: ${parseElapsed.toFixed(2)} ms`);

  // The clean document must NOT trip the linter — otherwise every auto upload
  // would burn an AI call.
  check('clean test4 triggers no anomaly',
    detectParsingAnomalies(test4Pre.text, { questions: test4.data }).shouldFallback === false,
    JSON.stringify(detectParsingAnomalies(test4Pre.text, { questions: test4.data })));

  /* --- 20. Smart AI fallback (Phase 5.6) -------------------------------- */
  step(20, 'Anomaly linter hands a mismatched document to Engine 2 in auto mode');

  // Build a DOCX with the Ministry shells but a Part II whose four statements
  // all sit on ONE line. No line-anchored a-d/A-D delimiter exists there, so the
  // rule engine silently swallows Part II as MCQ: precisely the corruption the
  // old `question_count === 0 || !has_answers` check never noticed.
  const buildDocx = (paragraphs) => {
    const escape = (value) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = paragraphs
      .map((entry) => {
        const [text, bold] = Array.isArray(entry) ? entry : [entry, false];
        const rpr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
        return `<w:p><w:r>${rpr}<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
      })
      .join('');
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body}</w:body></w:document>`;
    return new Uint8Array(zipSync({ 'word/document.xml': strToU8(xml) }));
  };

  const mismatched = buildDocx([
    'PHẦN I. Câu hỏi trắc nghiệm nhiều phương án lựa chọn.',
    'Câu 1. Thủ đô của Việt Nam là gì?',
    ['A. Hà Nội', true],
    'B. Huế',
    'C. Đà Nẵng',
    'D. TP.HCM',
    'Câu 2. Quốc gia nào có diện tích lớn nhất?',
    'A. Việt Nam',
    ['B. Nga', true],
    'C. Pháp',
    'D. Nhật Bản',
    'Câu 3. 2 + 2 bằng mấy?',
    'A. 3',
    'B. 5',
    ['C. 4', true],
    'D. 6',
    'PHẦN II. Câu trắc nghiệm đúng sai.',
    'Câu 4. Xét các mệnh đề: A. 2 + 2 = 4 B. 3 > 5 C. Trái Đất hình cầu D. 1 = 2',
  ]);

  const mismatchedPre = preprocessDocx(mismatched);
  const mismatchedRule = extractWithRules(mismatchedPre.text);
  check('the mismatched document parses as 0 TRUE_FALSE under the rule engine',
    mismatchedRule.data.every((q) => q.question_type !== 'TRUE_FALSE'),
    JSON.stringify(mismatchedRule.data.map((q) => q.question_type)));

  const verdict = detectParsingAnomalies(mismatchedPre.text, { questions: mismatchedRule.data });
  check('the linter flags MISSED_TRUE_FALSE_SECTION',
    verdict.shouldFallback === true && verdict.reason === 'MISSED_TRUE_FALSE_SECTION',
    JSON.stringify(verdict));

  // Drive the real Worker route in-process, stubbing the Gemini HTTP call so the
  // test stays offline. Engine 2 is made to return a correct 4-question set.
  const aiPayload = {
    questions: [
      {
        position: 1,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Thủ đô của Việt Nam là gì?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
        correct_answer: '"0"',
        explanation: '',
      },
      {
        position: 2,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Quốc gia nào có diện tích lớn nhất?',
        options: ['Việt Nam', 'Nga', 'Pháp', 'Nhật Bản'],
        correct_answer: '"1"',
        explanation: '',
      },
      {
        position: 3,
        question_type: 'MULTIPLE_CHOICE',
        question_text: '2 + 2 bằng mấy?',
        options: ['3', '5', '4', '6'],
        correct_answer: '"2"',
        explanation: '',
      },
      {
        position: 4,
        question_type: 'TRUE_FALSE',
        question_text: 'Xét các mệnh đề:',
        options: ['2 + 2 = 4', '3 > 5', 'Trái Đất hình cầu', '1 = 2'],
        correct_answer: '["Đ","S","Đ","S"]',
        explanation: '',
      },
    ],
  };

  const realFetch = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(aiPayload) }], role: 'model' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  };

  /**
   * POSTs a DOCX to a Worker route with the given mode.
   *
   * Phase 5.7: the Worker's default export is now the module-worker handler
   * object ({ fetch, scheduled }) rather than the bare Hono app, so the request
   * goes through `handler.fetch(Request, env)` — the same entrypoint Cloudflare
   * invokes in production.
   */
  const callExtract = async (bytes, filename, mode) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    const response = await workerApp.fetch(
      new Request(`http://localhost/api/v1/extract?mode=${mode}`, { method: 'POST', body: form }),
      { GEMINI_API_KEY: 'e2e-stub-key' },
    );
    return response.json();
  };

  try {
    const autoCorrupt = await callExtract(mismatched, 'mismatched.docx', 'auto');
    check('auto mode reports engine_used = ai_fallback',
      autoCorrupt.engine_used === 'ai_fallback', String(autoCorrupt.engine_used));
    check('auto mode reports the anomaly as fallback_reason',
      autoCorrupt.meta?.fallback_reason === 'MISSED_TRUE_FALSE_SECTION',
      String(autoCorrupt.meta?.fallback_reason));
    check('auto mode returns the AI payload, not the corrupt rule payload',
      autoCorrupt.count === 4
        && autoCorrupt.data.some((q) => q.question_type === 'TRUE_FALSE'),
      JSON.stringify(autoCorrupt.data.map((q) => q.question_type)));
    check('exactly one Engine 2 call was made', geminiCalls === 1, String(geminiCalls));

    // mode=rule must NOT call the AI, and must flag the miss instead.
    const ruleCorrupt = await callExtract(mismatched, 'mismatched.docx', 'rule');
    check('rule mode never triggers the AI fallback',
      ruleCorrupt.engine_used === 'rule' && geminiCalls === 1, String(geminiCalls));
    check('rule mode still reports missed_true_false to the UI',
      ruleCorrupt.meta?.missed_true_false === true,
      JSON.stringify(ruleCorrupt.meta?.missed_true_false));

    // The clean document must stay on Engine 1 in auto mode (zero AI cost).
    const autoClean = await callExtract(test4Bytes, 'test4.docx', 'auto');
    check('a clean document stays on the rule engine in auto mode',
      autoClean.engine_used === 'rule' && autoClean.count === 24,
      `${autoClean.engine_used}/${autoClean.count}`);
    check('a clean document performs no Engine 2 call', geminiCalls === 1, String(geminiCalls));

    // Regression: test2.docx must still parse with full answer coverage.
    const test2Bytes = new Uint8Array(
      readFileSync(new URL('../../sample/test2.docx', import.meta.url)),
    );
    const test2 = extractWithRules(preprocessDocx(test2Bytes).text);
    check('test2.docx regression: still 98 questions', test2.question_count === 98,
      String(test2.question_count));
    check('test2.docx regression: every question is MCQ with a resolved key',
      test2.data.every((q) => q.question_type === 'MULTIPLE_CHOICE')
        && test2.data.filter((q) => q.correct_answer !== null).length >= 96,
      `${test2.data.filter((q) => q.correct_answer !== null).length}/${test2.question_count}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  /* --- 21. pg_cron log retention (Phase 5.7) ---------------------------- */
  step(21, 'purge_expired_exams() prunes stale cron.job_run_details rows');

  // The `cron` schema is not exposed through the PostgREST API, and
  // cron.job_run_details is RLS-guarded (`username = CURRENT_USER`), so the
  // probe rows are seeded and inspected over a direct SQL connection.
  const sql = (statement) => {
    const output = execFileSync(
      'docker',
      ['exec', SB_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
      { encoding: 'utf8' },
    );
    return output.trim();
  };

  const sqlJson = (statement) => JSON.parse(sql(statement));

  try {
    // Seed one stale (35-day-old) row and one fresh row. runid uses a high
    // sentinel range so the cleanup below cannot touch real cron history.
    sql(
      `insert into cron.job_run_details
         (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       values
         (-1, 990001, 0, 'postgres', 'postgres', 'e2e stale probe', 'succeeded', 'x',
          now() - interval '35 days', now() - interval '35 days'),
         (-1, 990002, 0, 'postgres', 'postgres', 'e2e fresh probe', 'succeeded', 'x', now(), now());`,
    );

    check('stale + fresh probe rows were seeded',
      sql("select count(*) from cron.job_run_details where runid in (990001, 990002);") === '2');

    const pruneResult = sqlJson('select public.purge_expired_exams();');
    check('purge reports the pruned log count', pruneResult.pruned_logs >= 1,
      JSON.stringify(pruneResult));
    check('purge still reports exam purging unchanged', pruneResult.success === true
      && typeof pruneResult.purged_count === 'number', JSON.stringify(pruneResult));

    check('the 35-day-old log row is gone',
      sql('select count(*) from cron.job_run_details where runid = 990001;') === '0');
    check('the fresh log row survives the prune',
      sql('select count(*) from cron.job_run_details where runid = 990002;') === '1');
    check('no log rows older than 30 days remain',
      sql("select count(*) from cron.job_run_details where start_time < now() - interval '30 days';") === '0');

    // Idempotency + blank-state safety: a second sweep must be a clean no-op.
    const secondPrune = sqlJson('select public.purge_expired_exams();');
    check('a second sweep prunes nothing and stays successful',
      secondPrune.success === true && secondPrune.pruned_logs === 0,
      JSON.stringify(secondPrune));

    // The daily pg_cron job must still point at the same function.
    check('the daily purge job is still scheduled',
      sql("select count(*) from cron.job where jobname = 'purge-expired-exams-daily' and active;") === '1');
  } finally {
    sql('delete from cron.job_run_details where runid in (990001, 990002);');
  }

  /* --- 22. Worker keep-alive scheduled handler (Phase 5.7) --------------- */
  step(22, 'Worker scheduled handler pings Supabase PostgREST');

  // Capture the outgoing ping without touching the network.
  const pinged = [];
  const keepAliveFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('supabase.co')) {
      pinged.push({ url, method: init?.method, headers: init?.headers });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return keepAliveFetch(input, init);
  };

  /** Drives the cron entrypoint the way Cloudflare does, tracking waitUntil. */
  const runScheduled = async (env) => {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} };
    await workerApp.scheduled({ cron: '0 0 */3 * *', scheduledTime: Date.now() }, env, ctx);
    await Promise.all(pending);
    return pending.length;
  };

  try {
    const scheduledCount = await runScheduled({
      SUPABASE_URL: 'https://example-project.supabase.co/',
      SUPABASE_ANON_KEY: 'anon-key-under-test',
    });

    check('the scheduled handler registered exactly one waitUntil task', scheduledCount === 1,
      String(scheduledCount));
    check('exactly one Supabase ping was issued', pinged.length === 1, String(pinged.length));
    check('the ping targets the PostgREST root',
      pinged[0]?.url === 'https://example-project.supabase.co/rest/v1/',
      String(pinged[0]?.url));
    check('the ping carries the anon key as apikey + bearer',
      pinged[0]?.headers?.apikey === 'anon-key-under-test'
        && pinged[0]?.headers?.Authorization === 'Bearer anon-key-under-test',
      JSON.stringify(pinged[0]?.headers));

    // Missing bindings must be a silent skip, not a crash or a request.
    pinged.length = 0;
    const skippedCount = await runScheduled({});
    check('an unbound keep-alive is skipped without pinging',
      skippedCount === 1 && pinged.length === 0, `${skippedCount}/${pinged.length}`);

    // A throwing fetch must be swallowed — the cron runtime has no catch point.
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('supabase.co')) throw new Error('simulated network failure');
      return keepAliveFetch(input);
    };
    let survived = true;
    try {
      await runScheduled({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' });
    } catch {
      survived = false;
    }
    check('a failed ping is swallowed, never rejecting the cron handler', survived === true);
  } finally {
    globalThis.fetch = keepAliveFetch;
  }

  /* --- teardown --------------------------------------------------------- */
  await teacher.removeChannel(channel);
  await teacher.from('exams').delete().eq('code', EXAM.code); // cascades
  await teacher.from('exams').delete().eq('code', SCHED_EXAM.code);
  await teacher.from('exams').delete().eq('code', EDIT_EXAM.code);
  await teacher.from('exams').delete().eq('code', HARD_DEL_EXAM.code);
  await teacher.from('exams').delete().eq('code', SOFT_DEL_EXAM.code);

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
