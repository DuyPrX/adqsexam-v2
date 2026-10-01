/**
 * ADQS Exam v2 — Student exam SPA
 * =====================================================================
 * Runs entirely in the browser against Supabase RPCs. Students hold ZERO
 * table privileges; every interaction goes through a SECURITY DEFINER
 * function (see v2/supabase/schema.sql, Section B/C).
 *
 * Security posture:
 *   - The exam payload is SANITIZED server-side: no correct answers, no
 *     explanations. The browser cannot score, so nothing here is trusted.
 *   - Scoring happens only in submit_exam_result(). This client sends raw
 *     answers, never a score.
 *   - No Firebase. All realtime/proctoring signalling is replaced by the
 *     20s heartbeat RPC (D2).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* =====================================================================
   Constants
   ===================================================================== */

const STORAGE_KEY = 'adqs_student_session_v2';
const THEME_KEY = 'adqs_student_theme';
const HEARTBEAT_MS = 20_000;
const RING_CIRCUMFERENCE = 540;          // 2 * PI * r(86)
const MAX_TEXT_LENGTH = 20_000;
const MAX_DEVICE_INFO = 200;

/** Server RPC result codes -> Vietnamese copy shown to the student. */
const RPC_MESSAGES = {
  EXAM_NOT_FOUND: 'Không tìm thấy mã đề thi này. Vui lòng kiểm tra lại.',
  EXAM_CLOSED: 'Đề thi này đã đóng. Vui lòng liên hệ giáo viên.',
  STUDENT_NOT_WHITELISTED: 'Mã học sinh không có trong danh sách dự thi của đề này.',
  IDENTITY_MISMATCH: 'Họ tên hoặc lớp không khớp với danh sách dự thi.',
  ALREADY_SUBMITTED: 'Bạn đã nộp bài cho đề thi này rồi.',
  SESSION_ACTIVE_ELSEWHERE: 'Tài khoản của bạn đang được đăng nhập trên một thiết bị khác.',
  INVALID_SESSION: 'Phiên làm bài không còn hợp lệ.',
  SESSION_EXPIRED: 'Phiên làm bài đã hết hạn do không hoạt động.',
};

/* =====================================================================
   Tiny DOM helpers
   ===================================================================== */

const $ = (id) => document.getElementById(id);

/** Create an element; `text` is always applied via textContent (XSS-safe). */
function el(tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null) node.setAttribute(k, String(v)); }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function show(node) { node.classList.remove('hidden'); }
function hide(node) { node.classList.add('hidden'); }

/* =====================================================================
   Application state
   ===================================================================== */

const state = {
  supabase: null,
  mode: 'login',            // login | quiz | result | evicted
  // identity
  examCode: '',
  studentCode: '',
  fullName: '',
  className: '',
  sessionToken: null,
  // exam
  exam: null,
  questions: [],
  answers: [],              // per-question draft + confirmed flag
  flags: new Set(),
  currentIndex: 0,
  // timing
  durationSeconds: 0,
  startedAt: null,
  timerHandle: null,
  // telemetry
  blurCount: 0,
  fullscreenExitCount: 0,
  // controls
  heartbeatHandle: null,
  submitting: false,
  antiCheatBound: false,
  lastBlurAt: 0,
};

/* =====================================================================
   Storage
   ===================================================================== */

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.session_token) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSession() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      exam_code: state.examCode,
      student_code: state.studentCode,
      full_name: state.fullName,
      class_name: state.className,
      session_token: state.sessionToken,
      started_at: state.startedAt,
      saved_at: Date.now(),
    }));
  } catch { /* storage unavailable — the exam still works, reload recovery is lost */ }
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/* =====================================================================
   UI primitives
   ===================================================================== */

let toastHandle = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  show(node);
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => hide(node), 4000);
}

function busy(isBusy, message) {
  if (message) $('loadingText').textContent = message;
  if (isBusy) show($('loadingOverlay')); else hide($('loadingOverlay'));
}

function loginError(message) {
  const node = $('loginError');
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

/** Human-readable message for an RPC result code. */
function rpcMessage(code, fallback) {
  return RPC_MESSAGES[code] || fallback || 'Đã xảy ra lỗi. Vui lòng thử lại.';
}

/* =====================================================================
   Theme
   ===================================================================== */

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  renderThemeIcon();
}

function toggleTheme() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = root.getAttribute('data-theme') || (prefersDark ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  renderThemeIcon();
}

function renderThemeIcon() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = root.getAttribute('data-theme') || (prefersDark ? 'dark' : 'light');
  $('themeBtn').textContent = current === 'dark' ? '☀' : '☾';
}

