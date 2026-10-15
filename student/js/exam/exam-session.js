/**
 * ADQS Exam v2 — Student SPA Exam Session & Auth Lifecycle
 * =====================================================================
 * Dual-auth login, verify_and_acquire_session, F5 recovery,
 * server-anchored countdown timer & 20s heartbeat.
 */

import {
  state, $, el, clear, show, hide, toast, busy, loginError,
  rpcMessage, callRpc, readSession, writeSession, clearSession,
  HEARTBEAT_MS, MAX_DEVICE_INFO,
} from '../core/state.js';
import { normalizeText, normalizeType, isUuid } from '../core/utils.js';
import { partitionAndShuffleOrder } from '../../practice-order.js';
import {
  bindAntiCheat, unbindAntiCheat, requestFullscreen, updateViolationBadge,
} from './anti-cheat.js';
import {
  renderQuizShell, renderQuestion, makeEmptyAnswer, isDraftReady, submitExam,
} from './exam-runner.js';
import { selectModeTab } from './practice-docx.js';

/* =====================================================================
   Roster picker (Phase 6.3)
   ===================================================================== */

export const EXAM_CODE_LENGTH = 6;

export function rosterStatus(message, isError) {
  const node = $('rosterStatus');
  if (!message) { hide(node); node.textContent = ''; node.classList.remove('is-error'); return; }
  node.textContent = message;
  node.classList.toggle('is-error', isError === true);
  show(node);
}

/** Clears the picker back to its empty, unselected state. */
export function resetRosterPicker() {
  const classSelect = $('class-select');
  const studentSelect = $('student-select');
  clear(classSelect);
  classSelect.appendChild(el('option', { text: '-- Chọn Lớp --', attrs: { value: '' } }));
  clear(studentSelect);
  studentSelect.appendChild(el('option', { text: '-- Chọn Học sinh --', attrs: { value: '' } }));
  $('student-code-hidden').value = '';
}

/**
 * Switches the form between the roster picker and the manual inputs.
 *
 * The two field sets are mutually exclusive and fully separated in the DOM, so
 * a value can never be read from a hidden, stale half of the form.
 */
export function setRosterMode(mode) {
  const usePicker = mode === 'picker';
  if (usePicker) { show($('rosterFields')); hide($('manualFields')); }
  else { hide($('rosterFields')); show($('manualFields')); }

  // `required` is kept in sync with visibility. The form is `novalidate`, so
  // this is not what enforces the choice (readIdentity does that) — it keeps the
  // semantics honest for assistive tech instead of marking hidden fields required.
  $('class-name-input').required = !usePicker;
  $('student-name-input').required = !usePicker;
  $('class-select').required = usePicker;
  $('student-select').required = usePicker;
}

/** Shows or hides the PIN field for the exam's policy. */
export function applyPinVisibility(pinMode) {
  // Manual fallback: leave it visible, since pin_mode is unknown there and a
  // GLOBAL exam would otherwise be impossible to enter.
  const visible = pinMode !== 'NONE';
  const group = $('pin-field-group');
  if (visible) show(group); else hide(group);
}

/**
 * Phase 8.8 — rewrites the PIN field's label/hint for the exam's policy.
 *
 * The server's three pin modes need three different things typed into one field:
 *   GLOBAL     — one shared code the teacher announced to the whole room.
 *   INDIVIDUAL — the student's own PIN, or DDMM of their DOB as the fallback.
 *   null       — the manual fallback, where pin_mode is unknown: keep the
 *                original wording that covers both possibilities.
 * Telling the student which one to type avoids a failed attempt that (per the
 * RPC) is not merely cosmetic — a wrong PIN is rejected.
 */
export function applyPinLabels(pinMode) {
  const label = $('labelStudentPin');
  const hint = $('hintStudentPin');
  if (!label || !hint) return;

  if (pinMode === 'GLOBAL') {
    label.textContent = 'Mã PIN của phòng thi';
    hint.textContent = 'Nhập mã PIN chung mà giáo viên đã thông báo cho cả lớp.';
  } else if (pinMode === 'INDIVIDUAL') {
    label.textContent = 'Mã PIN cá nhân';
    hint.textContent = 'Nhập mã PIN riêng của bạn, hoặc ngày sinh dạng DDMM (VD: 0509 nếu sinh 05/09).';
  } else {
    label.textContent = 'Mã PIN bảo vệ';
    hint.textContent = 'Nhập mã PIN do giáo viên cấp, hoặc ngày sinh dạng DDMM (VD: 0509 nếu sinh 05/09).';
  }
}

