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
import { resolveSupabaseConfig, resolveWorkerBaseUrl } from './app-config.js';
import {
  AUTO_ADVANCE_MS, FONT_CYCLE, FONT_KEY, FONT_LABELS, THEME_KEY,
  buildPaletteCells, clampQuestionIndex, getUnansweredQuestions, nextFontStep, nextTheme, normalizeTheme,
  readAutoAdvancePreference, shouldAutoAdvance, writeAutoAdvancePreference,
} from './exam-nav.js';
import {
  partitionAndShuffleOrder, partitionAndShuffleQuestions, readShuffleToggle,
} from './practice-order.js';
import { TreeRenderer, clampTeamNumber, computeTreeState, getTeamSeed, hitTestFruits } from './tree-engine.js';
import { countTreeWords, normalizeAnswerText, treeWordCounterLabel } from './tree-words.js';
import {
  isAudioMuted, playBloomFanfare, playDewdropSound, resumeAudioContext, toggleAudioMute,
} from './tree-audio.js';

/* =====================================================================
   Constants
   ===================================================================== */

const STORAGE_KEY = 'adqs_student_session_v2';
const HEARTBEAT_MS = 20_000;
const RING_CIRCUMFERENCE = 540;          // 2 * PI * r(86)
const MAX_TEXT_LENGTH = 20_000;
const MAX_DEVICE_INFO = 200;
const CERT_PASS_PERCENT = 80;            // must match schema: score/total >= 0.8
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Phase 8.1 — base URL of the Cloudflare Worker that parses a personal .docx.
 *
 * Resolved from `window.__APP_CONFIG__.workerApiUrl` by `app-config.js`, which
 * also strips trailing slashes and tolerates a full endpoint path. There is NO
 * built-in fallback: this bundle is deployed by more than one operator, so a
 * baked-in development URL would silently send a school's uploads to the wrong
 * host. An empty result is reported to the student as "chưa cấu hình".
 */