/* =====================================================================
   Supabase client
   ===================================================================== */

function initSupabase() {
  const { supabaseUrl, supabaseKey } = window.APP_CONFIG || {};
  if (!supabaseUrl || !supabaseKey
      || supabaseUrl.startsWith('YOUR_') || supabaseKey.startsWith('YOUR_')) {
    throw new Error(
      'Chưa cấu hình Supabase. Mở config.js hoặc thêm ?sb=<url>&sbkey=<key> vào địa chỉ.',
    );
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Calls an RPC and normalises {data,error} into {ok,data,error}. */
async function callRpc(name, args) {
  const { data, error } = await state.supabase.rpc(name, args);
  if (error) {
    console.error(`RPC ${name} failed`, error);
    return { ok: false, network: true, error };
  }
  return { ok: true, data };
}

/* =====================================================================
   Question type normalisation
   ===================================================================== */

/**
 * The schema stores `question_type` verbatim, so legacy rows may say 'MCQ'
 * while the Phase 2 worker emits 'MULTIPLE_CHOICE'. The scoring RPC treats
 * anything that is not TRUE_FALSE/SHORT_ANSWER/ESSAY as MCQ, and so do we.
 */
function normalizeType(raw) {
  const value = String(raw || '').toUpperCase();
  if (value === 'TRUE_FALSE') return 'TRUE_FALSE';
  if (value === 'SHORT_ANSWER') return 'SHORT_ANSWER';
  if (value === 'ESSAY') return 'ESSAY';
  return 'MCQ';
}

const TYPE_LABEL = {
  MCQ: 'Trắc nghiệm',
  TRUE_FALSE: 'Đúng / Sai',
  SHORT_ANSWER: 'Trả lời ngắn',
  ESSAY: 'Tự luận',
};

const TYPE_BADGE_CLASS = {
  MCQ: 'q-badge--mcq',
  TRUE_FALSE: 'q-badge--tf',
  SHORT_ANSWER: 'q-badge--short',
  ESSAY: 'q-badge--essay',
};

/* =====================================================================
   Login → session acquisition
   ===================================================================== */

async function handleLoginSubmit(event) {
  event.preventDefault();
  loginError('');

  const examCode = $('examCode').value.trim();
  const studentCode = $('studentCode').value.trim();
  const fullName = $('fullName').value.trim();
  const className = $('className').value.trim();

  if (!examCode || !studentCode || !fullName || !className) {
    loginError('Vui lòng nhập đầy đủ Mã đề, Mã học sinh, Họ tên và Lớp.');
    return;
  }
  if (!/^\d{6}$/.test(examCode)) {
    loginError('Mã đề thi phải gồm đúng 6 chữ số.');
    return;
  }

  state.examCode = examCode;
  state.studentCode = studentCode;
  state.fullName = fullName;
  state.className = className;

  // Request fullscreen synchronously: the user gesture is consumed once we
  // await the network call below.
  await requestFullscreen();

  $('startBtn').disabled = true;
  busy(true, 'Đang kiểm tra thông tin…');

  const stored = readSession();
  const existingToken = stored && stored.session_token ? stored.session_token : null;

  try {
    const result = await callRpc('verify_and_acquire_session', {
      p_exam_code: state.examCode,
      p_student_code: state.studentCode,
      p_full_name: state.fullName,
      p_class_name: state.className,
      p_device_info: deviceInfo(),
      p_existing_token: isUuid(existingToken) ? existingToken : null,
    });

    if (!result.ok) {
      loginError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
      return;
    }

    const payload = result.data || {};
    if (payload.success !== true) {
      loginError(rpcMessage(payload.message));
      return;
    }

    state.sessionToken = payload.session_token;
    if (!state.startedAt) state.startedAt = Date.now();
    writeSession();

    await enterExam();
  } finally {
    busy(false);
    $('startBtn').disabled = false;
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function deviceInfo() {
  const ua = navigator.userAgent || '';
  return ua.slice(0, MAX_DEVICE_INFO);
}

/* =====================================================================
   Exam loading
   ===================================================================== */

async function enterExam() {
  busy(true, 'Đang tải đề thi…');
  try {
    const result = await callRpc('get_student_exam_payload', {
      p_exam_code: state.examCode,
      p_session_token: state.sessionToken,
    });

    if (!result.ok) {
      toast('Không tải được đề thi. Vui lòng thử lại.');
      return;
    }

    const payload = result.data || {};
    if (payload.success !== true) {
      const code = payload.message;
      if (code === 'INVALID_SESSION' || code === 'SESSION_EXPIRED') {
        clearSession();
        resetToLogin(rpcMessage(code));
        return;
      }
      resetToLogin(rpcMessage(code, 'Không tải được đề thi.'));
      return;
    }

    state.exam = payload.exam || {};
    state.questions = Array.isArray(payload.questions) ? payload.questions : [];
    state.durationSeconds = Math.max(1, Number(state.exam.duration_minutes) || 45) * 60;
    state.answers = state.questions.map(makeEmptyAnswer);
    state.currentIndex = 0;
    state.flags = new Set();
    state.mode = 'quiz';

    renderQuizShell();
    renderQuestion();
    startTimer();
    startHeartbeat();
    bindAntiCheat();

    hide($('loginScreen'));
    show($('examHeader'));
    show($('progressWrap'));
    hide($('resultScreen'));
    show($('quizScreen'));

    if (state.questions.length === 0) {
      toast('Đề thi này chưa có câu hỏi nào.');
    }
  } finally {
    busy(false);
  }
}

function makeEmptyAnswer(question) {
  const type = normalizeType(question.type);
  if (type === 'TRUE_FALSE') {
    const count = Array.isArray(question.subQuestions) ? question.subQuestions.length : 4;
    return { draft: new Array(Math.max(1, count)).fill(''), confirmed: false };
  }
  if (type === 'MCQ') return { draft: null, confirmed: false };
  return { draft: '', confirmed: false };
}

function resetToLogin(message) {
  stopTimer();
  stopHeartbeat();
  unbindAntiCheat();
  hide($('examHeader'));
  hide($('progressWrap'));
  hide($('quizScreen'));
  hide($('resultScreen'));
  show($('loginScreen'));
  state.mode = 'login';
  if (message) loginError(message);
}

/* =====================================================================
   Quiz shell (header + nav grid)
   ===================================================================== */

function renderQuizShell() {
  $('examTitle').textContent = state.exam.title || 'Bài thi';
  // The nav panel is toggled via the .is-open transform, not the `hidden`
  // class — closeNavPanel() keeps those two mechanisms in sync.
  closeNavPanel();
}

function updateHeader() {
  const total = state.questions.length;
  $('qCounter').textContent = `Câu ${state.currentIndex + 1}/${total}`;
  const flagged = state.flags.size;
  const badge = $('metricFlags');
  if (flagged > 0) { badge.textContent = `⚑ ${flagged}`; show(badge); } else { hide(badge); }
  const percent = total ? ((state.currentIndex + 1) / total) * 100 : 0;
  $('progressBar').style.width = `${percent}%`;
}

/* =====================================================================
   Question rendering
   ===================================================================== */

function renderQuestion() {
  const host = $('questionHost');
  clear(host);

  const question = state.questions[state.currentIndex];
  if (!question) return;

  const type = normalizeType(question.type);
  const answer = state.answers[state.currentIndex];
  updateHeader();

  host.appendChild(buildQuestionHead(question, type));

  const text = el('p', { className: 'q-text', text: question.content || '' });
  host.appendChild(text);

  if (type === 'MCQ') host.appendChild(buildMcqOptions(question, answer));
  else if (type === 'TRUE_FALSE') host.appendChild(buildTrueFalse(question, answer));
  else if (type === 'ESSAY') host.appendChild(buildTextAnswer(question, answer, true));
  else host.appendChild(buildTextAnswer(question, answer, false));

  if (answer.confirmed) {
    host.appendChild(el('p', {
      className: 'locked-note',
      text: 'Đáp án đã được xác nhận và khoá lại.',
    }));
  }

  renderActionBar(type, answer);
  renderNavGrid();
}

function buildQuestionHead(question, type) {
  const head = el('div', { className: 'q-head' });
  const row = el('div', { className: 'q-head__row' });

  row.appendChild(el('span', {
    className: `q-badge ${TYPE_BADGE_CLASS[type]}`,
    text: TYPE_LABEL[type],
  }));
  row.appendChild(el('span', {
    className: 'q-badge__index',
    text: `Câu ${state.currentIndex + 1}/${state.questions.length}`,
  }));

  const tools = el('div', { className: 'q-head__tools' });
  const isFlagged = state.flags.has(state.currentIndex);
  const flagBtn = el('button', {
    className: `flag-btn${isFlagged ? ' is-on' : ''}`,
    text: isFlagged ? '⚑ Đã đánh dấu' : '⚐ Đánh dấu',
    attrs: { type: 'button', 'aria-pressed': String(isFlagged) },
  });
  flagBtn.addEventListener('click', toggleFlag);
  tools.appendChild(flagBtn);
  row.appendChild(tools);

  head.appendChild(row);

  if (type === 'TRUE_FALSE') {
    head.appendChild(el('p', { className: 'q-hint', text: 'Chọn Đúng hoặc Sai cho từng ý a, b, c, d.' }));
  }
  return head;
}

function buildMcqOptions(question, answer) {
  const list = el('div', { className: 'options', attrs: { role: 'radiogroup', 'aria-label': 'Phương án trả lời' } });
  const options = Array.isArray(question.options) ? question.options : [];

  options.forEach((option, index) => {
    const selected = answer.draft === index;
    const btn = el('button', {
      className: 'option',
      attrs: {
        type: 'button',
        role: 'radio',
        'aria-checked': String(selected),
        disabled: answer.confirmed ? 'disabled' : null,
      },
    });
    btn.appendChild(el('span', { className: 'option__key', text: String.fromCharCode(65 + index) }));
    btn.appendChild(el('span', { className: 'option__label', text: option }));
    btn.addEventListener('click', () => selectMcq(index));
    list.appendChild(btn);
  });
  return list;
}

function buildTrueFalse(question, answer) {
  const list = el('div', { className: 'tf-list' });
  const subs = Array.isArray(question.subQuestions) ? question.subQuestions : [];

  subs.forEach((sub, index) => {
    const item = el('div', { className: `tf-item${answer.confirmed ? ' is-locked' : ''}` });
    item.appendChild(el('span', { className: 'tf-item__label', text: `${String.fromCharCode(97 + index)})` }));
    item.appendChild(el('span', { className: 'tf-item__text', text: sub.content || '' }));

    const choice = el('div', { className: 'tf-item__choice' });
    [['Đ', 'Đúng'], ['S', 'Sai']].forEach(([value, label]) => {
      const btn = el('button', {
        className: 'tf-choice',
        text: label,
        attrs: {
          type: 'button',
          'data-value': value,
          'aria-pressed': String(answer.draft[index] === value),
          disabled: answer.confirmed ? 'disabled' : null,
        },
      });
      btn.addEventListener('click', () => selectTrueFalse(index, value));
      choice.appendChild(btn);
    });

    item.appendChild(choice);
    list.appendChild(item);
  });
  return list;
}

function buildTextAnswer(question, answer, isEssay) {
  const wrap = el('div', { className: `text-answer${isEssay ? ' text-answer--essay' : ''}` });
  const field = el('div', { className: 'field' });
  const fieldId = isEssay ? 'essayInput' : 'shortAnswerInput';

  field.appendChild(el('label', { text: isEssay ? 'Bài làm tự luận:' : 'Nhập đáp án của bạn:', attrs: { for: fieldId } }));

  const input = el('textarea', {
    attrs: {
      id: fieldId,
      maxlength: String(MAX_TEXT_LENGTH),
      rows: isEssay ? '8' : '1',
      placeholder: isEssay ? 'Nhập bài làm…' : 'Nhập câu trả lời…',
      disabled: answer.confirmed ? 'disabled' : null,
    },
  });
  input.value = answer.draft || '';
  input.addEventListener('input', () => selectText(input.value));
  field.appendChild(input);

  if (isEssay) {
    field.appendChild(el('p', {
      className: 'text-answer__note',
      text: 'Câu tự luận sẽ được giáo viên chấm sau khi nộp bài.',
    }));
  }
  wrap.appendChild(field);
  return wrap;
}

/* =====================================================================
   Answer interaction (draft -> confirm -> locked)
   ===================================================================== */

function selectMcq(index) {
  const answer = state.answers[state.currentIndex];
  if (answer.confirmed) return;
  answer.draft = index;
  renderQuestion();
}

function selectTrueFalse(subIndex, value) {
  const answer = state.answers[state.currentIndex];
  if (answer.confirmed) return;
  answer.draft[subIndex] = value;
  renderQuestion();
}

function selectText(value) {
  const answer = state.answers[state.currentIndex];
  if (answer.confirmed) return;
  answer.draft = value.slice(0, MAX_TEXT_LENGTH);
  renderActionBar(normalizeType(state.questions[state.currentIndex].type), answer, /* keepFocus */ true);
}

function toggleFlag() {
  const index = state.currentIndex;
  if (state.flags.has(index)) state.flags.delete(index); else state.flags.add(index);
  renderQuestion();
}

function isDraftReady(type, answer) {
  if (type === 'MCQ') return answer.draft !== null;
  if (type === 'TRUE_FALSE') return answer.draft.some((value) => value !== '');
  return String(answer.draft || '').trim() !== '';
}

function confirmAnswer() {
  const answer = state.answers[state.currentIndex];
  if (answer.confirmed) return;
  const type = normalizeType(state.questions[state.currentIndex].type);
  if (!isDraftReady(type, answer)) {
    toast('Vui lòng chọn hoặc nhập đáp án trước khi xác nhận.');
    return;
  }
  answer.confirmed = true;
  renderQuestion();
}

function goNext() {
  const isLast = state.currentIndex >= state.questions.length - 1;
  if (isLast) { openSubmitConfirm(); return; }
  state.currentIndex += 1;
  renderQuestion();
}

function goPrev() {
  if (state.currentIndex <= 0) return;
  state.currentIndex -= 1;
  renderQuestion();
}

function jumpTo(index) {
  state.currentIndex = index;
  closeNavPanel();
  renderQuestion();
}

function renderActionBar(type, answer, keepFocus) {
  const prev = $('prevBtn');
  const confirm = $('confirmBtn');
  const next = $('nextBtn');

  prev.disabled = state.currentIndex === 0;

  const ready = isDraftReady(type, answer);
  if (!answer.confirmed && ready) show(confirm); else hide(confirm);

  const isLast = state.currentIndex >= state.questions.length - 1;
  next.textContent = isLast ? 'Nộp bài →' : 'Câu tiếp theo →';

  if (keepFocus) {
    const field = $('shortAnswerInput') || $('essayInput');
    if (field) { field.focus(); const len = field.value.length; field.setSelectionRange(len, len); }
  }
}

/* =====================================================================
   Navigation panel
   ===================================================================== */

function renderNavGrid() {
  const grid = $('navGrid');
  clear(grid);

  let answered = 0;
  state.questions.forEach((question, index) => {
    const type = normalizeType(question.type);
    const answer = state.answers[index];
    const isAnswered = isDraftReady(type, answer);
    if (isAnswered) answered += 1;

    const item = el('button', {
      className: 'nav-grid__item',
      text: String(index + 1),
      attrs: { type: 'button', 'aria-label': `Câu ${index + 1}` },
    });
    if (isAnswered) item.classList.add('is-answered');
    if (state.flags.has(index)) item.classList.add('is-flagged');
    if (index === state.currentIndex) { item.classList.add('is-current'); item.setAttribute('aria-current', 'true'); }
    item.addEventListener('click', () => jumpTo(index));
    grid.appendChild(item);
  });

  const flagged = state.flags.size;
  $('navProgress').textContent = `Đã trả lời: ${answered}/${state.questions.length}`
    + (flagged ? ` · Đánh dấu: ${flagged}` : '');
}

function openNavPanel() {
  show($('navBackdrop'));
  $('navPanel').classList.add('is-open');
  $('navPanel').setAttribute('aria-hidden', 'false');
  renderNavGrid();
}

function closeNavPanel() {
  hide($('navBackdrop'));
  $('navPanel').classList.remove('is-open');
  $('navPanel').setAttribute('aria-hidden', 'true');
}

/* =====================================================================
   Timer
   ===================================================================== */

function startTimer() {
  stopTimer();
  tickTimer();
  state.timerHandle = setInterval(tickTimer, 1000);
}

function stopTimer() {
  if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
}

function elapsedSeconds() {
  if (!state.startedAt) return 0;
  const raw = Math.floor((Date.now() - state.startedAt) / 1000);
  return Math.max(0, Math.min(state.durationSeconds, raw));
}

function tickTimer() {
  const remaining = Math.max(0, state.durationSeconds - elapsedSeconds());
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const node = $('timerDisplay');
  node.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  node.classList.toggle('is-critical', remaining <= 300);

  if (remaining <= 0 && state.mode === 'quiz' && !state.submitting) {
    stopTimer();
    toast('Hết giờ làm bài. Hệ thống đang thu bài…');
    submitExam(true);
  }
}

/* =====================================================================
   Heartbeat (20s) — session concurrency guard
   ===================================================================== */

function countAnswered() {
  return state.questions.reduce((total, question, index) => {
    return total + (isDraftReady(normalizeType(question.type), state.answers[index]) ? 1 : 0);
  }, 0);
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatHandle = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (state.heartbeatHandle) { clearInterval(state.heartbeatHandle); state.heartbeatHandle = null; }
}

async function sendHeartbeat() {
  if (!state.sessionToken || state.mode !== 'quiz') return;

  const result = await callRpc('record_student_heartbeat', {
    p_exam_code: state.examCode,
    p_student_code: state.studentCode,
    p_session_token: state.sessionToken,
    p_current_q: state.currentIndex,
    p_answered_count: countAnswered(),
    p_blur_count: state.blurCount,
    p_fs_exit_count: state.fullscreenExitCount,
  });

  // A transport failure is transient — never evict a student for it.
  if (!result.ok) return;

  const payload = result.data || {};
  if (payload.success !== true) evictStudent(payload.message);
}

function evictStudent(code) {
  if (state.mode === 'evicted') return;
  state.mode = 'evicted';
  stopTimer();
  stopHeartbeat();
  unbindAntiCheat();
  clearSession();
  hide($('fullscreenOverlay'));
  hide($('confirmOverlay'));
  hide($('loadingOverlay'));
  show($('evictedOverlay'));
  console.warn('Session ended:', code);
}

/* =====================================================================
   Anti-cheat
   ===================================================================== */

const preventDefaultHandler = (event) => event.preventDefault();

function onFullscreenChange() {
  if (state.mode !== 'quiz') return;
  const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsElement) {
    state.fullscreenExitCount += 1;
    show($('fullscreenOverlay'));
  } else {
    hide($('fullscreenOverlay'));
  }
}

function onWindowBlur() {
  if (state.mode !== 'quiz') return;
  if (!$('fullscreenOverlay').classList.contains('hidden')) return;   // our own overlay
  const now = Date.now();
  if (now - state.lastBlurAt < 500) return;                            // blur + visibilitychange pair
  state.lastBlurAt = now;
  state.blurCount += 1;
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onWindowBlur();
}

/** Text fields must stay usable, so selection blocking skips form controls. */
function onSelectStart(event) {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  event.preventDefault();
}

function bindAntiCheat() {
  if (state.antiCheatBound) return;
  state.antiCheatBound = true;

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  document.addEventListener('contextmenu', preventDefaultHandler);
  document.addEventListener('copy', preventDefaultHandler);
  document.addEventListener('cut', preventDefaultHandler);
  document.addEventListener('paste', preventDefaultHandler);
  document.addEventListener('selectstart', onSelectStart);
}

function unbindAntiCheat() {
  if (!state.antiCheatBound) return;
  state.antiCheatBound = false;

  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
  window.removeEventListener('blur', onWindowBlur);
  document.removeEventListener('visibilitychange', onVisibilityChange);

  document.removeEventListener('contextmenu', preventDefaultHandler);
  document.removeEventListener('copy', preventDefaultHandler);
  document.removeEventListener('cut', preventDefaultHandler);
  document.removeEventListener('paste', preventDefaultHandler);
  document.removeEventListener('selectstart', onSelectStart);
}

async function requestFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return;
  try { await request.call(root); } catch { /* user may decline — recorded via exit count */ }
}

async function exitFullscreenIfNeeded() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { if (exit) await exit.call(document); } catch { /* ignore */ }
  }
}