/**
 * Phase 8.8 — renders the exam identity banner from a roster payload.
 *
 * Showing the title is a correctness aid, not decoration: several exams can be
 * open at once and a mistyped code that happens to be valid would otherwise
 * silently seat the student in the wrong paper.
 */
export function renderExamBanner(payload) {
  const banner = $('examMetaBanner');
  const titleNode = $('examMetaTitle');
  const statusNode = $('examMetaStatus');
  if (!banner || !titleNode || !statusNode) return;

  const title = String(payload.title || '').trim();
  if (!title) { hide(banner); return; }

  titleNode.textContent = title;

  // The duration is the other number a student wants before committing.
  const minutes = Number(payload.duration_minutes);
  statusNode.textContent = Number.isFinite(minutes) && minutes > 0
    ? `⏱ ${minutes} phút`
    : '';

  show(banner);
}

/** Hides the exam banner (on a blank/invalid code, or any failed load). */
export function clearExamBanner() {
  const banner = $('examMetaBanner');
  if (banner) hide(banner);
}

/**
 * Fetches and renders the roster for `examCode`.
 *
 * Any failure is non-fatal: the form silently reverts to manual entry with a
 * short status note. The ONE exception is a real server refusal (closed /
 * trashed / not-yet-open exam), which is surfaced loudly because retyping the
 * identity will not help.
 */
export async function loadExamRoster(examCode) {
  const code = String(examCode || '').trim().toUpperCase();
  const requestId = ++state.rosterRequestId;

  // A new code invalidates whatever was loaded before.
  state.roster = null;
  state.rosterPinMode = null;
  resetRosterPicker();

  if (code.length !== EXAM_CODE_LENGTH) {
    setRosterMode('manual');
    applyPinVisibility(null);
    applyPinLabels(null);
    clearExamBanner();
    rosterStatus('');
    return;
  }

  rosterStatus('Đang tải danh sách dự thi…', false);

  const result = await callRpc('get_exam_roster', { p_exam_code: code });

  // A slower earlier request must not overwrite a newer one's result.
  if (requestId !== state.rosterRequestId) return;

  if (!result.ok) {
    setRosterMode('manual');
    applyPinVisibility(null);
    applyPinLabels(null);
    clearExamBanner();
    rosterStatus('Không tải được danh sách dự thi. Vui lòng kiểm tra mạng và thử lại.', true);
    return;
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    // A definitive server refusal — manual entry cannot help either, since the
    // identity can only be resolved against a loaded roster (Phase 8.1).
    setRosterMode('manual');
    applyPinVisibility(null);
    applyPinLabels(null);
    clearExamBanner();
    rosterStatus(rpcMessage(payload.code, payload.message), true);
    return;
  }

  // Phase 8.8 — the exam is valid: show its title/duration so the student can
  // confirm this is the right paper before choosing a name.
  renderExamBanner(payload);

  state.rosterPinMode = payload.pin_mode || null;
  if (payload.security_config) {
    state.securityConfig = payload.security_config;
  }
  if (state.securityConfig?.detect_motion && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    const btnMotion = $('btnRequestMotion');
    if (btnMotion) btnMotion.classList.remove('hidden');
  }
  applyPinVisibility(state.rosterPinMode);
  applyPinLabels(state.rosterPinMode);

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  state.roster = candidates;

  if (candidates.length === 0) {
    // Manual entry still renders, but submitting will report that the roster is
    // empty (readIdentity) — there is no code to match a typed name against.
    setRosterMode('manual');
    rosterStatus('Đề thi chưa có danh sách dự thi. Vui lòng liên hệ giáo viên.', true);
    return;
  }

  setRosterMode('picker');
  populateClassSelect(candidates);
  rosterStatus(`Đã tải ${candidates.length} học sinh. Chọn lớp và tên của bạn.`, false);
}

/** Fills #class-select with the distinct class names, in server order. */
export function populateClassSelect(candidates) {
  const classSelect = $('class-select');
  clear(classSelect);
  classSelect.appendChild(el('option', { text: '-- Chọn Lớp --', attrs: { value: '' } }));

  // The RPC already orders by class_name, so a Set preserves that order and
  // dedupes without a second sort.
  const seen = new Set();
  candidates.forEach((candidate) => {
    const name = String(candidate.class_name || '');
    if (!name || seen.has(name)) return;
    seen.add(name);
    classSelect.appendChild(el('option', { text: name, attrs: { value: name } }));
  });

  // A single class is the common case — preselect it so the student only picks
  // their own name.
  if (seen.size === 1) classSelect.value = [...seen][0];
  populateStudentSelect();
}

