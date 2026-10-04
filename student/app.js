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
import { orderPracticeQuestions, readShuffleToggle, shuffledOrder } from './practice-order.js';

/* =====================================================================
   Constants
   ===================================================================== */

const STORAGE_KEY = 'adqs_student_session_v2';
const THEME_KEY = 'adqs_student_theme';
const HEARTBEAT_MS = 20_000;
const RING_CIRCUMFERENCE = 540;          // 2 * PI * r(86)
const MAX_TEXT_LENGTH = 20_000;
const MAX_DEVICE_INFO = 200;
const CERT_PASS_PERCENT = 80;            // must match schema: score/total >= 0.8
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Server RPC result codes -> Vietnamese copy shown to the student. */
const RPC_MESSAGES = {
  EXAM_NOT_FOUND: 'Không tìm thấy mã đề thi này. Vui lòng kiểm tra lại.',
  EXAM_INACTIVE: 'Đề thi này đang đóng. Vui lòng liên hệ giáo viên.',
  EXAM_NOT_STARTED: 'Đề thi chưa đến giờ mở. Vui lòng chờ đến thời gian bắt đầu.',
  EXAM_EXPIRED: 'Đề thi đã hết thời gian mở. Vui lòng liên hệ giáo viên.',
  STUDENT_NOT_WHITELISTED: 'Mã học sinh không có trong danh sách dự thi của đề này.',
  IDENTITY_MISMATCH: 'Họ tên hoặc lớp không khớp với danh sách dự thi.',
  ALREADY_SUBMITTED: 'Bạn đã nộp bài cho đề thi này rồi.',
  SESSION_ACTIVE_ELSEWHERE: 'Tài khoản của bạn đang được đăng nhập trên một thiết bị khác.',
  INVALID_SESSION: 'Phiên làm bài không còn hợp lệ.',
  SESSION_EXPIRED: 'Phiên làm bài đã hết hạn do không hoạt động.',
  // Phase 5.8 — practice-by-code refusals.
  PRACTICE_NOT_ALLOWED: 'Giáo viên chưa mở đề này cho chế độ luyện tập.',
  PRACTICE_EMPTY: 'Đề này chưa có câu hỏi nào để luyện tập.',
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
  mode: 'login',            // login | quiz | result | evicted | practice
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
  // certificate (set only for a passing submission)
  certificate: null,
  // practice mode: questions carry their own correct_answer + explanation
  practiceQuestions: [],
  practiceStartedAt: null,
  /**
   * Phase 5.8 — the chosen practice source: 'code' (a teacher-enabled exam) or
   * 'file' (a personal .docx). Only affects the landing form.
   */
  practiceSource: 'code',
  /**
   * Phase 5.9 — whether the current practice run shuffles its questions. Read
   * from #practice-shuffle-toggle when practice starts; false = source order.
   */
  practiceShuffle: false,
  /**
   * Phase 5.8 — true for the whole self-practice session. `state.mode` flips to
   * 'result' before the result screen renders, so the certificate gate needs a
   * flag that survives that transition (rule 4: practice NEVER certifies).
   */
  isPractice: false,
  /**
   * Phase 5.8 — official-exam display shuffle.
   * `displayOrder[displayIndex]` is the question's ORIGINAL 0-based position.
   * The server grades `questionIndex` against `position ASC`, so answers are
   * re-mapped through this array before `submit_exam_result`. Null in practice
   * mode, where the original order is preserved verbatim.
   */
  displayOrder: null,
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

/**
 * Applies the per-student display shuffle to the official exam.
 *
 * The Fisher-Yates permutation lives in `practice-order.js` (imported above) so
 * this shuffle and the Phase 5.9 practice toggle share ONE implementation, and
 * the e2e suite can exercise it without loading this DOM-bound module.
 *
 * `state.questions` becomes the DISPLAY array (shuffled), while the untouched
 * originals are kept in `state.displayOrder`. Options are NOT reordered — their
 * indices are tied to the stored `correct_answer`.
 */
function applyDisplayShuffle() {
  const total = state.questions.length;
  if (total < 2) {
    state.displayOrder = null;
    return;
  }
  const order = shuffledOrder(total);
  state.displayOrder = order;
  state.questions = order.map((originalIndex) => state.questions[originalIndex]);
}

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
    // Phase 5.8: shuffle the QUESTION order per candidate. Must run before the
    // answer slots are created so state.answers stays parallel to the display.
    applyDisplayShuffle();
    state.isPractice = false;
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
  state.isPractice = false;
  state.displayOrder = null;
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
  // Zero anti-cheat in self-practice (Phase 5.2 §Business rules 2): no
  // fullscreen lock, no blur tracking, no context-menu/selection blocking.
  if (state.mode === 'practice') return;
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
  // Practice mode reuses the same shortcuts but never the guards.
  if (state.mode !== 'quiz' && state.mode !== 'practice') return;
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
    // The display slot maps back to the question's ORIGINAL 0-based position;
    // the server grades against `position ASC` (see state.displayOrder).
    const questionIndex = state.displayOrder ? state.displayOrder[index] : index;

    if (type === 'MCQ') {
      if (answer.draft !== null) payload.push({ questionIndex, selectedIndex: answer.draft });
    } else if (type === 'TRUE_FALSE') {
      if (answer.draft.some((value) => value !== '')) {
        payload.push({ questionIndex, selectedAnswers: answer.draft.slice() });
      }
    } else if (String(answer.draft || '').trim() !== '') {
      payload.push({ questionIndex, selectedAnswerText: answer.draft });
    }
  });
  return payload;
}