/* =====================================================================
   Keyboard shortcuts
   ===================================================================== */

function isTypingTarget(event) {
  const tag = (event.target && event.target.tagName) || '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function onKeyDown(event) {
  if (state.mode !== 'quiz') return;
  if (!$('confirmOverlay').classList.contains('hidden')) return;

  const type = normalizeType(state.questions[state.currentIndex].type);
  const answer = state.answers[state.currentIndex];
  const key = event.key;
  const lower = key.toLowerCase();
  const typing = isTypingTarget(event);

  // F toggles a review flag, anywhere.
  if (lower === 'f' && !typing) {
    event.preventDefault();
    toggleFlag();
    return;
  }

  // Arrow keys navigate.
  if (key === 'ArrowLeft') { event.preventDefault(); goPrev(); return; }
  if (key === 'ArrowRight') { event.preventDefault(); goNext(); return; }

  // Enter confirms a draft, or advances once locked.
  if (key === 'Enter' && !(typing && (event.target.tagName === 'TEXTAREA'))) {
    event.preventDefault();
    if (answer.confirmed) goNext();
    else if (isDraftReady(type, answer)) confirmAnswer();
    return;
  }

  if (typing) return;

  // A/B/C/D select an MCQ option.
  if (type === 'MCQ' && !answer.confirmed) {
    const map = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 };
    const index = map[lower];
    const options = Array.isArray(state.questions[state.currentIndex].options)
      ? state.questions[state.currentIndex].options : [];
    if (index !== undefined && index < options.length) {
      event.preventDefault();
      selectMcq(index);
    }
  }
}