function workerBaseUrl() {
  return resolveWorkerBaseUrl(window.__APP_CONFIG__);
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
  // Phase 8.9 — class-gated .docx self-practice.
  CLASS_NOT_FOUND: 'Lớp học không tồn tại trên hệ thống. Vui lòng kiểm tra lại tên lớp!',
  CLASS_PRACTICE_DISABLED: 'Lớp của bạn hiện đang tạm khóa quyền tự luyện tập. Vui lòng liên hệ giáo viên!',
  STUDENT_NOT_FOUND: 'Thông tin học sinh không có trong danh sách của lớp này.',
  // Phase 7.4 — Tree of Knowledge participation.
  SESSION_NOT_FOUND: 'Phiên hoạt động không tồn tại hoặc đã bị xoá.',
  SESSION_INACTIVE: 'Phiên hoạt động đã kết thúc. Cảm ơn bạn đã tham gia!',
  IDENTITY_REQUIRED: 'Vui lòng chọn tên của bạn trước khi gửi.',
  MIN_WORDS_NOT_MET: 'Câu trả lời chưa đủ số từ tối thiểu.',
  // Phase 9.1 — the lobby gate and the absent list.
  NOT_STARTED: 'Trận đấu chưa bắt đầu. Vui lòng chờ giáo viên!',
  STUDENT_ABSENT: 'Bạn đã được đánh dấu vắng mặt ở hoạt động này.',
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

/**
 * Phase 8.8 — canonical form for comparing a student's typed text with a roster
 * row.
 *
 * Three normalizations, each fixing a real way two "equal" strings differ:
 *
 *   - `normalize('NFC')` unifies composed vs decomposed Vietnamese diacritics.
 *     A name typed on a phone (or pasted from a PDF) can be a DIFFERENT byte
 *     sequence than the one stored in the database while looking identical, so
 *     `'ế' === 'ế'` is false without this.
 *   - `trim()` + collapsing `\s+` to a single space absorbs stray double spaces,
 *     non-breaking spaces and tabs around/between words.
 *   - `toLowerCase()` makes the comparison case-insensitive.
 *
 * The server applies the same whitespace + case normalization in SQL
 * (verify_and_acquire_session, Phase 8.8), so the two agree on what "matches".
 */
function normalizeText(str) {
  if (!str) return '';
  return str.toString().normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

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
  answers: [],              // per-question draft (the answer itself)
  flags: new Set(),
  currentIndex: 0,
  /**
   * Phase 8.5 — the index whose selection should play the `is-flash` confirmation
   * animation on the next paint (set by selectMcq/selectTrueFalse, cleared on
   * navigation). Null = nothing to flash.
   */
  flashIndex: null,
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
  securityConfig: null,
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
  /**
   * Phase 8.9 — class names whose teachers permit DOCX self-practice, from
   * `get_public_practice_classes()`. Offered in the class datalist so a student
   * picks a class that will actually pass `verify_student_practice`.
   */
  practiceClasses: [],
  practiceClassesLoaded: false,
  /**
   * Phase 8.10 — the by-code verification verdict for `#practiceMetaBanner`:
   * `null` (not verified yet), `'ok'`, or `'error'`. Drives whether the shared
   * submit button is disabled while the by-code source is selected.
   */
  practiceCodeStatus: null,
  /** The code `practiceCodeStatus` refers to, so a stale verdict is detectable. */
  practiceVerifiedCode: '',
  /**
   * Phase 8.10 — true once a practice code has been taken from the URL, so
   * re-opening the practice tab does not re-fire the verification RPC.
   */
  practiceUrlPrefilled: false,
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
   * Phase 9.1 — the lobby lifecycle of the loaded session (`LOBBY` | `ACTIVE`)
   * and its activity type (`BRAINSTORM` | `SPEED_QUIZ`). `treeSessionId` is the
   * uuid the Realtime channel filters on, kept separately from the code the
   * student typed because `?code=`/`?tree=` may carry either form.
   */
  treeStatus: 'ACTIVE',
  treeGameMode: 'BRAINSTORM',
  treeSessionId: null,
  /**
   * Phase 9.1 — the reason the student is spectating, when the teacher marked
   * them absent: renders the spectator card instead of the check-in form.
   */
  treeIsAbsent: false,
  /** Phase 9.1 — Realtime subscription on `tree_sessions` (LOBBY -> ACTIVE). */
  treeSessionChannel: null,
  /** Phase 9.1 — local countdown display state (server deadline is authoritative). */
  treeRemainingSeconds: 0,
  treeCountdownTimer: null,
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
      security_config: state.securityConfig,
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
   Theme + font size (Phase 8.5)
   ===================================================================== */

/** OS dark-mode preference, resolved against the explicit theme choice. */
function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Current theme, resolving "no explicit choice" against the OS preference. */
function currentTheme() {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'), prefersDark());
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === 'light' || saved === 'dark' || saved === 'sepia') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  renderThemeIcon();
}

/** Cycles light -> dark -> sepia -> light and persists the choice. */
function toggleTheme() {
  const next = nextTheme(currentTheme());
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  renderThemeIcon();
}

/**
 * Reflects the active theme on one theme button (glyph + accessible name).
 *
 * Phase 8.6 — there are two of them: the in-exam `#btn-theme-toggle` and the
 * global `#btn-global-theme-toggle` on the login/roster screen. Both must show
 * the same state, so the painting lives here rather than in either listener.
 */
function paintThemeButton(node, theme) {
  if (!node) return;
  const glyph = theme === 'dark' ? '☀' : theme === 'sepia' ? '🌗' : '🌙';
  // Keep whatever label class the markup used (`.btn-label` in the exam header,
  // `.theme-label` on the global button) so the responsive hiding rule still applies.
  const existing = node.querySelector('.btn-label, .theme-label');
  const labelClass = existing ? existing.className : 'btn-label';
  node.textContent = '';
  node.appendChild(document.createTextNode(`${glyph} `));
  node.appendChild(el('span', { className: labelClass, text: 'Giao diện' }));
  node.setAttribute('aria-label', `Giao diện: ${theme === 'dark' ? 'Tối' : theme === 'sepia' ? 'Dịu mắt' : 'Sáng'}`);
}

function renderThemeIcon() {
  const theme = currentTheme();
  paintThemeButton($('btn-theme-toggle'), theme);
  paintThemeButton($('btn-global-theme-toggle'), theme);
}

/* ---------- font size ---------- */

function currentFontStep() {
  const attr = document.documentElement.getAttribute('data-font');
  return FONT_CYCLE.includes(attr) ? attr : '';
}

function initFontSize() {
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch { /* ignore */ }
  if (FONT_CYCLE.includes(saved) && saved !== '') {
    document.documentElement.setAttribute('data-font', saved);
  }
  renderFontIcon();
}

function cycleFontSize() {
  const next = nextFontStep(currentFontStep());
  // '' is the CSS default, so the attribute is removed rather than set — this
  // keeps a stale `data-font=""` (or a future renamed default) from pinning the
  // student to a value the stylesheet no longer defines.
  if (next === '') document.documentElement.removeAttribute('data-font');
  else document.documentElement.setAttribute('data-font', next);
  try { localStorage.setItem(FONT_KEY, next); } catch { /* ignore */ }
  renderFontIcon();
}

function renderFontIcon() {
  const node = $('btn-font-toggle');
  if (!node) return;
  node.textContent = '';
  node.appendChild(document.createTextNode('🔤 '));
  // The label names the CURRENT size, so a student can tell what they are on
  // without counting taps ("Cỡ chữ: Chuẩn / Lớn / Rất lớn").
  node.appendChild(el('span', {
    className: 'btn-label',
    text: `Cỡ chữ: ${FONT_LABELS[currentFontStep()]}`,
  }));
}

/* =====================================================================
   Supabase client
   ===================================================================== */

function initSupabase() {
  const { url, key, configured } = resolveSupabaseConfig(window.__APP_CONFIG__);
  if (!configured) {
    throw new Error(
      'Chưa cấu hình Supabase. Hãy tạo config.js từ config.example.js và điền '
      + 'supabaseUrl + supabasePublishableKey.',
    );
  }
  return createClient(url, key, {
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
function applyPinLabels(pinMode) {
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
function renderExamBanner(payload) {
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
function clearExamBanner() {
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
 *   - manual: class + name are matched against whatever roster was fetched.
 *
 * Phase 8.8 — the manual branch no longer REQUIRES a roster. The server's
 * `verify_and_acquire_session` now resolves the candidate from (class_name,
 * full_name) when the code is absent, so a failed/empty roster fetch is no
 * longer a login blocker: the student submits name + class and the server
 * decides. The roster is consulted only to attach the code when it happens to
 * know it, which stays useful as a disambiguator between two same-named
 * candidates in one class.
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

async function handleLoginSubmit(event) {
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
 * Applies the display shuffle to the official exam.
 *
 * Phase 8.7 — the teacher decides. When `exam.shuffle_questions` is false the
 * authored `position ASC` order is preserved verbatim and `displayOrder` stays
 * null (an identity mapping), because the server already returned the questions
 * in that order. This matters for papers whose numbering carries meaning (a
 * sequenced derivation, a passage referenced by "the text above").
 *
 * The permutation itself lives in `practice-order.js` so this shuffle and the
 * practice toggle share ONE implementation — including the TRUE_FALSE-at-the-end
 * grouping — and the e2e suite can exercise it without loading this DOM-bound
 * module. Options are NOT reordered: their indices are tied to the stored
 * `correct_answer`.
 */
function applyDisplayShuffle() {
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
    state.flashIndex = null;
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

/**
 * Creates the empty answer slot for one question.
 *
 * Phase 8.5 — the draft/lock ("Xác nhận") step is GONE. Selection is now
 * immediate and auto-advances, so an answer is simply the chosen value; there is
 * no intermediate confirmed state to model.
 */
function makeEmptyAnswer(question) {
  const type = normalizeType(question.type);
  if (type === 'TRUE_FALSE') {
    const count = Array.isArray(question.subQuestions) ? question.subQuestions.length : 4;
    return { draft: new Array(Math.max(1, count)).fill('') };
  }
  if (type === 'MCQ') return { draft: null };
  return { draft: '' };
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
  // The drawer is toggled via the .is-open transform, not the `hidden` class —
  // closePalette() keeps those two mechanisms in sync.
  closePalette();
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

  renderActionBar();
  renderPalette();
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
      },
    });
    if (selected) btn.classList.add('is-selected');
    // Phase 8.5 — the question just advanced to is the one to flash, so the
    // student's last tap is visibly acknowledged for the full 280ms beat.
    if (selected && state.flashIndex === state.currentIndex) btn.classList.add('is-flash');
    btn.appendChild(el('span', { className: 'option__key', text: String.fromCharCode(65 + index) }));
    btn.appendChild(el('span', { className: 'option__label', text: option }));
    // A second tap on the SAME option toggles nothing but must not re-advance.
    btn.addEventListener('click', () => selectMcq(index));
    list.appendChild(btn);
  });
  return list;
}

function buildTrueFalse(question, answer) {
  const list = el('div', { className: 'tf-list' });
  const subs = Array.isArray(question.subQuestions) ? question.subQuestions : [];

  subs.forEach((sub, index) => {
    const item = el('div', { className: 'tf-item' });
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
   Answer interaction + auto-advance (Phase 8.5)
   ===================================================================== */

/**
 * The pending auto-advance timer. Held in module scope so a fresh selection
 * always cancels the previous pending jump — otherwise rapid tapping would queue
 * several advances.
 */
let autoAdvanceTimer = null;

/** Whether selecting an MCQ/TF answer should jump to the next question. */
let autoAdvanceEnabled = readAutoAdvancePreference(localStorage);

function setAutoAdvancePreference(enabled) {
  autoAdvanceEnabled = enabled;
  writeAutoAdvancePreference(localStorage, enabled);
}

/**
 * Cancels a pending auto-advance. Called on every manual navigation and on
 * submit so a stale timer can never yank the student away from the question
 * they deliberately jumped to.
 */
function cancelAutoAdvance() {
  if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
}

/**
 * Schedules the auto-jump, if the shared policy says we should.
 *
 * The DECISION lives in `exam-nav.js#shouldAutoAdvance()` (so the suite can
 * assert it headlessly); this only owns the timer. Text answers (ESSAY / SHORT)
 * never qualify there: the student is mid-typing and a jump 280ms after a
 * keystroke would be hostile.
 */
function maybeAutoAdvance(type, answer, changed) {
  cancelAutoAdvance();
  const should = shouldAutoAdvance({
    enabled: autoAdvanceEnabled,
    currentIndex: state.currentIndex,
    total: state.questions.length,
    type,
    answer,
    changed,
  });
  if (!should) return;
  const from = state.currentIndex;
  autoAdvanceTimer = setTimeout(() => {
    autoAdvanceTimer = null;
    // Guard: the student may have navigated manually inside the beat.
    if (state.currentIndex !== from) return;
    goToQuestion(from + 1);
  }, AUTO_ADVANCE_MS);
}

function selectMcq(index) {
  const answer = state.answers[state.currentIndex];
  const changed = answer.draft !== index;
  answer.draft = index;
  state.flashIndex = state.currentIndex;
  renderQuestion();
  updatePaletteState();
  // Only advance on a genuine change; re-tapping the current choice should not
  // silently move the student off a question they were re-reading.
  maybeAutoAdvance('MCQ', answer, changed);
}

function selectTrueFalse(subIndex, value) {
  const answer = state.answers[state.currentIndex];
  const changed = answer.draft[subIndex] !== value;
  answer.draft[subIndex] = value;
  state.flashIndex = state.currentIndex;
  renderQuestion();
  updatePaletteState();
  // TRUE_FALSE has several sub-statements; shouldAutoAdvance() holds the jump
  // until EVERY one has been answered, or the student loses the rest.
  maybeAutoAdvance('TRUE_FALSE', answer, changed);
}

function selectText(value) {
  const answer = state.answers[state.currentIndex];
  answer.draft = value.slice(0, MAX_TEXT_LENGTH);
  // No auto-advance while typing — shouldAutoAdvance() returns false for text.
  updatePaletteState();
}

/** Toggles the review flag on the current question. */
function toggleFlag() {
  const index = state.currentIndex;
  if (state.flags.has(index)) state.flags.delete(index); else state.flags.add(index);
  renderQuestion();
}

/** True when the question has any answer recorded (drives palette/answered count). */
function isDraftReady(type, answer) {
  if (type === 'MCQ') return answer.draft !== null;
  if (type === 'TRUE_FALSE') return answer.draft.some((value) => value !== '');
  return String(answer.draft || '').trim() !== '';
}

/**
 * Phase 8.5 — jumps to a question, clamping out-of-range input.
 *
 * Every navigation path funnels through here (the bottom bar, the palette, the
 * keyboard, auto-advance) so button/legend state is recomputed in exactly one
 * place and can never drift from `state.currentIndex`.
 */
function goToQuestion(index) {
  cancelAutoAdvance();
  state.currentIndex = clampQuestionIndex(index, state.questions.length);
  state.flashIndex = null;
  renderQuestion();
}

function goNext() {
  if (state.currentIndex >= state.questions.length - 1) { openSubmitConfirm(); return; }
  goToQuestion(state.currentIndex + 1);
}

function goPrev() {
  if (state.currentIndex <= 0) return;
  goToQuestion(state.currentIndex - 1);
}

function jumpTo(index) {
  closePalette();
  goToQuestion(index);
}

function renderActionBar() {
  const prev = $('btn-prev-question');
  const next = $('btn-next-question');
  const bar = $('examBottomBar');

  prev.disabled = state.currentIndex === 0;

  const isLast = state.currentIndex >= state.questions.length - 1;
  if (bar) bar.classList.toggle('is-last', isLast);
  if (next) next.textContent = 'Câu tiếp ➡';

  const answered = countAnswered();
  const progress = $('palette-progress-label');
  if (progress) progress.textContent = `${answered}/${state.questions.length}`;

  const flagBtn = $('btn-flag-question');
  if (flagBtn) {
    const on = state.flags.has(state.currentIndex);
    flagBtn.classList.toggle('is-on', on);
    flagBtn.setAttribute('aria-pressed', String(on));
    flagBtn.innerHTML = on
      ? '🚩 <span class="btn-label">Bỏ đánh dấu</span>'
      : '🚩 <span class="btn-label">Đánh dấu</span>';
  }
}

/* =====================================================================
   Question palette drawer (Phase 8.5)
   ===================================================================== */

/** Recomputes the answered count and repaints the palette + header. */
function updatePaletteState() {
  renderPalette();
  updateHeader();
}

/**
 * Renders the bottom-sheet question palette from the shared cell model.
 *
 * Cell roles mirror the drawer's legend: `is-answered` (green = has an answer),
 * `is-flagged` (a 🚩 badge via ::after), `is-current` (focus ring). Answered and
 * flagged can co-exist — the flag is a ::after badge, not a background — so a
 * student can still spot a marked question even after answering it.
 */
function renderPalette() {
  const grid = $('palette-grid-container');
  if (!grid) return;
  clear(grid);

  // The cell MODEL is built by the shared, DOM-free helper so the suite can
  // assert the grid size / roles without a browser; this renders it.
  const cells = buildPaletteCells({
    total: state.questions.length,
    answered: state.questions.map((question, index) => (
      isDraftReady(normalizeType(question.type), state.answers[index])
    )),
    flags: state.flags,
    currentIndex: state.currentIndex,
  });

  cells.forEach((cell) => {
    const node = el('button', {
      className: 'palette-cell',
      text: cell.label,
      attrs: { type: 'button', 'aria-label': `Câu ${cell.label}` },
    });
    if (cell.flagged) node.classList.add('is-flagged');
    if (cell.answered) node.classList.add('is-answered');
    if (cell.current) { node.classList.add('is-current'); node.setAttribute('aria-current', 'true'); }
    node.addEventListener('click', () => jumpTo(cell.index));
    grid.appendChild(node);
  });

  const answeredNode = $('palette-answered-count');
  const totalNode = $('palette-total-count');
  if (answeredNode) answeredNode.textContent = String(cells.answeredCount);
  if (totalNode) totalNode.textContent = String(state.questions.length);
}

function openPalette() {
  renderPalette();
  show($('palette-backdrop'));
  $('question-palette-drawer').classList.add('is-open');
  $('question-palette-drawer').setAttribute('aria-hidden', 'false');
}

function closePalette() {
  const backdrop = $('palette-backdrop');
  const drawer = $('question-palette-drawer');
  if (backdrop) hide(backdrop);
  if (drawer) {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }
}

function isPaletteOpen() {
  const drawer = $('question-palette-drawer');
  return !!drawer && drawer.classList.contains('is-open');
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
  hide($('submitModal'));
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

/* =====================================================================
   Anti-Cheat Suite — Client Defense Shield & Security Policy (Phase 11.0)
   ===================================================================== */

let lastViolationTimes = {};
function reportViolation(type, message, metadata = {}) {
  const now = Date.now();
  if (lastViolationTimes[type] && now - lastViolationTimes[type] < 3000) return;
  lastViolationTimes[type] = now;

  const client = state.supabase;
  if (!client || !state.examCode || !state.studentCode) return;
  client.rpc('log_exam_violation', {
    p_exam_code: state.examCode,
    p_student_code: state.studentCode,
    p_violation_type: type,
    p_message: message,
    p_metadata: metadata,
  }).catch(console.error);
}

let watermarkObserver = null;
function setupForensicWatermark(name, code, examCode) {
  const existing = document.getElementById('forensicWatermark');
  if (existing) existing.remove();
  if (watermarkObserver) {
    watermarkObserver.disconnect();
    watermarkObserver = null;
  }

  const text = `${name || 'Thí sinh'} • ${code || ''} • ${examCode || ''}`;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#000000';
  ctx.translate(160, 80);
  ctx.rotate(-25 * Math.PI / 180);
  ctx.textAlign = 'center';
  ctx.fillText(text, 0, 0);

  const dataUrl = canvas.toDataURL();
  let wmEl = document.createElement('div');
  wmEl.id = 'forensicWatermark';
  wmEl.className = 'watermark-overlay';
  wmEl.style.backgroundImage = `url("${dataUrl}")`;
  document.body.appendChild(wmEl);

  // Self-healing against DOM removal via DevTools
  watermarkObserver = new MutationObserver(() => {
    if (state.antiCheatBound && !document.getElementById('forensicWatermark')) {
      document.body.appendChild(wmEl);
      reportViolation('WATERMARK_TAMPER', 'Phát hiện can thiệp DOM xóa hình mờ pháp y');
    }
  });
  watermarkObserver.observe(document.body, { childList: true });
}

function onSecurityCopyCutContext(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  if (e.clipboardData) e.clipboardData.setData('text/plain', '');
  reportViolation('COPY_ATTEMPT', 'Thao tác sao chép hoặc mở menu chuột phải bị chặn');
}

function onSecuritySelectionChange() {
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) {
    const active = document.activeElement;
    if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
      sel.removeAllRanges();
    }
  }
}

function onSecurityTouch(e) {
  if (e.touches && e.touches.length >= 3) {
    e.preventDefault();
    document.body.classList.add('security-blur');
    reportViolation('MULTI_TOUCH', `Phát hiện cử chỉ chạm ${e.touches.length} ngón tay`);
  }
}

function onSecurityTouchEnd(e) {
  if (!e.touches || e.touches.length === 0) {
    setTimeout(() => {
      if (!document.hidden && document.hasFocus()) {
        document.body.classList.remove('security-blur');
      }
    }, 600);
  }
}

function onSecurityWindowBlur() {
  if (state.mode !== 'quiz' && !state.antiCheatBound) return;
  if (!$('fullscreenOverlay').classList.contains('hidden')) return;
  document.body.classList.add('security-blur');
  state.blurCount += 1;
  reportViolation('WINDOW_BLUR', 'Trình duyệt mất tiêu điểm (chuyển app hoặc chụp màn hình)');
}

function onSecurityWindowFocus() {
  if (document.body.classList.contains('security-blur')) {
    document.body.classList.remove('security-blur');
  }
}

function onSecurityVisibilityChange() {
  if (state.mode !== 'quiz' && !state.antiCheatBound) return;
  if (document.hidden) {
    document.body.classList.add('security-blur');
    state.blurCount += 1;
    reportViolation('TAB_HIDDEN', 'Rời tab hoặc chuyển sang ứng dụng khác');
  } else {
    document.body.classList.remove('security-blur');
  }
}

/** Text fields must stay usable, so selection blocking skips form controls. */
function onSelectStart(event) {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  event.preventDefault();
}

function initAntiCheat(cfg) {
  if (cfg) state.securityConfig = cfg;
  bindAntiCheat(state.securityConfig);
}

function bindAntiCheat(cfg) {
  // Zero anti-cheat in self-practice (Phase 5.2 §Business rules 2): no
  // fullscreen lock, no blur tracking, no context-menu/selection blocking.
  if (state.mode === 'practice' || state.isPractice) return;
  if (state.antiCheatBound) return;
  state.antiCheatBound = true;

  const config = cfg || state.securityConfig || {
    prevent_copy: true,
    detect_multitouch: true,
    blur_on_leave: true,
    watermark: true,
    max_violations: 3,
  };
  state.securityConfig = config;

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 1. Prevent Copy & Callout
  if (config.prevent_copy) {
    document.body.classList.add('security-locked');
    document.addEventListener('contextmenu', onSecurityCopyCutContext);
    document.addEventListener('copy', onSecurityCopyCutContext);
    document.addEventListener('cut', onSecurityCopyCutContext);
    document.addEventListener('paste', preventDefaultHandler);
    document.addEventListener('selectstart', onSelectStart);
    document.addEventListener('selectionchange', onSecuritySelectionChange);
  }

  // 2. Multi-touch (>= 3 fingers)
  if (config.detect_multitouch) {
    window.addEventListener('touchstart', onSecurityTouch, { passive: false });
    window.addEventListener('touchmove', onSecurityTouch, { passive: false });
    window.addEventListener('touchend', onSecurityTouchEnd);
  }

  // 3. Blur on Leave / Window change
  if (config.blur_on_leave) {
    window.addEventListener('blur', onSecurityWindowBlur);
    window.addEventListener('focus', onSecurityWindowFocus);
    document.addEventListener('visibilitychange', onSecurityVisibilityChange);
  }

  // 4. Dynamic Forensic Watermark
  if (config.watermark) {
    setupForensicWatermark(state.fullName, state.studentCode, state.examCode);
  }
}

function unbindAntiCheat() {
  if (!state.antiCheatBound) return;
  state.antiCheatBound = false;

  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange);

  document.body.classList.remove('security-locked', 'security-blur');

  document.removeEventListener('contextmenu', onSecurityCopyCutContext);
  document.removeEventListener('copy', onSecurityCopyCutContext);
  document.removeEventListener('cut', onSecurityCopyCutContext);
  document.removeEventListener('paste', preventDefaultHandler);
  document.removeEventListener('selectstart', onSelectStart);
  document.removeEventListener('selectionchange', onSecuritySelectionChange);

  window.removeEventListener('touchstart', onSecurityTouch);
  window.removeEventListener('touchmove', onSecurityTouch);
  window.removeEventListener('touchend', onSecurityTouchEnd);

  window.removeEventListener('blur', onSecurityWindowBlur);
  window.removeEventListener('focus', onSecurityWindowFocus);
  document.removeEventListener('visibilitychange', onSecurityVisibilityChange);

  if (watermarkObserver) {
    watermarkObserver.disconnect();
    watermarkObserver = null;
  }
  const wmEl = document.getElementById('forensicWatermark');
  if (wmEl) wmEl.remove();
}

if (typeof window !== 'undefined') {
  window.reportViolation = reportViolation;
  window.initAntiCheat = initAntiCheat;
  window.setupForensicWatermark = setupForensicWatermark;
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
  if (!$('submitModal').classList.contains('hidden')) return;

  const type = normalizeType(state.questions[state.currentIndex].type);
  const key = event.key;
  const lower = key.toLowerCase();
  const typing = isTypingTarget(event);

  // Escape closes the palette drawer, the one transient overlay in the quiz.
  if (key === 'Escape' && isPaletteOpen()) { event.preventDefault(); closePalette(); return; }

  // F toggles a review flag, anywhere.
  if (lower === 'f' && !typing) {
    event.preventDefault();
    toggleFlag();
    return;
  }

  // Arrow keys navigate.
  if (key === 'ArrowLeft') { event.preventDefault(); goPrev(); return; }
  if (key === 'ArrowRight') { event.preventDefault(); goNext(); return; }

  // Phase 8.5 — with the confirm step gone, Enter advances (or opens the submit
  // dialog on the last question). It never commits a half-written text answer.
  if (key === 'Enter' && !(typing && (event.target.tagName === 'TEXTAREA'))) {
    event.preventDefault();
    goNext();
    return;
  }

  if (typing) return;

  // A/B/C/D select an MCQ option (which then auto-advances after the beat).
  if (type === 'MCQ') {
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

/**
 * Phase 8.6 — opens the smart submit dialog.
 *
 * The dialog adapts to the state of the paper instead of asking a blind
 * "are you sure?":
 *   - Complete  → a clean confirmation ("Xem lại" / "Xác nhận nộp").
 *   - Incomplete → names how many are outstanding, lists their numbers, and
 *     offers "Tiếp tục làm bài", which jumps STRAIGHT to the first (smallest)
 *     unanswered question rather than just closing and leaving the student to
 *     hunt for it in the palette.
 *
 * No worker/RPC change is involved: the decision is derived entirely from
 * `state.questions` + `state.answers` on the client.
 */
function openSubmitConfirm() {
  if (state.submitting) return;
  const practice = state.mode === 'practice';
  if (state.mode !== 'quiz' && !practice) return;

  const unanswered = getUnansweredQuestions(state.questions, state.answers);
  const list = $('submitModalUnansweredList');
  const continueBtn = $('btnModalContinueExam');
  const title = $('submitModalTitle');
  const desc = $('submitModalDesc');

  // Rebound on every open: the two modes have different "continue" semantics,
  // and a stale closure would fire the wrong one on the second open.
  if (unanswered.length === 0) {
    title.textContent = practice ? 'Hoàn thành bài ôn tập! 🎉' : 'Hoàn thành bài thi! 🎉';
    desc.textContent = practice
      ? 'Bạn đã trả lời đầy đủ tất cả câu hỏi. Hệ thống sẽ chấm điểm và hiện đáp án ngay.'
      : 'Bạn đã trả lời đầy đủ tất cả câu hỏi. Bạn có chắc chắn muốn nộp bài?';
    clear(list);
    list.style.display = 'none';
    continueBtn.textContent = 'Xem lại';
    continueBtn.onclick = closeSubmitConfirm;
  } else {
    title.textContent = 'Chưa hoàn thành bài thi ⚠️';
    desc.textContent = `Bạn còn ${unanswered.length} câu chưa trả lời:`;
    clear(list);
    unanswered.forEach((item) => {
      list.appendChild(el('span', { className: 'unanswered-tag', text: `Câu ${item.ordinal}` }));
    });
    list.style.display = 'flex';
    continueBtn.textContent = 'Tiếp tục làm bài';
    // `unanswered[0]` is the smallest index because getUnansweredQuestions()
    // returns them in paper order.
    continueBtn.onclick = () => { closeSubmitConfirm(); goToQuestion(unanswered[0].index); };
  }

  show($('submitModal'));
}

function closeSubmitConfirm() { hide($('submitModal')); }

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
  cancelAutoAdvance();
  closePalette();
  hide($('examHeader'));
  hide($('progressWrap'));
  hide($('quizScreen'));
  hide($('fullscreenOverlay'));
  hide($('submitModal'));
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
    // Phase 8.9 — populate the class picker the first time this tab opens.
    void loadPracticeClasses();
    // Phase 8.10 — a `?practice_code=` / `?code=` link pre-fills the practice
    // code and verifies it as soon as this tab is actually shown.
    applyPracticeCodeFromUrl();
  }
}

/**
 * Phase 8.10 — pre-fills the practice exam code from the URL and verifies it.
 *
 * Read on the FIRST practice-tab activation rather than in `boot()`, because the
 * panel is hidden by default: verifying a code the student cannot see would fire
 * an RPC for a screen they have not opened. `?code=` is shared with the official
 * form (see `prefillFromUrl`); `?practice_code=` is its unambiguous twin for a
 * link that must land in practice mode.
 */
function applyPracticeCodeFromUrl() {
  if (state.practiceUrlPrefilled) return;

  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('practice_code') || params.get('code');
  if (!codeParam) return;

  const input = $('practice-exam-code');
  if (!input) return;

  const code = codeParam.trim().toUpperCase().slice(0, 20);
  if (!code) return;

  state.practiceUrlPrefilled = true;
  input.value = code;
  void loadPracticeRoster(code);
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
  // Phase 8.10 — the disabled state belongs to the by-code source alone; the
  // .docx source must stay startable even when the typed code is unusable.
  updatePracticeStartState();
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
 * Phase 8.1 / 8.10 — verifies a practice exam code and renders its identity.
 *
 * `p_for_practice: true` is what makes this work on a CLOSED exam: the
 * official-exam scheduling gates are skipped for practice (migration
 * 20261005140000), so a student can self-practise after the sitting has ended.
 *
 * Phase 8.10 — the result is now REVEALED instead of swallowed. A failure is a
 * real answer the student needs ("chưa mở cho tự luyện tập" vs "không tồn
 * tại"), and the success path confirms the paper before they commit. The
 * submit path still re-checks server-side, so this banner is an affordance,
 * never the gate.
 */
async function loadPracticeRoster(examCode) {
  const code = String(examCode || '').trim().toUpperCase();
  const requestId = ++state.practiceRosterRequestId;
  state.practiceRoster = null;
  state.practiceVerifiedCode = code;
  state.practiceCodeStatus = null;
  clearPracticeDatalists();

  if (!code) {
    clearPracticeBanner();
    updatePracticeStartState();
    return;
  }

  const result = await callRpc('get_exam_roster', { p_exam_code: code, p_for_practice: true });
  // A slower earlier request must not overwrite a newer one's verdict.
  if (requestId !== state.practiceRosterRequestId) return;

  if (!result.ok) {
    state.practiceCodeStatus = 'error';
    renderPracticeBannerError('Không tải được đề', 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    updatePracticeStartState();
    return;
  }

  const payload = result.data || {};
  if (payload.success !== true) {
    state.practiceCodeStatus = 'error';
    renderPracticeBannerError(
      'Không thể mở đề này',
      // The RPC's own message is authoritative here (it is the wording the spec
      // asks for); the local map only backstops a code that arrives without one.
      payload.message || rpcMessage(payload.code),
    );
    updatePracticeStartState();
    return;
  }

  state.practiceCodeStatus = 'ok';
  renderPracticeBanner(payload);

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  state.practiceRoster = candidates;
  fillPracticeDatalists(candidates);
  updatePracticeStartState();
}

/**
 * Phase 8.10 — renders the practice identity banner from a successful roster
 * payload: the exam title plus the "Cho phép tự luyện" confirmation.
 */
function renderPracticeBanner(payload) {
  const banner = $('practiceMetaBanner');
  const titleNode = $('practiceMetaTitle');
  const statusNode = $('practiceMetaStatus');
  if (!banner || !titleNode || !statusNode) return;

  const title = String(payload.title || '').trim();
  titleNode.textContent = title ? `📚 ${title}` : '📚 Đề luyện tập';
  statusNode.textContent = 'Cho phép tự luyện';
  banner.classList.remove('is-error');
  banner.classList.add('is-success');
  show(banner);
}

/** Phase 8.10 — renders the practice banner in its refusal/error state. */
function renderPracticeBannerError(title, message) {
  const banner = $('practiceMetaBanner');
  const titleNode = $('practiceMetaTitle');
  const statusNode = $('practiceMetaStatus');
  if (!banner || !titleNode || !statusNode) return;

  titleNode.textContent = title;
  statusNode.textContent = message;
  banner.classList.remove('is-success');
  banner.classList.add('is-error');
  show(banner);
}

/** Phase 8.10 — hides the practice banner (blank code, or a source switch). */
function clearPracticeBanner() {
  const banner = $('practiceMetaBanner');
  if (banner) {
    hide(banner);
    banner.classList.remove('is-success', 'is-error');
  }
}

/**
 * Phase 8.10 — reflects the by-code verification verdict on the shared submit
 * button.
 *
 * The button is shared with the personal-.docx source, so it may only be
 * disabled while the BY-CODE source is selected: a code that is closed for
 * practice must never take the .docx flow down with it (Phase 8.9).
 */
function updatePracticeStartState() {
  const btn = $('practiceStartBtn');
  if (!btn) return;
  btn.disabled = state.practiceSource === 'code' && state.practiceCodeStatus === 'error';
}

/** Clears the practice suggestion lists. */
function clearPracticeDatalists() {
  const nameOptions = $('practiceStudentOptions');
  if (nameOptions) clear(nameOptions);
  renderPracticeClassOptions();
}

/**
 * Phase 8.9 — renders the class datalist from the public practice class list,
 * merged with any class names carried by a loaded practice roster.
 *
 * The public list is what makes the .docx flow usable: it only contains names
 * whose teacher left `allow_practice` on, so anything the student picks here is
 * guaranteed to pass `verify_student_practice`.
 */
function renderPracticeClassOptions() {
  const classOptions = $('practiceClassOptions');
  if (!classOptions) return;

  clear(classOptions);
  const seen = new Set();
  const add = (rawName) => {
    const value = String(rawName || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    classOptions.appendChild(el('option', { attrs: { value } }));
  };

  state.practiceClasses.forEach(add);
  if (Array.isArray(state.practiceRoster)) {
    state.practiceRoster.forEach((row) => add(row.class_name));
  }
}

/**
 * Phase 8.9 — fetches the class names that allow DOCX self-practice.
 *
 * Best-effort, like the roster fetch: a failure only means the student types
 * the class name manually, and the verification call still gates the upload.
 * `practiceClassesLoaded` latches success so the RPC runs once per page load
 * (a failed attempt stays unlatched and is retried on the next tab switch).
 */
async function loadPracticeClasses() {
  if (state.practiceClassesLoaded) return;
  const result = await callRpc('get_public_practice_classes', {});
  if (!result.ok || result.data?.success !== true) return;
  state.practiceClasses = Array.isArray(result.data.classes) ? result.data.classes : [];
  state.practiceClassesLoaded = true;
  renderPracticeClassOptions();
}

/**
 * Fills the practice NAME datalist from a roster.
 *
 * The name list holds EVERY candidate (not just one class's): the class and name
 * inputs are independent text fields, so filtering names by the current class
 * would require re-rendering on every keystroke for little benefit — the browser
 * narrows the suggestions as the student types.
 */
function fillPracticeDatalists(candidates) {
  const nameOptions = $('practiceStudentOptions');
  if (!nameOptions) return;

  clear(nameOptions);
  candidates.forEach((candidate) => {
    if (candidate.full_name) {
      nameOptions.appendChild(el('option', { attrs: { value: candidate.full_name } }));
    }
  });
  // The roster may name a class the public list omits (e.g. a practice-enabled
  // exam from a class whose .docx permission is off), so merge it in.
  renderPracticeClassOptions();
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
  const wantClass = normalizeText(className);
  const wantName = normalizeText(fullName);
  return roster.find(
    (row) => normalizeText(row.class_name) === wantClass
      && normalizeText(row.full_name) === wantName,
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
    // Phase 8.10 — re-enabling is delegated so a known-bad code keeps the button
    // disabled instead of the blanket re-enable this used to do.
    updatePracticeStartState();
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
  // Phase 8.9 — the .docx path is gated on the CLASS roster now. The RPC checks
  // that the class exists, that its teacher left `allow_practice` on, and that
  // the student is one of its members — so a personal file can only be parsed
  // for a student a teacher actually admitted. It normalizes Vietnamese text
  // server-side, hence the NFC pass here (the client's half of the contract).
  const auth = await callRpc('verify_student_practice', {
    p_class_name: normalizeText(state.className),
    p_full_name: normalizeText(state.fullName),
    p_student_code: state.studentCode || null,
  });
  if (!auth.ok) {
    practiceError('Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    return;
  }
  if (auth.data?.success !== true) {
    practiceError(rpcMessage(
      auth.data?.code,
      auth.data?.message || 'Thông tin học sinh không có trong danh sách được phép ôn luyện.',
    ));
    // Reset the picker so the student can immediately retry with the right file.
    fileInput.value = '';
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
  // Prefer the roster row's canonical spelling; fall back to what was typed.
  state.fullName = auth.data?.full_name || state.fullName;
  state.studentCode = auth.data?.student_code || state.studentCode || '';
  state.examCode = '';
  state.practiceQuestions = payload.questions;
  enterPractice(file.name.replace(/\.docx$/i, ''));
}

/**
 * POSTs the .docx to the public practice endpoint (forced mode=rule).
 *
 * Phase 8.1 — the endpoint is built from `workerBaseUrl()` rather than
 * being used as a relative path: this SPA is served as static assets, so a
 * relative `/api/...` request would hit the Pages host (405/404) instead of the
 * Worker that actually parses the file.
 */
async function extractPracticeDocx(file) {
  const workerBase = workerBaseUrl();
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
  //
  // Phase 8.7 — `partitionAndShuffleQuestions` groups every TRUE_FALSE item at
  // the END of the paper, so self-practice matches the official sitting's shape.
  state.displayOrder = null;
  state.questions = partitionAndShuffleQuestions(state.practiceQuestions, shouldShuffle);
  state.answers = state.questions.map(makeEmptyAnswer);
  state.currentIndex = 0;
  state.flashIndex = null;
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
  const timerBadge = $('exam-timer-badge');
  if (timerBadge) timerBadge.classList.remove('is-critical');
  cancelAutoAdvance();

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
    if (result.data.security_config) state.securityConfig = result.data.security_config;
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
 *
 * `change` (not `input`) on the exam code: the roster RPC should fire once the
 * student finishes typing, not on every keystroke. The listener re-runs
 * `loadExamRoster` for ANY edit, which is also what clears a stale roster.
 *
 * Phase 8.8 — `#btnVerifyExamCode` gives the same lookup an explicit trigger, so
 * a student who typed the code without blurring the field (common on mobile,
 * where the keyboard can stay open) can still pull the roster and see the exam
 * banner. Both paths call the same loader.
 */
function bindRosterControls() {
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
    // Phase 9.1 — anchor on the start (`started_at`), not on creation: a session
    // that waited in the lobby must not already look stale at kickoff.
    createdAt: session.startedAt || session.createdAt,
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

/**
 * Toggles between the tree's mutually exclusive states.
 *
 * Phase 9.1 — four states now: `lobby` (waiting room), `spectator` (the teacher
 * marked this student absent), `checkin` (pick your name) and `workspace` (the
 * live canvas). Everything is hidden first so a transition can never leave two
 * cards stacked.
 */
function setTreeView(view) {
  const panels = {
    spectator: $('treeSpectatorCard'),
    lobby: $('treeLobbyCard'),
    checkin: $('treeCheckinForm'),
    workspace: $('treeWorkspace'),
  };
  Object.entries(panels).forEach(([name, node]) => {
    if (!node) return;
    if (name === view) show(node);
    else hide(node);
  });
}

/**
 * Phase 9.1 — the waiting room shown while the session is still in `LOBBY`.
 *
 * The student's Tổ is already known (the RPC resolves it from
 * `participant_config.assignments`), so the card can name it outright. Falls
 * back to a neutral line when the RPC returned no team (a walk-in code that is
 * not on the roster).
 */
function renderTreeLobby() {
  setTreeView('lobby');
  const session = state.treeSession;
  if (!session) return;

  $('treeLobbyTitle').textContent = session.title || 'Cây Tri Thức';
  $('treeLobbyTeam').textContent = state.studentTeam
    ? `🌱 Bạn thuộc Cây ${state.studentTeam}. Hãy nhìn lên máy chiếu, trận đấu sẽ bắt đầu khi thầy/cô bấm nút!`
    : '🌱 Đã vào phòng! Hãy nhìn lên máy chiếu, trận đấu sẽ bắt đầu khi thầy/cô bấm nút!';
  $('treeLobbyHint').textContent =
    `${session.className || ''} · ${session.gameMode === 'SPEED_QUIZ' ? 'Đua tốc độ' : 'Bão não từ khóa'}`
    + ` · Thời gian ${session.timeLimitMinutes} phút`;
}

/**
 * Phase 9.1 — the spectator notice for a student the teacher marked absent.
 *
 * Deliberately NOT an error: they are still in the room, they simply cannot
 * answer. The tree stays visible only if they later check in, which the absent
 * flag forbids, so this card is terminal for the session.
 */
function renderTreeSpectator() {
  setTreeView('spectator');
  const session = state.treeSession;
  $('treeSpectatorTitle').textContent = `👁️ ${session ? session.title : 'Chế độ quan sát'}`;
  $('treeSpectatorMeta').textContent = session
    ? `${session.className || ''} · Bạn đã được đánh dấu vắng mặt ở hoạt động này.`
    : '';
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
  // Phase 7.4 / 9.1 — `?tree=` carries the uuid or projector PIN; `?session=` for older links.
  // Note: `?code=` is reserved for exam taking (prefillFromUrl), so Tree sessions must NOT read `?code=`.
  const sessionId = params.get('tree') || params.get('session') || params.get('tree_code');
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
 *
 * Phase 9.1 — the loader accepts either the session uuid (legacy links) or the
 * short `session_code` (the projector QR/PIN), so `isUuid` is no longer a
 * precondition: the RPC resolves both. The caller's `student_code` (recovered
 * from the stored exam session) rides along so the RPC can resolve their Tổ and
 * the absent flag, which drives the spectator/lobby branches below.
 */
async function loadTreeActivity(sessionRef) {
  // Phase 8.1 — isolate the tree view BEFORE anything else. The error states
  // below must also render inside the tree view, so switching first means a bad
  // link shows the message there rather than leaving the exam form on screen.
  switchView('tree');

  // A URL is never trusted. The RPC takes a varchar, so the only thing worth
  // rejecting locally is an empty/garbage token the server would merely 404 on.
  const ref = String(sessionRef || '').trim();
  if (!ref) {
    showTreeError('Liên kết tham gia không hợp lệ.');
    return;
  }

  show($('treeScreen'));
  setTreeView('checkin');
  treeCheckinError('');
  $('treeCheckinTitle').textContent = 'Đang tải hoạt động…';
  $('treeCheckinQuestion').textContent = '';
  $('treeCheckinMeta').textContent = '';

  const result = await callRpc('get_public_tree_session', {
    p_session_code: ref,
    p_student_code: state.studentCode || null,
  });

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
    // Phase 9.1 — vitality is measured from the bout's START, falling back to
    // creation for a legacy session that never went through the lobby.
    startedAt: session.started_at || session.created_at,
    className: payload.class_name || '',
    totalStudents: Math.max(Number(payload.total_students) || 0, 1),
    // Phase 9.1 — lobby/game-mode metadata and the resolved identity.
    sessionCode: session.session_code || '',
    gameMode: session.game_mode === 'SPEED_QUIZ' ? 'SPEED_QUIZ' : 'BRAINSTORM',
    targetScore: Number(session.target_score) || 20,
    timeRemainingSeconds: Number(session.time_remaining_seconds) || 0,
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
  state.treeChampionTeam = null;
  // Phase 9.1 — lifecycle + identity resolution. `team_number` is null when the
  // caller is absent, so fall back to 1 rather than letting `clampTeamNumber`
  // (which is also a null-safe 1) hide a genuine absence.
  state.treeSessionId = session.id || null;
  state.treeStatus = session.status === 'LOBBY' ? 'LOBBY' : 'ACTIVE';
  state.treeGameMode = state.treeSession.gameMode;
  state.treeIsAbsent = session.is_absent === true;
  state.studentTeam = clampTeamNumber(session.team_number);
  if (session.student_name && state.studentCode) {
    state.treeIdentity = { student_code: state.studentCode, full_name: session.student_name };
  }

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
  await loadTreeSubmissions(session.id);
  subscribeTreeChannel(session.id);
  // Phase 9.1 — a SECOND subscription on the session row itself: the waiting
  // room must flip to the arena the moment the teacher starts the bout.
  subscribeTreeSessionChannel(session.id);

  // Re-render even while still on the check-in card: it is behind the card, but
  // showing it means entering the workspace needs no second fetch.
  showTree(state.treeSession, state.treeSubmissions, true);

  // Phase 9.1 — an absent student never sees the check-in form; a session still
  // in the lobby shows the waiting room. The identity (when already known) skips
  // the name picker entirely and lands straight on the correct card.
  if (state.treeIsAbsent) {
    renderTreeSpectator();
    return;
  }
  if (state.treeIdentity) {
    if (state.treeStatus === 'LOBBY') renderTreeLobby();
    else finishTreeWorkspace();
    return;
  }
  setTreeView('checkin');
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
  if (state.treeSessionChannel && state.supabase) {
    state.supabase.removeChannel(state.treeSessionChannel);
  }
  state.treeSessionChannel = null;
}

/**
 * Phase 9.1 — subscribes to the session ROW itself.
 *
 * The waiting room is a passive screen: its ONLY exit condition is the teacher
 * pressing "BẮT ĐẦU THI ĐẤU", which arrives as an UPDATE on `tree_sessions`.
 * Filtering by `id=eq.` (a primary key) needs no extra replica identity, and the
 * row is re-checked client-side anyway so a stale channel from a previous
 * session can never promote this one.
 */
function subscribeTreeSessionChannel(sessionId) {
  if (state.treeSessionChannel && state.supabase) {
    state.supabase.removeChannel(state.treeSessionChannel);
  }
  state.treeSessionChannel = state.supabase
    .channel(`tree-session-${sessionId}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'tree_sessions',
      filter: `id=eq.${sessionId}`,
    }, handleRealtimeSessionUpdate)
    .subscribe();
}

/** Promotes a waiting-room student to the arena once the teacher starts. */
function handleRealtimeSessionUpdate(payload) {
  const row = payload.new;
  if (!row || row.id !== state.treeSessionId) return;
  // Absent students stay on the spectator card; the start changes nothing for
  // them, and switching would wrongly show them an input they cannot submit.
  if (state.treeIsAbsent) return;
  if (state.treeStatus === 'ACTIVE') return;

  state.treeStatus = row.status === 'ACTIVE' ? 'ACTIVE' : state.treeStatus;
  if (state.treeStatus !== 'ACTIVE') return;

  if (state.treeSession) {
    state.treeSession.timeRemainingSeconds =
      Number(row.time_remaining_seconds) || state.treeSession.timeRemainingSeconds;
  }
  // A student still on the name picker stays there (they have not checked in);
  // only a student already in the waiting room is promoted automatically.
  if (state.treeIdentity) finishTreeWorkspace();
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

/**
 * Check-in: pick a name, then enter the workspace (or the waiting room).
 *
 * Phase 9.1 — if the session is still in `LOBBY` the student is parked on the
 * waiting card rather than dropped into an arena they cannot submit to; the
 * Realtime UPDATE on `tree_sessions` promotes them when the teacher starts.
 */
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

  if (state.treeStatus === 'LOBBY') {
    renderTreeLobby();
    return;
  }
  finishTreeWorkspace();
}

/**
 * Phase 9.1 — everything that happens ONCE a checked-in student enters the
 * live arena; split out of `enterTreeWorkspace` so the Realtime lobby→ACTIVE
 * promotion can reuse it verbatim (a waiting-room student has no way to
 * re-submit the check-in form).
 */
function finishTreeWorkspace() {
  const session = state.treeSession;
  if (!session) return;
  setTreeView('workspace');

  // The canvas was hidden until now, so its CSS box had no size. Re-render AFTER
  // the workspace is visible so `resize()` reads a real clientHeight.
  renderTree(session, state.treeSubmissions, true);
  applyTreeModePresentation();

  const reminder = $('treeQuestionReminder');
  if (reminder) reminder.textContent = session.questionText;

  // Mark the student's own fruit once it exists (they may be re-joining).
  const identity = state.treeIdentity;
  const mine = identity
    ? state.treeSubmissions.find((row) => row.student_code === identity.student_code)
    : null;
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
 * Phase 9.1 — paints the mode-specific chrome of the arena.
 *
 * BRAINSTORM keeps the free-text answer box and shows the discussion prompt as
 * its label. SPEED_QUIZ promotes the prompt into a prominent `#treeQuizPrompt`
 * card (the student's eyes should be on the question, not on the label above a
 * textarea) and labels the input as the short answer field. The countdown badge
 * is started for both, anchored on the RPC's `time_remaining_seconds`.
 */
function applyTreeModePresentation() {
  const session = state.treeSession;
  if (!session) return;

  const isQuiz = session.gameMode === 'SPEED_QUIZ';
  const prompt = $('treeQuizPrompt');
  const reminder = $('treeQuestionReminder');

  if (prompt) {
    prompt.textContent = isQuiz ? session.questionText : '';
    if (isQuiz && session.questionText) show(prompt);
    else hide(prompt);
  }
  if (reminder) {
    reminder.textContent = isQuiz
      ? 'Trả lời ngắn gọn, nhanh và chính xác:'
      : session.questionText;
  }

  // Phase 9.3 — the target score is a SPEED_QUIZ-only concept; a BRAINSTORM bout
  // is won by every present member answering once, so the badge states only the
  // mode rather than surfacing a derived number the student cannot act on.
  const modeBadge = $('treeModeBadge');
  if (modeBadge) modeBadge.textContent = isQuiz
    ? `⚡ Đua tốc độ · Mục tiêu ${session.targetScore} điểm`
    : '💡 Bão não từ khóa';

  const input = $('treeAnswerInput');
  if (input) {
    input.placeholder = isQuiz
      ? 'Nhập đáp án ngắn của bạn...'
      : 'Nhập suy nghĩ hoặc câu trả lời của bạn...';
  }

  startTreeCountdown(session.timeRemainingSeconds);
}

/**
 * Phase 9.1 — local countdown, anchored on the server's `time_remaining_seconds`.
 *
 * A client-side tick is only a DISPLAY; the authoritative cutoff is `ends_at` in
 * `submit_tree_answer`, so a tampered clock cannot extend the bout. Interval is
 * cleared on every re-entry so two sessions can never leave two timers running.
 */
function startTreeCountdown(seconds) {
  stopTreeCountdown();
  if (!(Number(seconds) > 0)) {
    const badge = $('treeTimeBadge');
    if (badge) badge.textContent = '';
    return;
  }

  state.treeRemainingSeconds = Number(seconds);
  paintTreeCountdown();
  state.treeCountdownTimer = window.setInterval(() => {
    state.treeRemainingSeconds = Math.max(0, state.treeRemainingSeconds - 1);
    paintTreeCountdown();
    if (state.treeRemainingSeconds === 0) stopTreeCountdown();
  }, 1000);
}

function stopTreeCountdown() {
  if (state.treeCountdownTimer) {
    window.clearInterval(state.treeCountdownTimer);
    state.treeCountdownTimer = null;
  }
}

function paintTreeCountdown() {
  const badge = $('treeTimeBadge');
  if (!badge) return;
  const total = Math.max(0, Number(state.treeRemainingSeconds) || 0);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  badge.textContent = `⏳ ${minutes}:${String(secs).padStart(2, '0')}`;
  badge.classList.toggle('is-urgent', total <= 60);
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
    } else if (payload.code === 'NOT_STARTED') {
      // Phase 9.1 — the teacher reverted to the lobby (or this student raced the
      // start). Park them on the waiting card rather than leaving them on an
      // arena that would refuse every further attempt.
      state.treeStatus = 'LOBBY';
      renderTreeLobby();
      return;
    } else if (payload.code === 'STUDENT_ABSENT') {
      // Phase 9.1 — marked absent mid-session: switch to the spectator card, the
      // terminal state for this student.
      state.treeIsAbsent = true;
      renderTreeSpectator();
      return;
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
  initFontSize();

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
  // Phase 8.10 — verify the practice exam code, mirroring #loginForm's
  // "Kiểm tra đề". Four triggers (change / explicit button / Enter / blur) all
  // funnel into the same loader, so a mobile keyboard that never closes can
  // still be resolved by tapping the button.
  const practiceCodeInput = $('practice-exam-code');
  practiceCodeInput.addEventListener('change', (event) => {
    void loadPracticeRoster(event.target.value);
  });
  const verifyPracticeBtn = $('btnVerifyPracticeCode');
  if (verifyPracticeBtn) {
    verifyPracticeBtn.addEventListener('click', () => {
      void loadPracticeRoster(practiceCodeInput.value);
    });
  }
  practiceCodeInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // The field lives inside #practiceForm: without this, Enter would submit the
    // form and start practice instead of merely verifying the code.
    event.preventDefault();
    void loadPracticeRoster(practiceCodeInput.value);
  });
  practiceCodeInput.addEventListener('blur', () => {
    // Clicking "Bắt đầu ôn luyện" blurs this field, and re-verifying then would
    // race the submit: the loader clears `state.practiceRoster` before its await,
    // so `handlePracticeSubmit` would lose the canonical student code. An
    // unchanged code has no new verdict to fetch, so skip it.
    const current = practiceCodeInput.value.trim().toUpperCase();
    if (current && current === state.practiceVerifiedCode && state.practiceCodeStatus) return;
    void loadPracticeRoster(practiceCodeInput.value);
  });
  // Any edit invalidates the previous verdict, so the banner must not keep
  // claiming a code the student has since changed.
  practiceCodeInput.addEventListener('input', () => {
    state.practiceCodeStatus = null;
    state.practiceVerifiedCode = '';
    clearPracticeBanner();
    updatePracticeStartState();
  });

  // Phase 8.5 — exam navigation controls.
  $('btn-open-palette').addEventListener('click', openPalette);
  $('btn-close-palette').addEventListener('click', closePalette);
  $('palette-backdrop').addEventListener('click', closePalette);
  $('btn-theme-toggle').addEventListener('click', toggleTheme);
  // Phase 8.6 — the same theme cycle is reachable from the login/roster screen.
  $('btn-global-theme-toggle').addEventListener('click', toggleTheme);
  $('btn-font-toggle').addEventListener('click', cycleFontSize);
  $('btn-prev-question').addEventListener('click', goPrev);
  $('btn-next-question').addEventListener('click', goNext);
  $('btn-flag-question').addEventListener('click', toggleFlag);
  $('btn-finish-exam').addEventListener('click', openSubmitConfirm);
  // The auto-advance checkbox reflects the stored preference, then persists it.
  const autoAdvanceBox = $('chk-auto-advance');
  autoAdvanceBox.checked = autoAdvanceEnabled;
  autoAdvanceBox.addEventListener('change', (event) => {
    setAutoAdvancePreference(event.target.checked);
  });

  $('fsResumeBtn').addEventListener('click', () => { requestFullscreen(); hide($('fullscreenOverlay')); });
  $('evictedBtn').addEventListener('click', () => window.location.reload());
  const btnResumeBlur = $('btnResumeSecurityBlur');
  if (btnResumeBlur) {
    btnResumeBlur.addEventListener('click', () => {
      document.body.classList.remove('security-blur');
    });
  }
  const blurOverlay = $('securityBlurOverlay');
  if (blurOverlay) {
    blurOverlay.addEventListener('click', () => {
      if (!document.hidden && document.hasFocus()) {
        document.body.classList.remove('security-blur');
      }
    });
  }
  // Phase 8.6 — smart submit modal. "Tiếp tục làm bài" carries a per-open click
  // handler installed by openSubmitConfirm(), so nothing is bound to it here.
  $('btnModalConfirmSubmit').addEventListener('click', () => {
    closeSubmitConfirm();
    if (state.mode === 'practice') submitPractice();
    else submitExam(false);
  });
  $('certBtn').addEventListener('click', openCertificate);
  $('certCloseBtn').addEventListener('click', closeCertificate);
  $('certPrintBtn').addEventListener('click', () => window.print());
  document.addEventListener('keydown', onKeyDown);

  // Phase 7.4 — an explicit tree link wins over both the login form and a
  // resumable exam: opening `?tree=` / `?session=` IS the student's intent, and
  // resuming would immediately hide the tree screen. The stored exam session is
  // left untouched, so dropping the query string resumes it.
  if (loadTreeFromUrl()) return;

  const resumed = await tryResumeSession();
  if (!resumed) {
    show($('loginScreen'));
    const params = new URLSearchParams(window.location.search);
    const hasExamCode = Boolean(params.get('code') || params.get('c'));
    if (hasExamCode) {
      selectModeTab('official');
      prefillFromUrl();
    } else {
      selectModeTab('practice');
    }
  }
}

boot();
