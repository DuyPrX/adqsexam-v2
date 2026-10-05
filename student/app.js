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
import { TreeRenderer, clampTeamNumber, computeTreeState, getTeamSeed, hitTestFruits } from './tree-engine.js';
import { countTreeWords, normalizeAnswerText, treeWordCounterLabel } from './tree-words.js';
import {
  isAudioMuted, playBloomFanfare, playDewdropSound, resumeAudioContext, toggleAudioMute,
} from './tree-audio.js';

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

/**
 * Phase 8.1 — base URL of the Cloudflare Worker that parses a personal .docx.
 *
 * The student SPA is a STATIC bundle on Cloudflare Pages, which serves only
 * files under its assets directory — there is no server-side route handler, so a
 * relative `/api/v1/extract-practice` request 405s/404s. The Worker lives at its
 * own origin and must therefore be addressed absolutely.
 *
 * Resolution order:
 *   1. `window.WORKER_API_URL` — set by a deployment's own config script.
 *   2. the configured practice URL (APP_CONFIG.practiceApiUrl), when it is
 *      already absolute — the existing `?api=` / localStorage override path.
 *   3. localhost:8787 (wrangler dev) when developing locally.
 *   4. `''` otherwise — the caller reports "chưa cấu hình" rather than issuing a
 *      request that would fail as an opaque 404 against the static host.
 *
 * Trailing slashes are stripped so path concatenation is unambiguous.
 */
function resolveWorkerBaseUrl() {
  const explicit = String(window.WORKER_API_URL || '').replace(/\/+$/, '');
  if (explicit) return explicit;

  const configured = String((window.APP_CONFIG || {}).practiceApiUrl || '').trim();
  if (/^https?:\/\//i.test(configured)) {
    // The configured value may be the FULL endpoint; strip the known path so the
    // caller can append its own consistently.
    return configured.replace(/\/api\/v1\/extract-practice\/?$/i, '').replace(/\/+$/, '');
  }

  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }

  // Unconfigured non-local deployment: surface a clear message instead of
  // letting the request fail as an opaque 404 against the static host.
  return 'https://docx-extractor-v2.haleduy01.workers.dev';
}