/* =====================================================================
   Submission
   ===================================================================== */

function buildAnswersPayload() {
  const payload = [];
  state.questions.forEach((question, index) => {
    const type = normalizeType(question.type);
    const answer = state.answers[index];

    if (type === 'MCQ') {
      if (answer.draft !== null) payload.push({ questionIndex: index, selectedIndex: answer.draft });
    } else if (type === 'TRUE_FALSE') {
      if (answer.draft.some((value) => value !== '')) {
        payload.push({ questionIndex: index, selectedAnswers: answer.draft.slice() });
      }
    } else if (String(answer.draft || '').trim() !== '') {
      payload.push({ questionIndex: index, selectedAnswerText: answer.draft });
    }
  });
  return payload;
}

function openSubmitConfirm() {
  if (state.submitting || state.mode !== 'quiz') return;
  const answered = countAnswered();
  const total = state.questions.length;
  $('submitBody').textContent =
    `Bạn đã trả lời ${answered}/${total} câu. Sau khi nộp, bạn không thể sửa lại bài làm.`;
  show($('confirmOverlay'));
}

function closeSubmitConfirm() { hide($('confirmOverlay')); }

async function submitExam(auto) {
  if (state.submitting) return;
  state.submitting = true;
  closeSubmitConfirm();
  stopTimer();
  stopHeartbeat();
  busy(true, 'Đang nộp bài…');

  const answers = buildAnswersPayload();
  const metrics = {
    blurCount: state.blurCount,
    fullscreenExitCount: state.fullscreenExitCount,
    elapsedSeconds: elapsedSeconds(),
  };

  let result = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await callRpc('submit_exam_result', {
      p_exam_code: state.examCode,
      p_student_code: state.studentCode,
      p_session_token: state.sessionToken,
      p_answers: answers,
      p_metrics: metrics,
    });
    if (result.ok) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  busy(false);
  state.submitting = false;

  if (!result || !result.ok) {
    recoverFromFailure(auto, 'Không nộp được bài do lỗi kết nối. Vui lòng thử lại.');
    return;
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    const code = payload.message;
    if (code === 'INVALID_SESSION') { evictStudent(code); return; }
    if (code === 'ALREADY_SUBMITTED') {
      clearSession();
      finishExam();
      renderResult({ alreadySubmitted: true });
      return;
    }
    recoverFromFailure(auto, rpcMessage(code));
    return;
  }

  clearSession();
  finishExam();
  renderResult({
    score: Number(payload.score) || 0,
    total: Number(payload.total_questions) || state.questions.length,
    needsGrading: payload.needs_grading === true,
  });
}