/** Fills #student-select with the candidates of the selected class. */
export function populateStudentSelect() {
  const className = $('class-select').value;
  const studentSelect = $('student-select');
  clear(studentSelect);
  studentSelect.appendChild(el('option', { text: '-- Chọn Học sinh --', attrs: { value: '' } }));
  $('student-code-hidden').value = '';
  $('student-pin').value = '';

  if (!className) { studentSelect.disabled = true; return; }
  studentSelect.disabled = false;

  (state.roster || [])
    .filter((candidate) => candidate.class_name === className)
    .forEach((candidate) => {
      // The option VALUE is the student code (what the server matches on); the
      // visible label is the human name.
      studentSelect.appendChild(el('option', {
        text: candidate.full_name,
        attrs: { value: candidate.student_code },
      }));
    });
}

/** Copies the picked candidate into the hidden code field. */
export function onStudentSelected() {
  const studentCode = $('student-select').value;
  $('student-code-hidden').value = studentCode;
  // Clearing the PIN on identity change prevents a value typed for one student
  // being submitted for another.
  $('student-pin').value = '';
}

/**
 * Reads the identity from whichever mode is active.
 *
 * Returns `{ studentCode, className, fullName }` or `{ error }`.
 */
export function readIdentity() {
  if (state.roster !== null && !$('rosterFields').classList.contains('hidden')) {
    const studentCode = $('student-code-hidden').value.trim();
    const className = $('class-select').value.trim();

    if (!className) return { error: 'Vui lòng chọn lớp của bạn.' };
    if (!studentCode) return { error: 'Vui lòng chọn tên của bạn trong danh sách.' };

    const candidate = (state.roster || []).find(
      (row) => row.student_code === studentCode && row.class_name === className,
    );
    if (!candidate) return { error: 'Không tìm thấy học sinh đã chọn. Vui lòng chọn lại.' };

    return {
      studentCode: candidate.student_code,
      className: candidate.class_name,
      fullName: candidate.full_name,
    };
  }

  // Manual fallback: class + name, resolved against the roster when available.
  const className = $('class-name-input').value.trim();
  const fullName = $('student-name-input').value.trim();

  if (!className || !fullName) {
    return { error: 'Vui lòng nhập đầy đủ Họ tên và Lớp.' };
  }

  // Phase 8.8 — a missing roster is no longer fatal. Send no code and let the
  // server match the normalized (class_name, full_name) pair itself; it applies
  // the same normalization and answers STUDENT_NOT_WHITELISTED if there is no
  // such candidate.
  const match = (state.roster || []).find(
    (row) => normalizeText(row.class_name) === normalizeText(className)
      && normalizeText(row.full_name) === normalizeText(fullName),
  );

  return {
    // Prefer the roster row's canonical spelling when we found one: the server
    // compares normalized text either way, but echoing the stored value keeps
    // the certificate and result screens consistent with the paper.
    studentCode: match ? match.student_code : null,
    className: match ? match.class_name : className,
    fullName: match ? match.full_name : fullName,
  };
}

