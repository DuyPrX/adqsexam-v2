/**
 * ADQS Exam v2 — Student SPA Self-Practice & DOCX Runner
 * =====================================================================
 * Self-practice DOCX upload, Cloudflare Worker extraction,
 * practice by exam code, practice grading & review modal.
 */

import {
  state, $, el, clear, show, hide, busy, loginError, rpcMessage,
  callRpc, workerBaseUrl, DOCX_MIME,
} from '../core/state.js';
import { normalizeText, normalizeType, TYPE_LABEL } from '../core/utils.js';
import { partitionAndShuffleQuestions, readShuffleToggle } from '../../practice-order.js';
import { bindAntiCheat } from './anti-cheat.js';
import {
  renderQuizShell, renderQuestion, makeEmptyAnswer, cancelAutoAdvance,
  closeSubmitConfirm, finishExam, renderResult,
} from './exam-runner.js';

/* =====================================================================
   Self-practice mode (Phase 5.2)
   ===================================================================== */

/** Maps the Worker's question shape onto the renderer's shape. */
export function normalizePracticeQuestions(rawList) {
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

export function practiceError(message) {
  const node = $('practiceError');
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

/** Switches the landing card between the official exam and practice forms. */
export function selectModeTab(mode) {
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
 */
export function applyPracticeCodeFromUrl() {
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
 */
export function selectPracticeSource(source) {
  const byCode = source === 'code';
  state.practiceSource = byCode ? 'code' : 'file';
  $('practiceSourceCodeBtn').classList.toggle('is-active', byCode);
  $('practiceSourceFileBtn').classList.toggle('is-active', !byCode);
  $('practiceSourceCodeBtn').setAttribute('aria-selected', String(byCode));
  $('practiceSourceFileBtn').setAttribute('aria-selected', String(!byCode));

  if (byCode) { show($('practiceCodeFields')); hide($('practiceFileFields')); }
  else { hide($('practiceCodeFields')); show($('practiceFileFields')); }
  practiceError('');
  updatePracticeStartState();
}

/**
 * Phase 5.8 — builds the practice question set from a teacher-enabled exam.
 */
export async function loadPracticeFromExamCode(examCode) {
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

  raw.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

  return {
    ok: true,
    title: payload.exam?.title || examCode,
    questions: normalizePracticeQuestions(raw),
    studentName: payload.student_name || '',
  };
}

/**
 * Phase 8.1 / 8.10 — verifies a practice exam code and renders its identity.
 */
export async function loadPracticeRoster(examCode) {
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
 * Phase 8.10 — renders the practice identity banner from a successful roster payload.
 */
export function renderPracticeBanner(payload) {
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

export function renderPracticeBannerError(title, message) {
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

export function clearPracticeBanner() {
  const banner = $('practiceMetaBanner');
  if (banner) {
    hide(banner);
    banner.classList.remove('is-success', 'is-error');
  }
}

export function updatePracticeStartState() {
  const btn = $('practiceStartBtn');
  if (!btn) return;
  btn.disabled = state.practiceSource === 'code' && state.practiceCodeStatus === 'error';
}

export function clearPracticeDatalists() {
  const nameOptions = $('practiceStudentOptions');
  if (nameOptions) clear(nameOptions);
  renderPracticeClassOptions();
}

export function renderPracticeClassOptions() {
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

export async function loadPracticeClasses() {
  if (state.practiceClassesLoaded) return;
  const result = await callRpc('get_public_practice_classes', {});
  if (!result.ok || result.data?.success !== true) return;
  state.practiceClasses = Array.isArray(result.data.classes) ? result.data.classes : [];
  state.practiceClassesLoaded = true;
  renderPracticeClassOptions();
}

export function fillPracticeDatalists(candidates) {
  const nameOptions = $('practiceStudentOptions');
  if (!nameOptions) return;

  clear(nameOptions);
  candidates.forEach((candidate) => {
    if (candidate.full_name) {
      nameOptions.appendChild(el('option', { attrs: { value: candidate.full_name } }));
    }
  });
  renderPracticeClassOptions();
}

export function matchPracticeCandidate(className, fullName) {
  const roster = state.practiceRoster;
  if (!Array.isArray(roster)) return null;
  const wantClass = normalizeText(className);
  const wantName = normalizeText(fullName);
  return roster.find(
    (row) => normalizeText(row.class_name) === wantClass
      && normalizeText(row.full_name) === wantName,
  ) || null;
}

export async function handlePracticeSubmit(event) {
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
    updatePracticeStartState();
  }
}

export async function startPracticeByCode() {
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

  if (loaded.studentName) state.fullName = loaded.studentName;
  state.examCode = examCode;
  state.practiceQuestions = loaded.questions;
  enterPractice(loaded.title);
}

export async function startPracticeByFile() {
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
  state.fullName = auth.data?.full_name || state.fullName;
  state.studentCode = auth.data?.student_code || state.studentCode || '';
  state.examCode = '';
  state.practiceQuestions = payload.questions;
  enterPractice(file.name.replace(/\.docx$/i, ''));
}

export async function extractPracticeDocx(file) {
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

export function enterPractice(title) {
  state.mode = 'practice';
  state.isPractice = true;
  const shouldShuffle = readShuffleToggle(document);
  state.practiceShuffle = shouldShuffle;
  state.displayOrder = null;
  state.questions = partitionAndShuffleQuestions(state.practiceQuestions, shouldShuffle);
  state.answers = state.questions.map(makeEmptyAnswer);
  state.currentIndex = 0;
  state.flashIndex = null;
  state.flags = new Set();
  state.blurCount = 0;
  state.fullscreenExitCount = 0;
  state.practiceStartedAt = Date.now();
  state.exam = { title };

  renderQuizShell();
  renderQuestion();

  $('timerDisplay').textContent = '∞';
  const timerBadge = $('exam-timer-badge');
  if (timerBadge) timerBadge.classList.remove('is-critical');
  cancelAutoAdvance();

  bindAntiCheat();

  hide($('loginScreen'));
  show($('examHeader'));
  show($('progressWrap'));
  hide($('resultScreen'));
  show($('quizScreen'));
}

export function practiceElapsedSeconds() {
  if (!state.practiceStartedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - state.practiceStartedAt) / 1000));
}

/* ---------------------------------------------------- practice grading */

export function letterFor(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : '?';
}

export function normalizeShort(text) {
  return String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
}

export function gradePracticeQuestion(question, answer) {
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

export function gradePractice() {
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

export function submitPractice() {
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

export function renderPracticeReview(review) {
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