/**
 * Handles a submission that did not go through.
 *
 * A manual attempt can simply return the student to the paper. An automatic
 * one (the clock ran out) must NOT restart the timer: elapsed time is already
 * at the limit, so the next tick would immediately submit again and spin.
 */
function recoverFromFailure(auto, message) {
  if (auto) {
    finishExam();                                  // time is up — the paper is closed
    renderResult({ failed: true, auto: true, message });
    return;
  }
  state.mode = 'quiz';
  startTimer();
  startHeartbeat();
  toast(message);
}

function finishExam() {
  state.mode = 'result';
  stopTimer();
  stopHeartbeat();
  unbindAntiCheat();
  exitFullscreenIfNeeded();
  closeNavPanel();
  hide($('examHeader'));
  hide($('progressWrap'));
  hide($('quizScreen'));
  hide($('fullscreenOverlay'));
  hide($('confirmOverlay'));
}

/* =====================================================================
   Result rendering
   ===================================================================== */

function gradeFor(percent) {
  if (percent >= 85) return { message: 'Hoàn thành tốt', sub: 'Bạn nắm chắc phần lớn nội dung.', cls: 'is-ok' };
  if (percent >= 70) return { message: 'Kết quả khá', sub: 'Tiếp tục ôn các câu còn sai.', cls: 'is-ok' };
  if (percent >= 50) return { message: 'Đạt yêu cầu', sub: 'Nên xem lại phần chưa chắc.', cls: 'is-warn' };
  return { message: 'Cần ôn lại', sub: 'Hãy đọc lại tài liệu và làm lại bài.', cls: 'is-danger' };
}

