/**
 * Phase 4 contract test — exercises the student RPC surface exactly as the
 * browser SPA does (anon role + publishable key, no table access).
 *
 * Usage: node verify_student_rpcs.mjs
 * Requires the local Supabase stack + phase4_student_fixture.sql applied.
 */

const BASE = process.env.SB_URL || 'http://127.0.0.1:54321';
const KEY = process.env.SB_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const EXAM = 'STU001';
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`); }
}

async function rpc(fn, args) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const IDENTITY = {
  p_exam_code: EXAM,
  p_student_code: 'HS001',
  p_full_name: 'Nguyễn Văn A',
  p_class_name: '12A1',
  p_device_info: 'verifier/1.0',
};

console.log('\n=== 1. Session acquisition ===');

// 1a. wrong student code
let r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_student_code: 'NOPE', p_existing_token: null });
check('unknown student -> STUDENT_NOT_WHITELISTED', r.body?.message === 'STUDENT_NOT_WHITELISTED', JSON.stringify(r.body));

// 1b. identity mismatch (name case-insensitive match, but wrong name should fail)
r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_full_name: 'Trần Thị B', p_existing_token: null });
check('wrong full name -> IDENTITY_MISMATCH', r.body?.message === 'IDENTITY_MISMATCH', JSON.stringify(r.body));

// 1c. wrong class
r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_class_name: '12A9', p_existing_token: null });
check('wrong class -> IDENTITY_MISMATCH', r.body?.message === 'IDENTITY_MISMATCH', JSON.stringify(r.body));

// 1d. unknown exam
r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_exam_code: 'ZZZ999', p_existing_token: null });
check('unknown exam -> EXAM_NOT_FOUND', r.body?.message === 'EXAM_NOT_FOUND', JSON.stringify(r.body));

// 1e. happy path (case/space tolerance on identity)
r = await rpc('verify_and_acquire_session', {
  ...IDENTITY,
  p_full_name: '  nguyễn văn a  ',
  p_class_name: ' 12a1 ',
  p_existing_token: null,
});
const token = r.body?.session_token;
check('valid credentials -> success', r.body?.success === true, JSON.stringify(r.body));
check('returns a uuid session_token', typeof token === 'string' && token.length === 36, String(token));
check('message is SESSION_ACQUIRED', r.body?.message === 'SESSION_ACQUIRED', r.body?.message);

console.log('\n=== 2. Reload tolerance (F5) ===');
r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_existing_token: token });
check('same token reload -> SESSION_RESUMED', r.body?.message === 'SESSION_RESUMED', JSON.stringify(r.body));
check('same token preserved', r.body?.session_token === token, `got ${r.body?.session_token}`);

console.log('\n=== 3. Single-device concurrency lock ===');
const otherToken = '00000000-0000-0000-0000-000000000000';
r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_device_info: 'other-device', p_existing_token: otherToken });
check('foreign device -> SESSION_ACTIVE_ELSEWHERE', r.body?.message === 'SESSION_ACTIVE_ELSEWHERE', JSON.stringify(r.body));

console.log('\n=== 4. Zero-knowledge payload ===');
r = await rpc('get_student_exam_payload', { p_exam_code: EXAM, p_session_token: token });
const payload = r.body;
check('payload success', payload?.success === true, JSON.stringify(payload).slice(0, 200));
check('exam metadata present', payload?.exam?.code === EXAM && payload?.exam?.total_questions === 4, JSON.stringify(payload?.exam));

const raw = JSON.stringify(payload);
check('no correct_answer field', !raw.includes('correct_answer'));
check('no correctAnswer field', !raw.includes('correctAnswer'));
check('no correctIndex field', !raw.includes('correctIndex'));
check('no correctAnswers field', !raw.includes('correctAnswers'));
check('no explanation field', !raw.includes('explanation'));
check('no answer-key values leaked', !raw.includes('Hà Nội là thủ đô'));

const qs = payload?.questions || [];
check('4 questions returned', qs.length === 4, String(qs.length));
const byType = Object.fromEntries(qs.map((q) => [q.type, q]));
check('MCQ options preserved', Array.isArray(byType.MULTIPLE_CHOICE?.options) && byType.MULTIPLE_CHOICE.options.length === 4, JSON.stringify(byType.MULTIPLE_CHOICE?.options));
check('MCQ has no subQuestions key', !('subQuestions' in (byType.MULTIPLE_CHOICE || {})));
check('TRUE_FALSE rendered as subQuestions', Array.isArray(byType.TRUE_FALSE?.subQuestions) && byType.TRUE_FALSE.subQuestions.length === 4, JSON.stringify(byType.TRUE_FALSE?.subQuestions));
check('TRUE_FALSE options emptied', Array.isArray(byType.TRUE_FALSE?.options) && byType.TRUE_FALSE.options.length === 0);
check('TRUE_FALSE sub-items carry content only', byType.TRUE_FALSE?.subQuestions?.every((s) => Object.keys(s).length === 1 && 'content' in s), JSON.stringify(byType.TRUE_FALSE?.subQuestions));
check('question indices are 0-based contiguous', qs.every((q, i) => q.index === i), JSON.stringify(qs.map((q) => q.index)));

console.log('\n=== 5. Heartbeat ===');
r = await rpc('record_student_heartbeat', {
  p_exam_code: EXAM, p_student_code: 'HS001', p_session_token: token,
  p_current_q: 2, p_answered_count: 2, p_blur_count: 1, p_fs_exit_count: 0,
});
check('heartbeat ok', r.body?.success === true, JSON.stringify(r.body));
check('server_time returned', typeof r.body?.server_time === 'string', JSON.stringify(r.body));

r = await rpc('record_student_heartbeat', {
  p_exam_code: EXAM, p_student_code: 'HS001', p_session_token: otherToken,
  p_current_q: 0, p_answered_count: 0, p_blur_count: 0, p_fs_exit_count: 0,
});
check('stale token -> INVALID_SESSION (eviction trigger)', r.body?.message === 'INVALID_SESSION', JSON.stringify(r.body));

console.log('\n=== 6. Students cannot touch tables directly ===');
const tableRes = await fetch(`${BASE}/rest/v1/question_bank?select=correct_answer`, {
  headers: { apikey: KEY },
});
check('anon cannot read question_bank', tableRes.status === 401 || tableRes.status === 403 || tableRes.status === 404, `status=${tableRes.status}`);

console.log('\n=== 7. Authoritative submission ===');
const answers = [
  { questionIndex: 0, selectedIndex: 0 },                                   // correct
  { questionIndex: 1, selectedAnswers: ['Đ', 'S', 'Đ', 'S'] },              // 4/4
  { questionIndex: 2, selectedAnswerText: ' 3 ' },                          // correct after normalise
  { questionIndex: 3, selectedAnswerText: 'Quê hương em rất đẹp.' },        // essay
];
r = await rpc('submit_exam_result', {
  p_exam_code: EXAM, p_student_code: 'HS001', p_session_token: token,
  p_answers: answers,
  p_metrics: { blurCount: 1, fullscreenExitCount: 0, elapsedSeconds: 1200 },
});
check('submit success', r.body?.success === true, JSON.stringify(r.body));
check('server score = 3 (1 MCQ + 1 T/F + 1 SHORT + 0 ESSAY)', Number(r.body?.score) === 3, String(r.body?.score));
check('total_questions = 4', Number(r.body?.total_questions) === 4, String(r.body?.total_questions));
check('needs_grading = true (essay present)', r.body?.needs_grading === true, String(r.body?.needs_grading));

console.log('\n=== 8. Duplicate submission blocked ===');
r = await rpc('submit_exam_result', {
  p_exam_code: EXAM, p_student_code: 'HS001', p_session_token: token,
  p_answers: [], p_metrics: {},
});
check('second submit -> INVALID_SESSION (session retired)', r.body?.message === 'INVALID_SESSION', JSON.stringify(r.body));

r = await rpc('verify_and_acquire_session', { ...IDENTITY, p_existing_token: null });
check('re-login after submit -> ALREADY_SUBMITTED', r.body?.message === 'ALREADY_SUBMITTED', JSON.stringify(r.body));

console.log(`\n================ ${passed} passed, ${failed} failed ================\n`);
process.exit(failed === 0 ? 0 : 1);