export async function handleLoginSubmit(event) {
  event.preventDefault();
  loginError('');

  const examCode = $('exam-code').value.trim();
  const identity = readIdentity();
  const pin = $('student-pin').value.trim();

  if (identity.error) { loginError(identity.error); return; }

  const { studentCode, className, fullName } = identity;
  // Phase 8.8 — `studentCode` may legitimately be null: the server resolves the
  // candidate from (class_name, full_name) in that case, so it is no longer part
  // of the completeness check. Name + class + a valid exam code are.
  if (!examCode || !fullName || !className) {
    loginError('Vui lòng nhập đầy đủ Mã đề, Họ tên và Lớp.');
    return;
  }
  if (!/^\d{6}$/.test(examCode)) {
    loginError('Mã đề thi phải gồm đúng 6 chữ số.');
    return;
  }

  state.examCode = examCode;
  state.studentCode = studentCode || '';
  state.fullName = fullName;
  state.className = className;
  // Held for the resume path only (see writeSession); never rendered.
  state.pin = pin === '' ? null : pin;

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
      // Phase 8.8 — NULL (never '') when the roster could not supply a code.
      // The RPC treats a blank string the same as NULL, but sending NULL is the
      // honest signal and keeps the SQL's `nullif(trim(...))` path the only one.
      p_student_code: state.studentCode || null,
      p_full_name: state.fullName,
      p_class_name: state.className,
      p_device_info: deviceInfo(),
      p_existing_token: isUuid(existingToken) ? existingToken : null,
      // Phase 6.3 — the Phase 6.1 PIN gate reads this. Null/empty is correct for
      // pin_mode = NONE, and fails closed for GLOBAL/INDIVIDUAL.
      p_pin: pin === '' ? null : pin,
    });

    if (!result.ok) {
      loginError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
      return;
    }

    const payload = result.data || {};
    if (payload.success !== true) {
      // The RPC reports INVALID_PIN both as `code` and `message` depending on the
      // branch; rpcMessage resolves either.
      loginError(rpcMessage(payload.code || payload.message, payload.message));
      return;
    }

    state.sessionToken = payload.session_token;
    // Phase 8.8 — adopt the SERVER's resolved identity. When the manual branch
    // sent no code, the RPC matched on (class_name, full_name) and echoed the
    // roster row back; every later call (heartbeat, submit, certificate) is
    // keyed on `student_code`, so without this the session would be live on the
    // server while the client held an empty code.
    if (payload.student_code) state.studentCode = String(payload.student_code);
    if (payload.student_name) state.fullName = String(payload.student_name);
    if (payload.class_name) state.className = String(payload.class_name);
    if (payload.security_config) state.securityConfig = payload.security_config;
    if (typeof payload.time_remaining_seconds === 'number') {
      state.durationSeconds = payload.time_remaining_seconds;
      state.endsAt = Date.now() + (payload.time_remaining_seconds * 1000);
    }
    if (!state.startedAt) state.startedAt = Date.now();
    writeSession();

    await enterExam();
  } finally {
    busy(false);
    $('startBtn').disabled = false;
  }
}

export function deviceInfo() {
  const ua = navigator.userAgent || '';
  return ua.slice(0, MAX_DEVICE_INFO);
}

/* =====================================================================
   Exam loading
   ===================================================================== */

/**
 * Applies the display shuffle to the official exam.
 */
export function applyDisplayShuffle() {
  const total = state.questions.length;
  if (total < 2) {
    state.displayOrder = null;
    return;
  }

  // Only an explicit `false` opts out; a missing key (an older payload) keeps the
  // shipped behaviour of shuffling.
  if (state.exam && state.exam.shuffle_questions === false) {
    state.displayOrder = null;
    return;
  }

  const types = state.questions.map((question) => normalizeType(question.type));
  const order = partitionAndShuffleOrder(types, true);
  state.displayOrder = order;
  state.questions = order.map((originalIndex) => state.questions[originalIndex]);
}