function renderResult(outcome) {
  show($('resultScreen'));
  const notice = $('resultNotice');

  if (outcome.failed) {
    $('resultPercent').textContent = '—';
    $('ringValue').style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    $('resultHeading').textContent = 'Chưa nộp được bài';
    $('resultScore').textContent = '';
    $('resultSub').textContent = 'Bài làm của bạn vẫn được giữ trên thiết bị này.';
    $('resultPending').textContent = '';
    $('resultElapsed').textContent = '';
    notice.className = `alert ${outcome.auto ? 'alert--warning' : 'alert--error'}`;
    notice.textContent = outcome.message;
    show(notice);
    $('restartBtn').textContent = 'Thử nộp lại';
    // Retry preserves the original trigger: a timed-out attempt stays closed
    // so the timer cannot spin, while a manual attempt returns to the paper.
    $('restartBtn').onclick = () => {
      hide($('resultScreen'));
      state.mode = 'quiz';
      submitExam(outcome.auto === true);
    };
    return;
  }

  if (outcome.alreadySubmitted) {
    $('resultPercent').textContent = '—';
    $('ringValue').style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    $('resultHeading').textContent = 'Bài đã được nộp trước đó';
    $('resultScore').textContent = '';
    $('resultSub').textContent = 'Mỗi học sinh chỉ được nộp bài một lần cho đề thi này.';
    $('resultPending').textContent = '';
    $('resultElapsed').textContent = '';
    notice.className = 'alert alert--info';
    notice.textContent = 'Vui lòng liên hệ giáo viên nếu bạn cần xem lại kết quả.';
    show(notice);
    $('restartBtn').textContent = 'Làm bài khác';
    $('restartBtn').onclick = restart;
    return;
  }

  const total = Math.max(1, outcome.total || 1);
  const percent = Math.round((outcome.score / total) * 100);
  const grade = gradeFor(percent);

  hide(notice);
  $('resultPercent').textContent = `${percent}%`;
  $('resultHeading').textContent = grade.message;
  $('resultScore').textContent = `Điểm tự động: ${formatScore(outcome.score)}/${total}`;
  $('resultSub').textContent = grade.sub;
  $('resultElapsed').textContent = formatElapsed(elapsedSeconds());

  if (outcome.needsGrading) {
    $('resultPending').textContent =
      'Bài có câu tự luận — điểm hiển thị là điểm tự động tạm thời, giáo viên sẽ chấm phần tự luận.';
    show($('resultPending'));
  } else {
    hide($('resultPending'));
  }

  const ring = $('ringValue');
  ring.classList.remove('is-ok', 'is-warn', 'is-danger');
  ring.classList.add(grade.cls);
  // Trigger the transition after the element is visible.
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - percent / 100));
  });

  $('restartBtn').textContent = 'Làm bài khác';
  $('restartBtn').onclick = restart;
}

