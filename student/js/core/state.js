/**
 * ADQS Exam v2 — Student SPA Core State & Primitives
 * =====================================================================
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveSupabaseConfig, resolveWorkerBaseUrl } from '../../app-config.js';

/* =====================================================================
   Constants
   ===================================================================== */

export const STORAGE_KEY = 'adqs_student_session_v2';
export const HEARTBEAT_MS = 20_000;
export const RING_CIRCUMFERENCE = 540;          // 2 * PI * r(86)
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_DEVICE_INFO = 200;
export const CERT_PASS_PERCENT = 80;            // must match schema: score/total >= 0.8
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Phase 8.1 — base URL of the Cloudflare Worker that parses a personal .docx.
 */
export function workerBaseUrl() {
  return resolveWorkerBaseUrl(window.__APP_CONFIG__);
}

/** Server RPC result codes -> Vietnamese copy shown to the student. */
export const RPC_MESSAGES = {
  EXAM_NOT_FOUND: 'Không tìm thấy mã đề thi này. Vui lòng kiểm tra lại.',
  EXAM_INACTIVE: 'Đề thi này đang đóng. Vui lòng liên hệ giáo viên.',
  EXAM_NOT_STARTED: 'Đề thi chưa đến giờ mở. Vui lòng chờ đến thời gian bắt đầu.',
  EXAM_EXPIRED: 'Đề thi đã hết thời gian mở. Vui lòng liên hệ giáo viên.',
  STUDENT_NOT_WHITELISTED: 'Mã học sinh không có trong danh sách dự thi của đề này.',
  IDENTITY_MISMATCH: 'Họ tên hoặc lớp không khớp với danh sách dự thi.',
  INVALID_PIN: 'Mã PIN hoặc ngày sinh không đúng. Vui lòng thử lại!',
  ALREADY_SUBMITTED: 'Bạn đã nộp bài cho đề thi này rồi.',
  EXAM_ALREADY_SUBMITTED: 'Bạn đã hoàn thành bài thi này rồi.',
  EXAM_TIME_EXPIRED: 'Thời gian làm bài thi của bạn đã kết thúc.',
  SESSION_ACTIVE_ELSEWHERE: 'Tài khoản của bạn đang được đăng nhập trên một thiết bị khác.',
  INVALID_SESSION: 'Phiên làm bài không còn hợp lệ.',
  SESSION_EXPIRED: 'Phiên làm bài đã hết hạn do không hoạt động.',
  PRACTICE_NOT_ALLOWED: 'Giáo viên chưa mở đề này cho chế độ luyện tập.',
  PRACTICE_EMPTY: 'Đề này chưa có câu hỏi nào để luyện tập.',
  CLASS_NOT_FOUND: 'Lớp học không tồn tại trên hệ thống. Vui lòng kiểm tra lại tên lớp!',
  CLASS_PRACTICE_DISABLED: 'Lớp của bạn hiện đang tạm khóa quyền tự luyện tập. Vui lòng liên hệ giáo viên!',
  STUDENT_NOT_FOUND: 'Thông tin học sinh không có trong danh sách của lớp này.',
  SESSION_NOT_FOUND: 'Phiên hoạt động không tồn tại hoặc đã bị xoá.',
  SESSION_INACTIVE: 'Phiên hoạt động đã kết thúc. Cảm ơn bạn đã tham gia!',
  IDENTITY_REQUIRED: 'Vui lòng chọn tên của bạn trước khi gửi.',
  MIN_WORDS_NOT_MET: 'Câu trả lời chưa đủ số từ tối thiểu.',
  NOT_STARTED: 'Trận đấu chưa bắt đầu. Vui lòng chờ giáo viên!',
  STUDENT_ABSENT: 'Bạn đã được đánh dấu vắng mặt ở hoạt động này.',
};

/* =====================================================================
   Tiny DOM helpers
   ===================================================================== */

export const $ = (id) => document.getElementById(id);