function openSubmitConfirm() {
  if (state.submitting) return;
  const practice = state.mode === 'practice';
  if (state.mode !== 'quiz' && !practice) return;
  const answered = countAnswered();
  const total = state.questions.length;
  $('submitBody').textContent = practice
    ? `Bạn đã trả lời ${answered}/${total} câu. Hệ thống sẽ chấm điểm và hiện đáp án ngay.`
    : `Bạn đã trả lời ${answered}/${total} câu. Sau khi nộp, bạn không thể sửa lại bài làm.`;
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
    resultId: isUuid(payload.result_id) ? payload.result_id : null,
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
  hide($('achievementBanner'));
  hide($('practiceReview'));
  state.certificate = null;

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
  const practice = outcome.practice === true;

  hide(notice);
  $('resultPercent').textContent = `${percent}%`;
  $('resultHeading').textContent = grade.message;
  $('resultScore').textContent = practice
    ? `Kết quả ôn luyện: ${formatScore(outcome.score)}/${total}`
    : `Điểm tự động: ${formatScore(outcome.score)}/${total}`;
  $('resultSub').textContent = grade.sub;
  $('resultElapsed').textContent = practice
    ? `Thời gian ôn luyện: ${formatDuration(practiceElapsedSeconds())}`
    : formatElapsed(elapsedSeconds());

  if (outcome.needsGrading) {
    $('resultPending').textContent = practice
      ? 'Bài có câu tự luận — phần này không chấm tự động, hãy đối chiếu đáp án bên dưới.'
      : 'Bài có câu tự luận — điểm hiển thị là điểm tự động tạm thời, giáo viên sẽ chấm phần tự luận.';
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

  $('restartBtn').textContent = practice ? 'Ôn bài khác' : 'Làm bài khác';
  $('restartBtn').onclick = restart;

  // Practice: reveal the answer key. No certificate — nothing was persisted (3).
  if (practice) {
    renderPracticeReview(outcome.review || []);
    return;
  }

  checkAndShowCertificateOption(outcome);
}

/**
 * Phase 5.8 rule 4 — practice NEVER issues a certificate.
 *
 * The check is deliberately belt-and-braces: `state.isPractice` survives the
 * mode flip to 'result' (state.mode alone would already be 'result' by the time
 * the banner is considered), and `state.mode === 'practice'` covers any caller
 * that invokes this while a practice session is still live. Nothing was written
 * to Supabase in practice mode either, so `resultId` is always null there — the
 * certificate could not be minted even if this gate were bypassed.
 */
function checkAndShowCertificateOption(outcome) {
  if (state.isPractice || state.mode === 'practice') return;
  if (outcome.practice === true) return;

  const total = Math.max(1, outcome.total || 1);
  const percent = Math.round((outcome.score / total) * 100);

  // Passing result (>= 80%) unlocks the certificate. The server enforces the
  // same threshold in get_certificate_verification, so this is presentation
  // only — a forged banner cannot mint a verifiable certificate.
  if (percent >= CERT_PASS_PERCENT && outcome.resultId) {
    state.certificate = {
      resultId: outcome.resultId,
      score: outcome.score,
      total,
      percent,
    };
    show($('achievementBanner'));
  }
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes} phút ${seconds % 60} giây`;
}

/* =====================================================================
   Certificate modal
   ===================================================================== */

function openCertificate() {
  const cert = state.certificate;
  if (!cert) return;

  $('certName').textContent = state.fullName || '—';
  $('certStudentCode').textContent = state.studentCode || '—';
  $('certClass').textContent = state.className || '—';
  $('certExam').textContent = state.exam?.title || state.examCode || '—';
  $('certScore').textContent = `${formatScore(cert.score)}/${cert.total} (${cert.percent}%)`;
  $('certDate').textContent = formatDate(new Date());

  renderQrCode(`${window.location.origin}/verify.html?id=${cert.resultId}`);
  show($('certOverlay'));
}

function closeCertificate() { hide($('certOverlay')); }

/** Renders the verification QR via qrcodejs (loaded by index.html). */
function renderQrCode(url) {
  const host = $('certQr');
  clear(host);

  if (typeof window.QRCode !== 'function') {
    host.appendChild(el('p', { className: 'cert-sheet__qr-caption', text: 'Không tải được mã QR.' }));
    console.warn('qrcodejs unavailable; certificate rendered without QR.');
    return;
  }

  // eslint-disable-next-line no-new
  new window.QRCode(host, {
    text: url,
    width: 150,
    height: 150,
    colorDark: '#1a1a2e',
    colorLight: '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
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
   Self-practice mode (Phase 5.2)
   =====================================================================
   Business rules enforced here:
     1. Authorization   — verify_student_practice() against ANY roster.
     2. Zero anti-cheat — no fullscreen, no blur/telemetry, no input blocking.
     3. Zero DB clutter — nothing is written to Supabase; no session row, no
                          result row. Answers live in RAM only.
     4. Zero AI cost    — the Worker endpoint is hard-wired to the rule engine.
   ===================================================================== */

/** Maps the Worker's question shape onto the renderer's shape. */
function normalizePracticeQuestions(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map((raw, index) => {
    const type = normalizeType(raw.question_type);
    const options = Array.isArray(raw.options) ? raw.options.slice() : [];
    const question = {
      type,
      content: String(raw.question_text || ''),
      options,
      subQuestions: [],
      // Phase 5.9: the source ordinal, so the practice form can offer the true
      // original order. The by-code RPC already returns `position ASC`, so its
      // payload is in order; a .docx extraction carries its own `position`.
      position: Number(raw.position) || index + 1,
      // Practice keeps the key locally: grading is client-side by design.
      correctAnswer: raw.correct_answer === undefined ? null : raw.correct_answer,
      explanation: raw.explanation || null,
    };
    if (type === 'TRUE_FALSE') {
      question.subQuestions = options.map((content) => ({ content }));
    }
    return question;
  });
}

function practiceError(message) {
  const node = $('practiceError');
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

/** Switches the landing card between the official exam and practice forms. */
function selectModeTab(mode) {
  const official = mode === 'official';
  $('tabOfficial').classList.toggle('is-active', official);
  $('tabPractice').classList.toggle('is-active', !official);
  $('tabOfficial').setAttribute('aria-selected', String(official));
  $('tabPractice').setAttribute('aria-selected', String(!official));

  if (official) {
    show($('officialPanel'));
    hide($('practicePanel'));
    loginError('');
  } else {
    hide($('officialPanel'));
    show($('practicePanel'));
    practiceError('');
  }
}

/**
 * Phase 5.8 — switches the practice form between "by exam code" and "by .docx".
 * Both share the identity fields; only the question SOURCE differs.
 */
function selectPracticeSource(source) {
  const byCode = source === 'code';
  state.practiceSource = byCode ? 'code' : 'file';
  $('practiceSourceCodeBtn').classList.toggle('is-active', byCode);
  $('practiceSourceFileBtn').classList.toggle('is-active', !byCode);
  $('practiceSourceCodeBtn').setAttribute('aria-selected', String(byCode));
  $('practiceSourceFileBtn').setAttribute('aria-selected', String(!byCode));

  if (byCode) { show($('practiceCodeFields')); hide($('practiceFileFields')); }
  else { hide($('practiceCodeFields')); show($('practiceFileFields')); }
  practiceError('');
}

/**
 * Phase 5.8 — builds the practice question set from a teacher-enabled exam.
 *
 * `get_practice_exam_payload` is the only RPC that returns answer keys for a
 * stored exam, and it does so ONLY when the teacher set `allow_practice` and
 * the caller is on the exam's roster.
 */
async function loadPracticeFromExamCode(examCode) {
  const result = await callRpc('get_practice_exam_payload', {
    p_exam_code: examCode,
    p_student_code: state.studentCode,
    p_class_name: state.className,
  });

  if (!result.ok) {
    return { ok: false, message: 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.' };
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    return { ok: false, message: rpcMessage(payload.message, 'Không mở được đề luyện tập này.') };
  }

  const raw = Array.isArray(payload.questions) ? payload.questions.slice() : [];
  if (raw.length === 0) return { ok: false, message: rpcMessage('PRACTICE_EMPTY') };

  // Contract: questions come in original `position ASC` order. Sort defensively
  // so a malformed `index` can never reorder the paper (practice must NOT shuffle).
  raw.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

  return {
    ok: true,
    title: payload.exam?.title || examCode,
    questions: normalizePracticeQuestions(raw),
  };
}

async function handlePracticeSubmit(event) {
  event.preventDefault();
  practiceError('');

  const studentCode = $('practiceStudentCode').value.trim();
  const className = $('practiceClassName').value.trim();

  if (!studentCode || !className) {
    practiceError('Vui lòng nhập Mã học sinh và Lớp.');
    return;
  }
  state.studentCode = studentCode;
  state.className = className;

  $('practiceStartBtn').disabled = true;
  busy(true, 'Đang kiểm tra thông tin…');

  try {
    if (state.practiceSource === 'code') {
      await startPracticeByCode();
    } else {
      await startPracticeByFile();
    }
  } finally {
    busy(false);
    $('practiceStartBtn').disabled = false;
  }
}

/** Practice source A — a teacher-enabled exam, fetched by code. */
async function startPracticeByCode() {
  const examCode = $('practice-exam-code').value.trim();
  if (!examCode) {
    practiceError('Vui lòng nhập mã đề luyện tập.');
    return;
  }

  busy(true, 'Đang mở đề luyện tập…');
  const loaded = await loadPracticeFromExamCode(examCode);
  if (!loaded.ok) {
    practiceError(loaded.message);
    return;
  }

  state.fullName = '';
  state.examCode = examCode;
  state.practiceQuestions = loaded.questions;
  enterPractice(loaded.title);
}

/** Practice source B — a personal .docx parsed on the fly (Phase 5.2). */
async function startPracticeByFile() {
  const fileInput = $('practiceFile');
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    practiceError('Vui lòng chọn file đề ôn tập (.docx).');
    return;
  }
  if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) {
    practiceError('Chỉ hỗ trợ file .docx (Word).');
    return;
  }

  // --- 1. Authorization ---------------------------------------------------
  const auth = await callRpc('verify_student_practice', {
    p_student_code: state.studentCode,
    p_class_name: state.className,
  });
  if (!auth.ok) {
    practiceError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    return;
  }
  if (auth.data?.authorized !== true) {
    practiceError(auth.data?.message
      || 'Thông tin học sinh không có trong danh sách được phép ôn luyện.');
    return;
  }

  // --- 2. Extract (rule engine only, no secret) ---------------------------
  busy(true, 'Đang đọc đề ôn tập…');
  const payload = await extractPracticeDocx(file);
  if (!payload.ok) {
    practiceError(payload.message);
    return;
  }
  if (payload.questions.length === 0) {
    practiceError('Không tìm thấy câu hỏi nào trong file. Vui lòng kiểm tra lại đề.');
    return;
  }

  // --- 3. Enter practice --------------------------------------------------
  state.fullName = auth.data?.student_name || '';
  state.examCode = '';
  state.practiceQuestions = payload.questions;
  enterPractice(file.name.replace(/\.docx$/i, ''));
}

/** POSTs the .docx to the public practice endpoint (forced mode=rule). */
async function extractPracticeDocx(file) {
  const endpoint = (window.APP_CONFIG || {}).practiceApiUrl;
  if (!endpoint) {
    return { ok: false, message: 'Chưa cấu hình địa chỉ máy chủ ôn luyện.' };
  }

  const body = new FormData();
  body.append('file', file);

  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', body });
  } catch (error) {
    console.error('Practice extraction failed', error);
    return { ok: false, message: 'Không kết nối được máy chủ ôn luyện. Vui lòng thử lại.' };
  }

  let json = null;
  try { json = await response.json(); } catch { /* non-JSON body */ }

  if (!response.ok || !json) {
    return {
      ok: false,
      message: json?.error?.message || `Máy chủ trả về lỗi (${response.status}).`,
    };
  }

  return { ok: true, questions: normalizePracticeQuestions(json.data) };
}

function enterPractice(title) {
  state.mode = 'practice';
  state.isPractice = true;
  // Phase 5.9: the student chooses the display order per run. Reading the toggle
  // HERE (rather than in each source handler) means both practice sources —
  // by-code and by-.docx — honour the same setting with one code path.
  const shouldShuffle = readShuffleToggle(document);
  state.practiceShuffle = shouldShuffle;
  // Practice is graded entirely in RAM (no server round-trip), so shuffling the
  // questions array needs no index re-mapping: every question carries its own
  // `correctAnswer`, and `displayOrder` stays null because nothing is submitted.
  state.displayOrder = null;
  state.questions = orderPracticeQuestions(state.practiceQuestions, shouldShuffle);
  state.answers = state.questions.map(makeEmptyAnswer);
  state.currentIndex = 0;
  state.flags = new Set();
  state.blurCount = 0;
  state.fullscreenExitCount = 0;
  state.practiceStartedAt = Date.now();
  // Practice has no server exam record; the title is derived from the source.
  state.exam = { title };

  renderQuizShell();
  renderQuestion();

  // No timer and no heartbeat: practice is untimed and has no live session (2,3).
  $('timerDisplay').textContent = '∞';
  $('timerDisplay').classList.remove('is-critical');

  // bindAntiCheat() is a no-op while mode === 'practice' (rule 2).
  bindAntiCheat();

  hide($('loginScreen'));
  show($('examHeader'));
  show($('progressWrap'));
  hide($('resultScreen'));
  show($('quizScreen'));
}

function practiceElapsedSeconds() {
  if (!state.practiceStartedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - state.practiceStartedAt) / 1000));
}

/* ---------------------------------------------------- practice grading */

function letterFor(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : '?';
}

function normalizeShort(text) {
  return String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
}

/** Grades one answer against the locally-held key (mirrors the server scale). */
function gradePracticeQuestion(question, answer) {
  const type = question.type;

  if (type === 'MCQ') {
    const raw = question.correctAnswer;
    const correct = Number.isInteger(raw) ? raw
      : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null);
    const chosen = answer.draft;
    const options = question.options;
    return {
      points: chosen !== null && correct !== null && chosen === correct ? 1 : 0,
      verdict: chosen === null ? 'neutral' : (chosen === correct ? 'correct' : 'wrong'),
      userText: chosen === null ? 'Chưa trả lời'
        : `${letterFor(chosen)}. ${options[chosen] ?? ''}`,
      correctText: correct === null ? 'Không có đáp án'
        : `${letterFor(correct)}. ${options[correct] ?? ''}`,
    };
  }

  if (type === 'TRUE_FALSE') {
    const correctArr = Array.isArray(question.correctAnswer) ? question.correctAnswer : [];
    const userArr = Array.isArray(answer.draft) ? answer.draft : [];
    let hits = 0;
    let answered = 0;
    const correctLines = [];
    const userLines = [];

    question.subQuestions.forEach((sub, i) => {
      const expected = correctArr[i];
      const given = userArr[i] || '';
      if (given) answered += 1;
      if (expected !== undefined && given && given === expected) hits += 1;
      correctLines.push(`${letterFor(i).toLowerCase()}) ${expected ?? '—'}`);
      userLines.push(`${letterFor(i).toLowerCase()}) ${given || '—'}`);
    });

    // Server scale: 4→1.0, 3→0.5, 2→0.25, 1→0.1
    const points = hits === 4 ? 1 : hits === 3 ? 0.5 : hits === 2 ? 0.25 : hits === 1 ? 0.1 : 0;
    return {
      points,
      verdict: hits === 4 ? 'correct' : (answered > 0 ? 'wrong' : 'neutral'),
      userText: answered > 0 ? userLines.join(' · ') : 'Chưa trả lời',
      correctText: correctLines.join(' · '),
      subResults: question.subQuestions.map((sub, i) => ({
        index: i,
        expected: correctArr[i],
        given: userArr[i] || '',
        isCorrect: correctArr[i] !== undefined && userArr[i] === correctArr[i],
      })),
    };
  }

  if (type === 'ESSAY') {
    const text = String(answer.draft || '').trim();
    return {
      points: 0,
      verdict: text ? 'neutral' : 'wrong',
      userText: text || 'Chưa trả lời',
      correctText: question.correctAnswer != null ? String(question.correctAnswer) : null,
      autoGraded: false,
    };
  }

  // SHORT_ANSWER
  const text = String(answer.draft || '').trim();
  const expected = question.correctAnswer == null ? null : String(question.correctAnswer);
  const isCorrect = expected !== null && normalizeShort(text) === normalizeShort(expected);
  return {
    points: isCorrect ? 1 : 0,
    verdict: !text ? 'neutral' : (isCorrect ? 'correct' : 'wrong'),
    userText: text || 'Chưa trả lời',
    correctText: expected ?? 'Không có đáp án',
  };
}

/** Grades every answer on the client and returns the review rows. */
function gradePractice() {
  const review = [];
  let score = 0;
  let needsManual = false;

  state.questions.forEach((question, index) => {
    const result = gradePracticeQuestion(question, state.answers[index]);
    if (result.autoGraded === false) needsManual = true;
    score += result.points;
    review.push({ index, question, ...result });
  });

  return {
    score: Math.round(score * 100) / 100,
    total: state.questions.length,
    needsManual,
    review,
  };
}

function submitPractice() {
  if (state.mode !== 'practice') return;
  closeSubmitConfirm();

  const graded = gradePractice();
  finishExam();
  renderResult({
    practice: true,
    score: graded.score,
    total: graded.total,
    needsGrading: graded.needsManual,
    review: graded.review,
  });
}

/** Renders the answer-key review list shown after a practice submission. */
function renderPracticeReview(review) {
  const host = $('practiceReview');
  clear(host);

  review.forEach((row) => {
    const card = el('div', { className: `review-card is-${row.verdict}` });
    const head = el('div', { className: 'review-card__head' });
    head.appendChild(el('span', {
      className: `review-card__verdict is-${row.verdict}`,
      text: row.verdict === 'correct' ? 'Đúng' : row.verdict === 'wrong' ? 'Sai' : 'Chưa chấm',
    }));
    head.appendChild(el('span', {
      className: 'q-badge__index',
      text: `Câu ${row.index + 1} · ${TYPE_LABEL[row.question.type]}`,
    }));
    card.appendChild(head);

    card.appendChild(el('p', { className: 'review-card__text', text: row.question.content }));

    const userRow = el('div', { className: 'review-answer' });
    userRow.appendChild(el('span', { className: 'review-answer__label', text: 'Bạn chọn' }));
    userRow.appendChild(el('span', {
      className: `review-answer__value${row.verdict === 'correct' ? ' is-correct'
        : row.verdict === 'wrong' ? ' is-wrong' : ''}`,
      text: row.userText,
    }));
    card.appendChild(userRow);

    if (row.correctText) {
      const keyRow = el('div', { className: 'review-answer' });
      keyRow.appendChild(el('span', { className: 'review-answer__label', text: 'Đáp án đúng' }));
      keyRow.appendChild(el('span', { className: 'review-answer__value is-correct', text: row.correctText }));
      card.appendChild(keyRow);
    }

    if (row.question.explanation) {
      card.appendChild(el('p', { className: 'review-explanation', text: row.question.explanation }));
    }

    host.appendChild(card);
  });

  show(host);
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
  $('practiceForm').addEventListener('submit', handlePracticeSubmit);
  $('tabOfficial').addEventListener('click', () => selectModeTab('official'));
  $('tabPractice').addEventListener('click', () => selectModeTab('practice'));
  $('practiceSourceCodeBtn').addEventListener('click', () => selectPracticeSource('code'));
  $('practiceSourceFileBtn').addEventListener('click', () => selectPracticeSource('file'));
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
  $('submitConfirmBtn').addEventListener('click', () => {
    if (state.mode === 'practice') submitPractice();
    else submitExam(false);
  });
  $('certBtn').addEventListener('click', openCertificate);
  $('certCloseBtn').addEventListener('click', closeCertificate);
  $('certPrintBtn').addEventListener('click', () => window.print());
  document.addEventListener('keydown', onKeyDown);

  const resumed = await tryResumeSession();
  if (!resumed) show($('loginScreen'));
}

boot();