function formatScore(value) {
  return Math.round(value * 100) / 100;
}

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `Thời gian làm bài: ${minutes} phút ${seconds % 60} giây`;
}

function restart() {
  clearSession();
  window.location.reload();
}

/* =====================================================================
   Boot
   ===================================================================== */

async function tryResumeSession() {
  const stored = readSession();
  if (!stored || !isUuid(stored.session_token)) return false;

  state.examCode = stored.exam_code || '';
  state.studentCode = stored.student_code || '';
  state.fullName = stored.full_name || '';
  state.className = stored.class_name || '';
  state.sessionToken = stored.session_token;
  state.startedAt = stored.started_at || Date.now();

  busy(true, 'Đang khôi phục phiên làm bài…');
  try {
    const result = await callRpc('verify_and_acquire_session', {
      p_exam_code: state.examCode,
      p_student_code: state.studentCode,
      p_full_name: state.fullName,
      p_class_name: state.className,
      p_device_info: deviceInfo(),
      p_existing_token: state.sessionToken,
    });

    if (!result.ok || !result.data || result.data.success !== true) {
      clearSession();
      return false;
    }

    // SESSION_RESUMED confirms this is the same device; SESSION_ACQUIRED means
    // a stale session was legitimately taken over.
    state.sessionToken = result.data.session_token || state.sessionToken;
    writeSession();
    await requestFullscreen();
    await enterExam();
    return true;
  } finally {
    busy(false);
  }
}

function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) $('examCode').value = code.slice(0, 6);
}

async function boot() {
  initTheme();
  prefillFromUrl();

  try {
    state.supabase = initSupabase();
  } catch (error) {
    loginError(error.message);
    $('startBtn').disabled = true;
    return;
  }

  $('loginForm').addEventListener('submit', handleLoginSubmit);
  $('navToggleBtn').addEventListener('click', openNavPanel);
  $('navCloseBtn').addEventListener('click', closeNavPanel);
  $('navBackdrop').addEventListener('click', closeNavPanel);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('prevBtn').addEventListener('click', goPrev);
  $('nextBtn').addEventListener('click', goNext);
  $('confirmBtn').addEventListener('click', confirmAnswer);
  $('fsResumeBtn').addEventListener('click', () => { requestFullscreen(); hide($('fullscreenOverlay')); });
  $('evictedBtn').addEventListener('click', () => window.location.reload());
  $('submitCancelBtn').addEventListener('click', closeSubmitConfirm);
  $('submitConfirmBtn').addEventListener('click', () => submitExam(false));
  document.addEventListener('keydown', onKeyDown);

  const resumed = await tryResumeSession();
  if (!resumed) show($('loginScreen'));
}

boot();