/** Create an element; `text` is always applied via textContent (XSS-safe). */
export function el(tag, { className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v != null) node.setAttribute(k, String(v)); }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
export function show(node) { node.classList.remove('hidden'); }
export function hide(node) { node.classList.add('hidden'); }

/* =====================================================================
   Application state
   ===================================================================== */

export const state = {
  supabase: null,
  mode: 'login',            // login | quiz | result | evicted | practice
  // identity
  examCode: '',
  studentCode: '',
  fullName: '',
  className: '',
  sessionToken: null,
  pin: null,
  // exam
  exam: null,
  questions: [],
  answers: [],              // per-question draft (the answer itself)
  flags: new Set(),
  currentIndex: 0,
  flashIndex: null,
  // timing
  durationSeconds: 0,
  startedAt: null,
  endsAt: null,
  timerHandle: null,
  isViewingImage: false,
  // telemetry
  blurCount: 0,
  fullscreenExitCount: 0,
  violationCount: 0,
  maxViolations: 3,
  examStatus: 'IDLE',
  // controls
  heartbeatHandle: null,
  submitting: false,
  antiCheatBound: false,
  securityConfig: null,
  lastBlurAt: 0,
  // certificate
  certificate: null,
  // practice mode
  practiceQuestions: [],
  practiceStartedAt: null,
  practiceSource: 'code',
  practiceShuffle: false,
  isPractice: false,
  displayOrder: null,
  roster: null,
  rosterPinMode: null,
  rosterRequestId: 0,
  practiceRoster: null,
  practiceRosterRequestId: 0,
  practiceClasses: [],
  practiceClassesLoaded: false,
  practiceCodeStatus: null,
  practiceVerifiedCode: '',
  practiceUrlPrefilled: false,
  // tree of knowledge
  treeRenderer: null,
  treeData: null,
  treeHighlightId: null,
  treeSession: null,
  treeSubmissions: [],
  treeMembers: [],
  treeIdentity: null,
  treeChannel: null,
  treeSubmitted: false,
  treeFlourished: false,
  treeStatus: 'ACTIVE',
  treeGameMode: 'BRAINSTORM',
  treeSessionId: null,
  treeIsAbsent: false,
  treeSessionChannel: null,
  treeRemainingSeconds: 0,
  treeCountdownTimer: null,
  studentTeam: 1,
  treeTeamCounts: null,
  treeChampionTeam: null,
};

/* =====================================================================
   Storage
   ===================================================================== */

export function readSession() {
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

export function writeSession() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      exam_code: state.examCode,
      student_code: state.studentCode,
      full_name: state.fullName,
      class_name: state.className,
      session_token: state.sessionToken,
      started_at: state.startedAt,
      ends_at: state.endsAt,
      saved_at: Date.now(),
      security_config: state.securityConfig,
      pin: state.pin,
    }));
  } catch { /* storage unavailable — the exam still works, reload recovery is lost */ }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/* =====================================================================
   UI primitives
   ===================================================================== */

let toastHandle = null;
export function toast(message) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  show(node);
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => hide(node), 4000);
}

export function busy(isBusy, message) {
  if (message && $('loadingText')) $('loadingText').textContent = message;
  const overlay = $('loadingOverlay');
  if (overlay) {
    if (isBusy) show(overlay); else hide(overlay);
  }
}

export function loginError(message) {
  const node = $('loginError');
  if (!node) return;
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

export function rpcMessage(code, fallback) {
  return RPC_MESSAGES[code] || fallback || 'Đã xảy ra lỗi. Vui lòng thử lại.';
}

/* =====================================================================
   Supabase client
   ===================================================================== */

export function initSupabase() {
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
export async function callRpc(name, args) {
  const { data, error } = await state.supabase.rpc(name, args);
  if (error) {
    console.error(`RPC ${name} failed`, error);
    return { ok: false, network: true, error };
  }
  return { ok: true, data };
}