export async function enterExam() {
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
    if (!state.endsAt) {
      state.durationSeconds = Math.max(1, Number(state.exam.duration_minutes) || 45) * 60;
      state.endsAt = Date.now() + (state.durationSeconds * 1000);
    }
    state.answers = state.questions.map(makeEmptyAnswer);
    state.currentIndex = 0;
    state.flashIndex = null;
    state.flags = new Set();
    state.mode = 'quiz';
    state.examStatus = 'IN_PROGRESS';
    state.violationCount = 0;
    updateViolationBadge();

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

export function resetToLogin(message) {
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
   Timer
   ===================================================================== */

export function startTimer() {
  stopTimer();
  tickTimer();
  state.timerHandle = setInterval(tickTimer, 1000);
}

export function stopTimer() {
  if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
}

export function elapsedSeconds() {
  if (!state.startedAt) return 0;
  const raw = Math.floor((Date.now() - state.startedAt) / 1000);
  return Math.max(0, Math.min(state.durationSeconds, raw));
}

export function tickTimer() {
  const remaining = state.endsAt
    ? Math.max(0, Math.round((state.endsAt - Date.now()) / 1000))
    : Math.max(0, state.durationSeconds - elapsedSeconds());
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const node = $('timerDisplay');
  node.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  // The critical (red) styling lives on the .timer-badge wrapper, not the inner
  // digit span, so the icon and padding recolor together.
  const badge = $('exam-timer-badge');
  if (badge) badge.classList.toggle('is-critical', remaining <= 300);

  if (remaining <= 0 && state.mode === 'quiz' && !state.submitting) {
    stopTimer();
    toast('Hết giờ làm bài. Hệ thống đang thu bài…');
    submitExam(true);
  }
}

/* =====================================================================
   Heartbeat (20s) — session concurrency guard
   ===================================================================== */

export function countAnswered() {
  return state.questions.reduce((total, question, index) => {
    return total + (isDraftReady(normalizeType(question.type), state.answers[index]) ? 1 : 0);
  }, 0);
}

export function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatHandle = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

export function stopHeartbeat() {
  if (state.heartbeatHandle) { clearInterval(state.heartbeatHandle); state.heartbeatHandle = null; }
}

export async function sendHeartbeat() {
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

export function evictStudent(code) {
  if (state.mode === 'evicted') return;
  state.mode = 'evicted';
  stopTimer();
  stopHeartbeat();
  unbindAntiCheat();
  clearSession();
  hide($('fullscreenOverlay'));
  hide($('submitModal'));
  hide($('loadingOverlay'));
  show($('evictedOverlay'));
  console.warn('Session ended:', code);
}

/* =====================================================================
   Session restore & prefill
   ===================================================================== */

export async function tryResumeSession() {
  const stored = readSession();
  if (!stored || !isUuid(stored.session_token)) return false;

  state.examCode = stored.exam_code || '';
  state.studentCode = stored.student_code || '';
  state.fullName = stored.full_name || '';
  state.className = stored.class_name || '';
  state.sessionToken = stored.session_token;
  state.startedAt = stored.started_at || Date.now();
  if (stored.ends_at) {
    state.endsAt = Number(stored.ends_at);
  }
  // Phase 6.3 — must be resendable: the PIN gate precedes the session lock, so
  // omitting it would turn an F5 into a 60s lockout (see writeSession).
  state.pin = stored.pin || null;

  busy(true, 'Đang khôi phục phiên làm bài…');
  try {
    const result = await callRpc('verify_and_acquire_session', {
      p_exam_code: state.examCode,
      p_student_code: state.studentCode,
      p_full_name: state.fullName,
      p_class_name: state.className,
      p_device_info: deviceInfo(),
      p_existing_token: state.sessionToken,
      p_pin: state.pin,
    });

    if (!result.ok || !result.data || result.data.success !== true) {
      clearSession();
      return false;
    }

    // SESSION_RESUMED confirms this is the same device; SESSION_ACQUIRED means
    // a stale session was legitimately taken over.
    state.sessionToken = result.data.session_token || state.sessionToken;
    if (result.data.security_config) state.securityConfig = result.data.security_config;
    if (typeof result.data.time_remaining_seconds === 'number') {
      state.durationSeconds = result.data.time_remaining_seconds;
      state.endsAt = Date.now() + (result.data.time_remaining_seconds * 1000);
    } else if (result.data.ends_at) {
      const parsedEndsAt = new Date(result.data.ends_at).getTime();
      if (!Number.isNaN(parsedEndsAt)) {
        state.endsAt = parsedEndsAt;
        state.durationSeconds = Math.max(0, Math.round((parsedEndsAt - Date.now()) / 1000));
      }
    }
    writeSession();
    await requestFullscreen();
    await enterExam();
    return true;
  } finally {
    busy(false);
  }
}

/**
 * Phase 6.3 — pre-fills the exam code from the URL and loads its roster.
 */
export function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('code') || params.get('c');
  if (!codeParam) return;

  // Ensure official exam tab is selected when joining via exam code
  selectModeTab('official');

  const input = $('exam-code');
  if (!input) return;

  // The code is 6 digits, but a hand-edited URL could carry anything — cap it
  // rather than letting a long string reach the RPC.
  const code = codeParam.trim().toUpperCase().slice(0, EXAM_CODE_LENGTH);
  if (!code) return;

  input.value = code;
  loadExamRoster(code);
}

/**
 * Wires up the roster picker's change handlers (Phase 6.3).
 */
export function bindRosterControls() {
  $('exam-code').addEventListener('change', () => {
    loadExamRoster($('exam-code').value);
  });
  const verifyBtn = $('btnVerifyExamCode');
  if (verifyBtn) {
    verifyBtn.addEventListener('click', () => {
      loadExamRoster($('exam-code').value);
    });
  }
  $('class-select').addEventListener('change', populateStudentSelect);
  $('student-select').addEventListener('change', onStudentSelected);
}