/** Server RPC result codes -> Vietnamese copy shown to the student. */
const RPC_MESSAGES = {
  EXAM_NOT_FOUND: 'Không tìm thấy mã đề thi này. Vui lòng kiểm tra lại.',
  EXAM_INACTIVE: 'Đề thi này đang đóng. Vui lòng liên hệ giáo viên.',
  EXAM_NOT_STARTED: 'Đề thi chưa đến giờ mở. Vui lòng chờ đến thời gian bắt đầu.',
  EXAM_EXPIRED: 'Đề thi đã hết thời gian mở. Vui lòng liên hệ giáo viên.',
  STUDENT_NOT_WHITELISTED: 'Mã học sinh không có trong danh sách dự thi của đề này.',
  IDENTITY_MISMATCH: 'Họ tên hoặc lớp không khớp với danh sách dự thi.',
  // Phase 6.3 — the PIN gate (Phase 6.1) refuses an absent/wrong credential.
  INVALID_PIN: 'Mã PIN hoặc ngày sinh không đúng. Vui lòng thử lại!',
  ALREADY_SUBMITTED: 'Bạn đã nộp bài cho đề thi này rồi.',
  SESSION_ACTIVE_ELSEWHERE: 'Tài khoản của bạn đang được đăng nhập trên một thiết bị khác.',
  INVALID_SESSION: 'Phiên làm bài không còn hợp lệ.',
  SESSION_EXPIRED: 'Phiên làm bài đã hết hạn do không hoạt động.',
  // Phase 5.8 — practice-by-code refusals.
  PRACTICE_NOT_ALLOWED: 'Giáo viên chưa mở đề này cho chế độ luyện tập.',
  PRACTICE_EMPTY: 'Đề này chưa có câu hỏi nào để luyện tập.',
  // Phase 7.4 — Tree of Knowledge participation.
  SESSION_NOT_FOUND: 'Phiên hoạt động không tồn tại hoặc đã bị xoá.',
  SESSION_INACTIVE: 'Phiên hoạt động đã kết thúc. Cảm ơn bạn đã tham gia!',
  IDENTITY_REQUIRED: 'Vui lòng chọn tên của bạn trước khi gửi.',
  MIN_WORDS_NOT_MET: 'Câu trả lời chưa đủ số từ tối thiểu.',
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
  /** Phase 6.3 — the PIN submitted at login, reused when a reload resumes. */
  pin: null,
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
  /**
   * Phase 6.3 — the roster fetched by `get_exam_roster` for the entered exam
   * code. `null` means "no roster loaded" (manual entry); an array (possibly
   * empty) means the picker is authoritative for this code. Cleared whenever
   * the code changes so a stale roster can never validate a new exam.
   */
  roster: null,
  /** `pin_mode` from the roster RPC: 'NONE' | 'GLOBAL' | 'INDIVIDUAL'. */
  rosterPinMode: null,
  /** Guards against out-of-order responses when the student retypes the code. */
  rosterRequestId: 0,
  /**
   * Phase 8.1 — the PRACTICE roster for the entered practice exam code, fetched
   * with `p_for_practice: true` so a closed-but-practiceable exam still yields
   * its candidates. Used to fill the class/name datalists and to resolve the
   * `student_code` the write path expects from a typed name.
   */
  practiceRoster: null,
  practiceRosterRequestId: 0,
  /** Phase 7.2 — Tree of Knowledge screen state. */
  treeRenderer: null,
  treeData: null,
  treeHighlightId: null,
  /**
   * Phase 7.4 — the loaded tree activity. `treeSession` holds the RPC's
   * `session` object plus `class_name`/`total_students`; `treeSubmissions` is the
   * live submission list (initial fetch merged with Realtime deltas).
   */
  treeSession: null,
  treeSubmissions: [],
  treeMembers: [],
  treeIdentity: null,       // { student_code, full_name } once checked in
  treeChannel: null,
  /** True once the student has submitted; enables the "update answer" flow. */
  treeSubmitted: false,
  /**
   * Phase 8.3 — edge guards for the procedural audio. `treeFlourished` latches
   * the P = 1.0 fanfare so a re-render (or a later submission in a class that
   * somehow exceeds N) cannot replay the celebration.
   */
  treeFlourished: false,
  /**
   * Phase 8.4 — the student's own team (Tổ 1..4), resolved from the check-in
   * roster. The workspace renders ONLY this team's tree (`myTeamSubs`), so a
   * student watches their own Tổ grow rather than the whole class's.
   */
  studentTeam: 1,
  /**
   * Phase 8.4 — per-team roster sizes from `get_public_tree_session`
   * (`{ "1": n1, ... "4": n4 }`). Used as each tree's participation denominator
   * and to drive the mini-leaderboard percentages.
   */
  treeTeamCounts: null,
  /**
   * Phase 8.4 — latches the FIRST team to reach 100% so its 🏆 badge is drawn
   * once and never transferred to a later finisher.
   */
  treeChampionTeam: null,
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
      // Phase 6.3 — the PIN is persisted so a same-device reload can resume.
      //
      // The Phase 6.1 PIN gate runs BEFORE the session lock inside
      // verify_and_acquire_session, so a resume that omits `p_pin` is rejected
      // as INVALID_PIN — and the follow-up attempt then sees the still-live
      // session row and returns SESSION_ACTIVE_ELSEWHERE, locking the student
      // out for 60s after a stray F5. F5 reload tolerance is an explicit
      // architecture guarantee, so the credential must be resendable.
      //
      // Exposure: this blob already holds the bearer session token, so it
      // already grants exam access to anyone who can read localStorage. The PIN
      // is cleared by clearSession() on submit, eviction and restart.
      pin: state.pin,
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

/* =====================================================================
   Roster picker (Phase 6.3)
   =====================================================================
   Once the student enters an exam code, `get_exam_roster` returns the sanitised
   candidate list (student_code / full_name / class_name — never pin or dob) plus
   the exam's `pin_mode`. The student picks their class and name instead of
   typing them, so the identity submitted is byte-identical to the roster row the
   server compares against.

   Degradation is deliberate: any failure (blank roster, closed exam, no network)
   falls back to the Phase 5 manual inputs. A student must never be unable to sit
   an exam because an optimisation failed.
   ===================================================================== */

const EXAM_CODE_LENGTH = 6;

function rosterStatus(message, isError) {
  const node = $('rosterStatus');
  if (!message) { hide(node); node.textContent = ''; node.classList.remove('is-error'); return; }
  node.textContent = message;
  node.classList.toggle('is-error', isError === true);
  show(node);
}

/** Clears the picker back to its empty, unselected state. */
function resetRosterPicker() {
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
function setRosterMode(mode) {
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
function applyPinVisibility(pinMode) {
  // Manual fallback: leave it visible, since pin_mode is unknown there and a
  // GLOBAL exam would otherwise be impossible to enter.
  const visible = pinMode !== 'NONE';
  const group = $('pin-field-group');
  if (visible) show(group); else hide(group);
}

/**
 * Fetches and renders the roster for `examCode`.
 *
 * Any failure is non-fatal: the form silently reverts to manual entry with a
 * short status note. The ONE exception is a real server refusal (closed /
 * trashed / not-yet-open exam), which is surfaced loudly because retyping the
 * identity will not help.
 */
async function loadExamRoster(examCode) {
  const code = String(examCode || '').trim().toUpperCase();
  const requestId = ++state.rosterRequestId;

  // A new code invalidates whatever was loaded before.
  state.roster = null;
  state.rosterPinMode = null;
  resetRosterPicker();

  if (code.length !== EXAM_CODE_LENGTH) {
    setRosterMode('manual');
    applyPinVisibility(null);
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
    rosterStatus('Không tải được danh sách dự thi. Vui lòng kiểm tra mạng và thử lại.', true);
    return;
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    // A definitive server refusal — manual entry cannot help either, since the
    // identity can only be resolved against a loaded roster (Phase 8.1).
    setRosterMode('manual');
    applyPinVisibility(null);
    rosterStatus(rpcMessage(payload.code, payload.message), true);
    return;
  }

  state.rosterPinMode = payload.pin_mode || null;
  applyPinVisibility(state.rosterPinMode);

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
function populateClassSelect(candidates) {
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
function populateStudentSelect() {
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
function onStudentSelected() {
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
 *
 * Phase 8.1 — there is no visible student-code input anywhere, so BOTH branches
 * must resolve the code themselves:
 *   - picker: the code is the selected `<option>` value (a roster row).
 *   - manual: class + name are matched against the roster already fetched for
 *     this exam. Without a roster there is nothing to match, and
 *     `verify_and_acquire_session` (which matches on student_code) cannot be
 *     called — so a missing roster is reported as a clear error instead of being
 *     sent as a blank code.
 */
function readIdentity() {
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

  // Manual fallback: class + name, resolved against the roster.
  const className = $('class-name-input').value.trim();
  const fullName = $('student-name-input').value.trim();

  if (!className || !fullName) {
    return { error: 'Vui lòng nhập đầy đủ Họ tên và Lớp.' };
  }
  if (!state.roster || state.roster.length === 0) {
    return {
      error: 'Đề thi chưa có danh sách dự thi nên không thể xác minh. Vui lòng liên hệ giáo viên.',
    };
  }

  const match = state.roster.find(
    (row) => row.class_name.toLowerCase() === className.toLowerCase()
      && row.full_name.toLowerCase() === fullName.toLowerCase(),
  );
  if (!match) {
    return { error: 'Họ tên hoặc lớp không khớp với danh sách dự thi của đề này.' };
  }

  return {
    studentCode: match.student_code,
    className: match.class_name,
    fullName: match.full_name,
  };
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  loginError('');

  const examCode = $('exam-code').value.trim();
  const identity = readIdentity();
  const pin = $('student-pin').value.trim();

  if (identity.error) { loginError(identity.error); return; }

  const { studentCode, className, fullName } = identity;
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
      p_student_code: state.studentCode,
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
 *
 * Phase 8.1 — identity is sent as (full_name, class_name) instead of a student
 * code. The RPC matches either, so no code lookup is needed here; the roster
 * fetch in `loadPracticeRoster` exists only to offer suggestions and to resolve
 * the code that `verify_student_practice` (the .docx path) may want.
 */
async function loadPracticeFromExamCode(examCode) {
  const result = await callRpc('get_practice_exam_payload', {
    p_exam_code: examCode,
    p_student_code: state.studentCode || null,
    p_class_name: state.className,
    p_full_name: state.fullName,
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
    // The roster row is authoritative — the student may have typed their name
    // with different capitalisation.
    studentName: payload.student_name || '',
  };
}

/**
 * Phase 8.1 — loads the practice roster for an exam code and fills the datalists.
 *
 * Called when the practice code is entered. `p_for_practice: true` is what makes
 * this work on a CLOSED exam: the official-exam scheduling gates are skipped for
 * practice (migration 20261005140000), so a student can self-practise after the
 * sitting has ended.
 *
 * Best-effort: a failure only means the student types their identity manually.
 */
async function loadPracticeRoster(examCode) {
  const code = String(examCode || '').trim();
  const requestId = ++state.practiceRosterRequestId;
  state.practiceRoster = null;
  clearPracticeDatalists();

  if (!code) return;

  const result = await callRpc('get_exam_roster', { p_exam_code: code, p_for_practice: true });
  if (requestId !== state.practiceRosterRequestId) return;

  if (!result.ok || result.data?.success !== true) {
    // Silent by design: this is a convenience layer, and a loud error here would
    // interrupt the student mid-typing. The submit path reports the real refusal.
    return;
  }

  const candidates = Array.isArray(result.data.candidates) ? result.data.candidates : [];
  state.practiceRoster = candidates;
  fillPracticeDatalists(candidates);
}

/** Clears the practice suggestion lists. */
function clearPracticeDatalists() {
  const classOptions = $('practiceClassOptions');
  const nameOptions = $('practiceStudentOptions');
  if (classOptions) clear(classOptions);
  if (nameOptions) clear(nameOptions);
}

/**
 * Fills the practice class/name datalists from a roster.
 *
 * The name list holds EVERY candidate (not just one class's): the class and name
 * inputs are independent text fields, so filtering names by the current class
 * would require re-rendering on every keystroke for little benefit — the browser
 * narrows the suggestions as the student types.
 */
function fillPracticeDatalists(candidates) {
  const classOptions = $('practiceClassOptions');
  const nameOptions = $('practiceStudentOptions');
  if (!classOptions || !nameOptions) return;

  clear(classOptions);
  clear(nameOptions);

  const seenClasses = new Set();
  candidates.forEach((candidate) => {
    const className = String(candidate.class_name || '');
    if (className && !seenClasses.has(className)) {
      seenClasses.add(className);
      classOptions.appendChild(el('option', { attrs: { value: className } }));
    }
    if (candidate.full_name) {
      nameOptions.appendChild(el('option', { attrs: { value: candidate.full_name } }));
    }
  });
}

/**
 * Resolves a typed (name, class) pair against the practice roster.
 *
 * Returns the matching row, or null. Used to recover the `student_code` when the
 * RPC needs one; when no roster is loaded the caller proceeds with name+class,
 * which the Phase 8.1 RPCs accept on their own.
 */
function matchPracticeCandidate(className, fullName) {
  const roster = state.practiceRoster;
  if (!Array.isArray(roster)) return null;
  const wantClass = className.trim().toLowerCase();
  const wantName = fullName.trim().toLowerCase();
  return roster.find(
    (row) => String(row.class_name || '').trim().toLowerCase() === wantClass
      && String(row.full_name || '').trim().toLowerCase() === wantName,
  ) || null;
}

async function handlePracticeSubmit(event) {
  event.preventDefault();
  practiceError('');

  const className = $('practiceClassName').value.trim();
  const fullName = $('practiceStudentName').value.trim();

  if (!className || !fullName) {
    practiceError('Vui lòng nhập đầy đủ Họ tên và Lớp.');
    return;
  }

  state.className = className;
  state.fullName = fullName;
  // Recover the roster row when available. It is optional for the by-code RPC
  // (which matches on name+class) but the .docx path prefers a code when one
  // exists, and it lets the RPC return the canonical spelling of the name.
  const match = matchPracticeCandidate(className, fullName);
  state.studentCode = match ? match.student_code : '';

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

  // Prefer the server's canonical name when the RPC returned one.
  if (loaded.studentName) state.fullName = loaded.studentName;
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
  // Phase 8.1 — the .docx path has no exam code, so there is no roster to derive
  // a student code from. The RPC now matches on (full_name, class_name); the code
  // is still forwarded when a practice roster happened to supply one.
  const auth = await callRpc('verify_student_practice', {
    p_class_name: state.className,
    p_full_name: state.fullName,
    p_student_code: state.studentCode || null,
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

/**
 * POSTs the .docx to the public practice endpoint (forced mode=rule).
 *
 * Phase 8.1 — the endpoint is built from `resolveWorkerBaseUrl()` rather than
 * being used as a relative path: this SPA is served as static assets, so a
 * relative `/api/...` request would hit the Pages host (405/404) instead of the
 * Worker that actually parses the file.
 */
async function extractPracticeDocx(file) {
  const workerBase = resolveWorkerBaseUrl();
  if (!workerBase) {
    return {
      ok: false,
      message: 'Chưa cấu hình địa chỉ máy chủ ôn luyện. Vui lòng báo giáo viên.',
    };
  }
  const endpoint = `${workerBase}/api/v1/extract-practice`;

  const body = new FormData();
  body.append('file', file);

  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', body });
  } catch (error) {
    // A CORS rejection and an offline network both surface as a TypeError here,
    // and the student cannot tell them apart — so the copy covers both.
    console.error('Practice extraction failed', error);
    return {
      ok: false,
      message: 'Không kết nối được máy chủ ôn luyện. Vui lòng kiểm tra mạng và thử lại.',
    };
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
 *
 * Accepts `?code=` (canonical) and `?c=` (short link for SMS/QR). Deliberately
 * does NOT auto-start the exam: the student still has to confirm their identity
 * and PIN, and a URL must never be able to open a sitting on its own.
 *
 * The roster load is fired-and-forgotten here because `boot()` continues to wire
 * the rest of the form; `loadExamRoster` handles its own errors.
 */
function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('code') || params.get('c');
  if (!codeParam) return;

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
 *
 * `change` (not `input`) on the exam code: the roster RPC should fire once the
 * student finishes typing, not on every keystroke. The listener re-runs
 * `loadExamRoster` for ANY edit, which is also what clears a stale roster.
 */
function bindRosterControls() {
  $('exam-code').addEventListener('change', () => {
    loadExamRoster($('exam-code').value);
  });
  $('class-select').addEventListener('change', populateStudentSelect);
  $('student-select').addEventListener('change', onStudentSelected);
}

/* =====================================================================
   Tree of Knowledge screen (Phase 7.2 renderer / Phase 7.4 interaction)
   =====================================================================
   Thin DOM shell over the dependency-free engine. The engine owns all geometry
   and drawing; this layer only (a) computes the state from session data, (b)
   owns the renderer lifecycle, (c) maps pointer events onto the canvas, and
   (d) drives the check-in -> workspace -> submit flow.

   The screen has TWO mutually exclusive states, toggled by `setTreeView`:
     #treeCheckinForm — pick your name from the class roster
     #treeWorkspace   — live canvas + answer box
   ===================================================================== */

/** Lazily created renderer for #tree-preview-canvas. */
function treeRenderer() {
  if (!state.treeRenderer) {
    const canvas = $('tree-preview-canvas');
    if (!canvas) return null;
    state.treeRenderer = new TreeRenderer(canvas);
    canvas.addEventListener('pointermove', onTreePointerMove);
    canvas.addEventListener('pointerdown', onTreePointerDown);
  }
  return state.treeRenderer;
}

/** Converts a pointer event into canvas-local CSS pixels. */
function pointerToCanvas(event) {
  const canvas = $('tree-preview-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  // The backing store may be scaled by devicePixelRatio, but the renderer draws
  // in CSS pixels, so normalise against the CSS box rather than canvas.width.
  const scaleX = rect.width ? canvas.clientWidth / rect.width : 1;
  const scaleY = rect.height ? canvas.clientHeight / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/** Renders the currently selected fruit into #treeFruitInfo (or hides it). */
function showFruitInfo(fruit) {
  const node = $('treeFruitInfo');
  if (!node) return;
  if (!fruit) { hide(node); node.textContent = ''; return; }

  const mine = state.treeIdentity && fruit.student_code === state.treeIdentity.student_code;
  const who = mine
    ? `Giọt sương tri thức của bạn (#${fruit.fruit_index})`
    : `${fruit.student_name} (#${fruit.fruit_index})`;
  node.textContent = `${who} — ${fruit.word_count} từ`;
  show(node);
}

/** Highlights the fruit under the cursor and exposes its data as a tooltip. */
function onTreePointerMove(event) {
  const renderer = state.treeRenderer;
  const canvas = $('tree-preview-canvas');
  if (!renderer || !canvas) return;

  const point = pointerToCanvas(event);
  const hit = point ? hitTestFruits(renderer.fruitAnchors, point.x, point.y) : null;

  canvas.style.cursor = hit ? 'pointer' : 'default';
  const nextId = hit ? hit.id : null;
  if (nextId === state.treeHighlightId) return;

  state.treeHighlightId = nextId;
  canvas.title = hit
    ? `${hit.student_name} (${hit.student_code}) — ${hit.word_count} từ`
    : '';
  showFruitInfo(hit);
  renderer.setHighlight(nextId);
}

/** Tapping a fruit toggles a persistent highlight (mobile has no hover). */
function onTreePointerDown(event) {
  const renderer = state.treeRenderer;
  if (!renderer) return;
  const point = pointerToCanvas(event);
  if (!point) return;
  const hit = hitTestFruits(renderer.fruitAnchors, point.x, point.y);
  state.treeHighlightId = hit ? hit.id : null;
  showFruitInfo(hit);
  renderer.setHighlight(state.treeHighlightId);
}

/**
 * Renders the STUDENT'S OWN TEAM's tree and updates the team badges.
 *
 * Phase 8.4 — the tree is no longer class-wide: only rows whose `team_number`
 * matches `state.studentTeam` are fed to the engine, the roster denominator is
 * that team's size, and the seed is derived with `getTeamSeed()` so the four
 * teams each grow a visually distinct tree. The class-wide `submissions`
 * argument is passed in unfiltered (Realtime merges every team's rows) and
 * narrowed here, so every caller stays team-agnostic.
 *
 * @param {object} session  Normalised: `{ seed, className, timeLimitMinutes, createdAt }`.
 * @param {object[]} submissions  All session rows; filtered down to the team.
 * @param {boolean} animate Whether to start the idle breeze.
 */
function renderTree(session, submissions, animate) {
  const renderer = treeRenderer();
  if (!renderer || !session) return null;

  const team = clampTeamNumber(state.studentTeam);
  const teamSubmissions = submissions.filter(
    (row) => clampTeamNumber(row.team_number) === team,
  );
  // Fall back to a quarter of the class when the RPC did not return a breakdown
  // (older session payload), so the denominator is never 0.
  const teamTotal = state.treeTeamCounts
    ? Number(state.treeTeamCounts[team]) || 0
    : Math.ceil((Number(session.totalStudents) || 0) / 4);

  const treeData = computeTreeState({
    totalStudents: Math.max(teamTotal, 1),
    submissions: teamSubmissions,
    timeLimitMinutes: session.timeLimitMinutes,
    createdAt: session.createdAt,
    seed: getTeamSeed(session.seed, team),
  });

  state.treeData = treeData;

  const subtitle = $('treeSubtitle');
  if (subtitle) {
    subtitle.textContent = `Lớp ${session.className || ''} · Tổ ${team}`.trim();
  }

  const progressBadge = $('treeProgressBadge');
  if (progressBadge) {
    const percent = Math.round((teamSubmissions.length / Math.max(teamTotal, 1)) * 100);
    progressBadge.textContent =
      `🌿 Tổ ${team}: ${teamSubmissions.length}/${teamTotal} bạn đã nộp (${percent}%)`;
  }
  const vitalityBadge = $('treeVitalityBadge');
  if (vitalityBadge) {
    vitalityBadge.textContent = `Sức sống: ${Math.round(treeData.vitality * 100)}%`;
  }

  if (animate === false) {
    renderer.render(treeData);
  } else {
    renderer.startAnimation(treeData);
  }

  // Phase 8.3 — chime the ONE moment the team's tree completes. Latched via
  // `state.treeFlourished` so a repaint or a later event cannot replay it.
  if (treeData.isFlourished && !state.treeFlourished) {
    state.treeFlourished = true;
    playBloomFanfare();
  }

  // Phase 8.4 — refresh the mini-leaderboard from the SAME data the tree uses.
  latchTreeChampion();
  renderLeaderboard();

  return treeData;
}

/**
 * Phase 8.4 — latches the FIRST team to reach full participation.
 *
 * Evaluated over ALL teams (not just the student's) because the 🏆 belongs to
 * whichever Tổ finished first. Once set it never moves, so a team finishing
 * later does not steal the crown.
 */
function latchTreeChampion() {
  if (state.treeChampionTeam !== null) return;
  const counts = state.treeTeamCounts;
  if (!counts) return;

  for (let team = 1; team <= 4; team += 1) {
    const total = Number(counts[team]) || 0;
    if (total <= 0) continue;
    const done = state.treeSubmissions.filter(
      (row) => clampTeamNumber(row.team_number) === team,
    ).length;
    if (done >= total) { state.treeChampionTeam = team; return; }
  }
}

/** Phase 8.4 — renders the sticky 4-team mini-leaderboard. */
function renderLeaderboard() {
  const host = $('treeTeamLeaderboard');
  if (!host) return;
  clear(host);

  const counts = state.treeTeamCounts;
  const myTeam = clampTeamNumber(state.studentTeam);

  for (let team = 1; team <= 4; team += 1) {
    const total = counts ? Number(counts[team]) || 0 : 0;
    const done = state.treeSubmissions.filter(
      (row) => clampTeamNumber(row.team_number) === team,
    ).length;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    const isMine = team === myTeam;
    const isChampion = state.treeChampionTeam === team;
    const label = isMine ? `★ Tổ ${team} của bạn: ${percent}%` : `Tổ ${team}: ${percent}%`;

    host.appendChild(el('span', {
      className: 'tree-leaderboard__badge'
        + (isMine ? ' is-my-team' : '')
        + (isChampion ? ' is-champion' : ''),
      text: isChampion ? `${label} 🏆` : label,
    }));
  }
}

/** Shows the tree screen and renders into it. */
function showTree(session, submissions, animate) {
  show($('treeScreen'));
  // The renderer measures clientWidth/clientHeight, which is 0 while the section
  // is display:none — so the first render must happen AFTER the screen is shown.
  return renderTree(session, submissions, animate);
}

/** Toggles between the check-in card and the interactive workspace. */
function setTreeView(view) {
  if (view === 'workspace') {
    hide($('treeCheckinForm'));
    show($('treeWorkspace'));
  } else {
    show($('treeCheckinForm'));
    hide($('treeWorkspace'));
  }
}

/** Non-blocking status banner inside the workspace. */
function treeStatus(message, kind) {
  const node = $('treeStatusMessage');
  if (!node) return;
  node.className = 'alert hidden';
  if (!message) { node.textContent = ''; return; }
  node.classList.remove('hidden');
  if (kind) node.classList.add(`alert--${kind}`);
  node.textContent = message;
}

/** Error banner inside the check-in card. */
function treeCheckinError(message) {
  const node = $('treeCheckinError');
  if (!node) return;
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

/**
 * Phase 7.4 — opens a tree activity from `?session=`/`?tree=`.
 *
 * Fired-and-forgotten from `boot()` (like `prefillFromUrl`): the RPC drives the
 * whole tree screen, so `boot()` continues wiring the exam form meanwhile. A
 * failure is contained here and never blocks the exam flow.
 */
function loadTreeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session') || params.get('tree');
  if (!sessionId) return false;
  loadTreeActivity(sessionId);
  return true;
}

/**
 * Loads a tree session and shows the check-in screen.
 *
 * Steps: (1) fetch the sanitised session payload, (2) show the question and the
 * candidate list, (3) pre-fetch existing submissions so the tree is already
 * populated before Realtime connects, (4) subscribe for live growth.
 */
async function loadTreeActivity(sessionId) {
  // Phase 8.1 — isolate the tree view BEFORE anything else. The error states
  // below must also render inside the tree view, so switching first means a bad
  // link shows the message there rather than leaving the exam form on screen.
  switchView('tree');

  // A URL is never trusted: the RPC takes a uuid, so anything else would be a
  // wasted round-trip and an opaque PostgREST cast error.
  if (!isUuid(sessionId)) {
    showTreeError('Liên kết tham gia không hợp lệ.');
    return;
  }

  show($('treeScreen'));
  setTreeView('checkin');
  treeCheckinError('');
  $('treeCheckinTitle').textContent = 'Đang tải hoạt động…';
  $('treeCheckinQuestion').textContent = '';
  $('treeCheckinMeta').textContent = '';

  const result = await callRpc('get_public_tree_session', { p_session_id: sessionId });

  if (!result.ok) {
    showTreeError('Không kết nối được máy chủ. Vui lòng thử lại.');
    return;
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    showTreeError(rpcMessage(payload.code, payload.message));
    return;
  }

  const session = payload.session || {};
  state.treeSession = {
    id: session.id,
    title: session.title || 'Cây Tri Thức',
    questionText: session.question_text || '',
    minWords: Number(session.min_words) || 1,
    timeLimitMinutes: Number(session.time_limit_minutes) || 0,
    seed: Number(session.tree_seed) || 0,
    createdAt: session.created_at,
    className: payload.class_name || '',
    totalStudents: Math.max(Number(payload.total_students) || 0, 1),
  };
  state.treeMembers = Array.isArray(payload.candidates) ? payload.candidates : [];
  state.treeSubmissions = [];
  state.treeIdentity = null;
  state.treeSubmitted = false;
  // Phase 8.3 — the session was just (re)loaded, so the fanfare latch must start
  // fresh; otherwise a previously-flourished class would never celebrate again.
  state.treeFlourished = false;
  // Phase 8.4 — per-team roster sizes and the champion latch both restart with
  // the session; the team itself is only known after check-in.
  state.treeTeamCounts = payload.team_counts || null;
  state.studentTeam = 1;
  state.treeChampionTeam = null;

  // Check-in copy.
  $('treeCheckinTitle').textContent = state.treeSession.title;
  $('treeCheckinQuestion').textContent = state.treeSession.questionText;
  $('treeCheckinMeta').textContent =
    `${state.treeSession.className} · Tối thiểu ${state.treeSession.minWords} từ`
    + ` · Thời gian ${state.treeSession.timeLimitMinutes} phút`;
  populateTreeStudentSelect();
  $('treeAnswerInput').value = '';

  // Pre-fetch so the canvas is already correct before Realtime connects (the
  // subscription only carries deltas — a student joining mid-lesson would
  // otherwise see an empty tree until the next submission).
  await loadTreeSubmissions(sessionId);
  subscribeTreeChannel(sessionId);

  // Re-render even while still on the check-in card: it is behind the card, but
  // showing it means entering the workspace needs no second fetch.
  showTree(state.treeSession, state.treeSubmissions, true);
}

/** Replaces the check-in view with a fatal error message. */
function showTreeError(message) {
  setTreeView('checkin');
  $('treeCheckinTitle').textContent = 'Không thể tham gia';
  $('treeCheckinQuestion').textContent = '';
  $('treeCheckinMeta').textContent = '';
  clear($('treeStudentSelect'));
  $('treeStudentSelect').appendChild(el('option', { text: '-- Chọn tên bạn --', attrs: { value: '' } }));
  $('btnEnterTree').disabled = true;
  treeCheckinError(message);
}

/** Fills #treeStudentSelect with the roster candidates. */
function populateTreeStudentSelect() {
  const select = $('treeStudentSelect');
  clear(select);
  select.appendChild(el('option', { text: '-- Chọn tên bạn --', attrs: { value: '' } }));
  state.treeMembers.forEach((member) => {
    select.appendChild(el('option', {
      text: member.full_name,
      attrs: { value: member.student_code },
    }));
  });
  $('btnEnterTree').disabled = true;
}

/** Fetches the session's submissions into `state.treeSubmissions`. */
async function loadTreeSubmissions(sessionId) {
  const { data, error } = await state.supabase
    .from('tree_submissions')
    .select('id, session_id, student_code, student_name, answer_text, word_count, submitted_at, fruit_index, team_number')
    .eq('session_id', sessionId)
    .order('fruit_index', { ascending: true });

  if (error) {
    console.error('tree_submissions fetch failed', error);
    return;
  }
  state.treeSubmissions = Array.isArray(data) ? data : [];
}

/**
 * Subscribes to Realtime on `tree_submissions` (D2).
 *
 * Every accepted answer is broadcast, so the whole class watches the tree grow.
 * The filter is server-side (`session_id=eq`), but rows are still re-checked
 * client-side: with a replica-identity fallback an UPDATE record can arrive
 * without the filterable column, and a stale channel from a previous session
 * must never leak a fruit into this one.
 */
function subscribeTreeChannel(sessionId) {
  unsubscribeTreeChannel();

  const channel = state.supabase
    .channel(`tree-student-${sessionId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'tree_submissions',
      filter: `session_id=eq.${sessionId}`,
    }, handleRealtimeSubmission)
    .subscribe();

  state.treeChannel = channel;
}

function unsubscribeTreeChannel() {
  if (state.treeChannel && state.supabase) {
    state.supabase.removeChannel(state.treeChannel);
  }
  state.treeChannel = null;
}

/** Merges one Realtime payload and repaints the canvas immediately. */
function handleRealtimeSubmission(payload) {
  const session = state.treeSession;
  if (!session) return;

  const eventType = payload.eventType;

  if (eventType === 'DELETE') {
    const removedId = payload.old && payload.old.id;
    if (!removedId) return;
    state.treeSubmissions = state.treeSubmissions.filter((row) => row.id !== removedId);
  } else {
    const row = payload.new;
    if (!row || !row.id) return;
    // Guard against an unfiltered/fallback record for another session.
    if (row.session_id !== session.id) return;

    const index = state.treeSubmissions.findIndex((existing) => existing.id === row.id);
    if (index === -1) {
      // New fruit; keep fruit_index order so the tree's layout matches every
      // other client's (the engine sorts internally, but the cache stays tidy).
      const next = state.treeSubmissions.slice();
      next.push(row);
      next.sort((a, b) => (a.fruit_index || 0) - (b.fruit_index || 0));
      state.treeSubmissions = next;
    } else {
      const next = state.treeSubmissions.slice();
      next[index] = row;
      state.treeSubmissions = next;
    }
  }

  renderTree(session, state.treeSubmissions, true);
}

/** Recomputes the counter and the submit button's enabled state. */
function updateTreeWordCounter() {
  const session = state.treeSession;
  if (!session) return;

  const words = countTreeWords($('treeAnswerInput').value);
  const counter = $('treeWordCounter');
  counter.textContent = treeWordCounterLabel(words, session.minWords);
  counter.classList.toggle('is-met', words >= session.minWords);
  counter.classList.toggle('is-short', words > 0 && words < session.minWords);

  $('btnSubmitTreeAnswer').disabled = words < session.minWords;
}

/** Check-in: pick a name, then enter the workspace. */
function enterTreeWorkspace() {
  const studentCode = $('treeStudentSelect').value;
  const session = state.treeSession;
  if (!session) return;

  const member = state.treeMembers.find((m) => m.student_code === studentCode);
  if (!member) { treeCheckinError('Vui lòng chọn tên của bạn trong danh sách.'); return; }

  state.treeIdentity = { student_code: member.student_code, full_name: member.full_name };
  // Phase 8.4 — the student's Tổ drives which of the four trees they watch and
  // which leaderboard badge is highlighted as their own.
  state.studentTeam = clampTeamNumber(member.team_number);
  treeCheckinError('');
  setTreeView('workspace');

  // The canvas was hidden until now, so its CSS box had no size. Re-render AFTER
  // the workspace is visible so `resize()` reads a real clientHeight.
  renderTree(session, state.treeSubmissions, true);

  const reminder = $('treeQuestionReminder');
  if (reminder) reminder.textContent = session.questionText;

  // Mark the student's own fruit once it exists (they may be re-joining).
  const mine = state.treeSubmissions.find(
    (row) => row.student_code === member.student_code,
  );
  if (mine) {
    state.treeSubmitted = true;
    $('treeAnswerInput').value = mine.answer_text || '';
    state.treeHighlightId = mine.id;
    state.treeRenderer.setHighlight(mine.id);
  }

  updateTreeWordCounter();
  $('treeAnswerInput').focus();
}

/**
 * Submits (or updates) the student's answer.
 *
 * On `SIMILARITY_EXCEEDED` the textarea is deliberately NOT cleared — the whole
 * point is for the student to rephrase what they just wrote. On success the
 * student's own fruit is highlighted so they can find it on a crowded tree.
 */
async function submitTreeAnswer() {
  const session = state.treeSession;
  const identity = state.treeIdentity;
  if (!session || !identity) return;

  const answerText = normalizeAnswerText($('treeAnswerInput').value);
  const words = countTreeWords(answerText);
  if (words < session.minWords) {
    updateTreeWordCounter();
    return;
  }

  const button = $('btnSubmitTreeAnswer');
  button.disabled = true;
  treeStatus('Đang gửi câu trả lời…', 'info');

  // Phase 8.3 — this click is a user gesture, so it is the point at which the
  // AudioContext may be resumed (Autoplay Policy). Awaited BEFORE the RPC so the
  // success chime is unlocked by the time it fires.
  await resumeAudioContext();

  const result = await callRpc('submit_tree_answer', {
    p_session_id: session.id,
    p_student_code: identity.student_code,
    p_student_name: identity.full_name,
    p_answer_text: answerText,
  });

  if (!result.ok) {
    treeStatus('Không gửi được câu trả lời. Vui lòng kiểm tra kết nối và thử lại.', 'error');
    button.disabled = false;
    return;
  }

  const payload = result.data || {};

  if (payload.success !== true) {
    if (payload.code === 'SIMILARITY_EXCEEDED') {
      const percent = payload.similarity_percent;
      // Keep the textarea intact so the student can rephrase the SAME text.
      treeStatus(
        `⚠️ Câu trả lời của bạn trùng ${percent}% với một bài đã nộp. `
        + 'Hãy diễn đạt lại theo cách của riêng bạn rồi gửi lại nhé!',
        'warning',
      );
    } else if (payload.code === 'MIN_WORDS_NOT_MET') {
      treeStatus(
        `Câu trả lời cần tối thiểu ${session.minWords} từ (bạn mới nhập ${payload.current_words} từ).`,
        'warning',
      );
    } else {
      treeStatus(rpcMessage(payload.code, payload.message), 'error');
    }
    button.disabled = false;
    return;
  }

  // --- success ------------------------------------------------------------
  state.treeSubmitted = true;
  const submissionId = payload.submission_id;
  state.treeHighlightId = submissionId;

  // The Realtime echo normally arrives within ~200ms. Refresh from the RPC's own
  // response first so the student sees their fruit immediately even if the
  // socket is slow — the merge by id makes the later echo a no-op.
  await loadTreeSubmissions(session.id);
  renderTree(session, state.treeSubmissions, true);
  state.treeRenderer.setHighlight(submissionId);

  // Phase 8.3 — a local chime confirms the answer was accepted, independent of
  // the Realtime echo (which may arrive a moment later or not at all on a weak
  // connection). Vitality is read off the just-rendered state so it matches.
  playDewdropSound(state.treeData ? state.treeData.vitality : 1);

  treeStatus('🌱 Giọt sương tri thức của bạn đã hòa vào cây! Bạn có thể sửa và gửi lại trước khi hết giờ.', 'success');
  button.disabled = false;
  $('treeAnswerInput').focus();
}

/** Wires the tree screen's controls. Called once from `boot()`. */
function bindTreeControls() {
  $('treeStudentSelect').addEventListener('change', () => {
    $('btnEnterTree').disabled = !$('treeStudentSelect').value;
    treeCheckinError('');
  });
  $('btnEnterTree').addEventListener('click', enterTreeWorkspace);
  $('treeAnswerInput').addEventListener('input', updateTreeWordCounter);
  $('btnSubmitTreeAnswer').addEventListener('click', submitTreeAnswer);

  // Phase 8.3 — audio toggle. The click both resumes the AudioContext (Autoplay
  // Policy) and flips the persisted mute flag; the label reflects the new state.
  const audioButton = $('btnTreeAudioToggle');
  if (audioButton) {
    syncTreeAudioToggle(audioButton);
    audioButton.addEventListener('click', () => {
      void resumeAudioContext();
      toggleAudioMute();
      syncTreeAudioToggle(audioButton);
    });
  }

  // The very first tap anywhere in the tree view also unlocks audio, so a
  // student who never touches the toggle still hears the class tree grow.
  document.addEventListener('pointerdown', () => { void resumeAudioContext(); }, {
    capture: true,
    once: true,
  });
}

/** Reflects the persisted mute state on the toggle button. */
function syncTreeAudioToggle(button) {
  const muted = isAudioMuted();
  button.textContent = muted ? '🔇' : '🔊';
  button.setAttribute('aria-pressed', String(!muted));
  button.title = muted ? 'Bật âm thanh' : 'Tắt âm thanh';
}


/* =====================================================================
   View router (Phase 8.1)
   =====================================================================
   The two top-level `.spa-view` containers are mutually exclusive:

     #view-exam — the whole exam/practice flow
     #view-tree — the Tree of Knowledge, which must own the FULL viewport

   Isolating the tree view in its own container (rather than a `.screen` inside
   the exam shell) is what stops the exam header, the tab bar and the login form
   from showing through / competing for layout when a student opens a join link.
   ===================================================================== */

/**
 * Shows one top-level view and hides the other.
 *
 * Uses inline `display` (not the `.hidden` class) because `#view-exam` has no
 * `hidden` class in the markup: it is the default view, so it must be visible on
 * load without a class to remove.
 */
function switchView(viewName) {
  const examView = $('view-exam');
  const treeView = $('view-tree');
  if (viewName === 'tree') {
    if (examView) examView.style.display = 'none';
    if (treeView) treeView.style.display = 'block';
    // Only the tree view is scrollable-to-top; an exam view left scrolled would
    // otherwise land the student mid-page when they switch back.
    window.scrollTo(0, 0);
  } else {
    if (treeView) treeView.style.display = 'none';
    if (examView) examView.style.display = 'block';
  }
}

async function boot() {
  initTheme();

  try {
    state.supabase = initSupabase();
  } catch (error) {
    loginError(error.message);
    $('startBtn').disabled = true;
    return;
  }

  $('loginForm').addEventListener('submit', handleLoginSubmit);
  bindRosterControls();
  // Phase 7.4 — tree participation controls. Wired before the URL check so a
  // bad link can still leave the student with a working (disabled) form.
  bindTreeControls();

  // Phase 7.2 — re-measure on rotation/resize; the canvas is sized from its
  // CSS box, which does not reflow the backing store on its own.
  window.addEventListener('resize', () => {
    if (state.treeData && state.treeRenderer) state.treeRenderer.render(state.treeData);
  });
  $('practiceForm').addEventListener('submit', handlePracticeSubmit);
  $('tabOfficial').addEventListener('click', () => selectModeTab('official'));
  $('tabPractice').addEventListener('click', () => selectModeTab('practice'));
  $('practiceSourceCodeBtn').addEventListener('click', () => selectPracticeSource('code'));
  $('practiceSourceFileBtn').addEventListener('click', () => selectPracticeSource('file'));
  // Phase 8.1 — fetch the practice roster (closed-but-practiceable exams included)
  // once a code is entered, so the class/name datalists can suggest the identity.
  $('practice-exam-code').addEventListener('change', (event) => {
    void loadPracticeRoster(event.target.value);
  });
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

  // Phase 7.4 — an explicit tree link wins over both the login form and a
  // resumable exam: opening `?session=` IS the student's intent, and resuming
  // would immediately hide the tree screen. The stored exam session is left
  // untouched, so dropping the query string resumes it.
  if (loadTreeFromUrl()) return;

  const resumed = await tryResumeSession();
  if (!resumed) {
    show($('loginScreen'));
    // Phase 6.3 — only prefill when we are actually showing the login form; a
    // resumed session skips the landing screen entirely, so the roster fetch
    // would be wasted work.
    prefillFromUrl();
  }
}

boot();
