/**
 * ADQS Exam v2 — Student SPA Exam Runner & Scoring
 * =====================================================================
 * Question rendering, option selection, auto-advance,
 * image lightbox, review modal & exam submission.
 */

import {
  state, $, el, clear, show, hide, toast, busy, rpcMessage, callRpc, clearSession,
  RING_CIRCUMFERENCE, MAX_TEXT_LENGTH, CERT_PASS_PERCENT,
} from '../core/state.js';
import {
  normalizeType, TYPE_LABEL, TYPE_BADGE_CLASS, formatQuestionContent,
  shuffleOptionsDeterministically, isUuid,
} from '../core/utils.js';
import {
  AUTO_ADVANCE_MS, buildPaletteCells, clampQuestionIndex, getUnansweredQuestions,
  readAutoAdvancePreference, shouldAutoAdvance, writeAutoAdvancePreference,
} from '../../exam-nav.js';
import {
  stopTimer, startTimer, stopHeartbeat, startHeartbeat, elapsedSeconds,
  evictStudent, countAnswered,
} from './exam-session.js';
import { unbindAntiCheat, exitFullscreenIfNeeded } from './anti-cheat.js';
import { practiceElapsedSeconds, renderPracticeReview } from './practice-docx.js';

/* =====================================================================
   Empty answer slot factory
   ===================================================================== */

export function makeEmptyAnswer(question) {
  const type = normalizeType(question.type);
  if (type === 'TRUE_FALSE') {
    const count = Array.isArray(question.subQuestions) ? question.subQuestions.length : 4;
    return { draft: new Array(Math.max(1, count)).fill('') };
  }
  if (type === 'MCQ') return { draft: null };
  return { draft: '' };
}

/* =====================================================================
   Quiz shell (header + nav grid)
   ===================================================================== */

export function renderQuizShell() {
  $('examTitle').textContent = state.exam.title || 'Bài thi';
  // The drawer is toggled via the .is-open transform, not the `hidden` class —
  // closePalette() keeps those two mechanisms in sync.
  closePalette();
}

export function updateHeader() {
  const total = state.questions.length;
  $('qCounter').textContent = `Câu ${state.currentIndex + 1}/${total}`;
  const flagged = state.flags.size;
  const badge = $('metricFlags');
  if (flagged > 0) { badge.textContent = `⚑ ${flagged}`; show(badge); } else { hide(badge); }
  const percent = total ? ((state.currentIndex + 1) / total) * 100 : 0;
  $('progressBar').style.width = `${percent}%`;
}

/* =====================================================================
   Image lightbox modal
   ===================================================================== */

export function openImageLightbox(src, alt) {
  const modal = $('imageLightboxModal');
  const target = $('lightboxTargetImg');
  if (!modal || !target) return;
  target.src = src;
  target.alt = alt || 'Hình ảnh câu hỏi';
  state.isViewingImage = true;
  modal.style.display = 'flex';
}

export function closeImageLightbox() {
  const modal = $('imageLightboxModal');
  const target = $('lightboxTargetImg');
  if (modal) modal.style.display = 'none';
  if (target) target.src = '';
  state.isViewingImage = false;
}

/* =====================================================================
   Question rendering
   ===================================================================== */

export function renderQuestion() {
  const host = $('questionHost');
  clear(host);

  const question = state.questions[state.currentIndex];
  if (!question) return;

  const type = normalizeType(question.type);
  const answer = state.answers[state.currentIndex];
  updateHeader();

  host.appendChild(buildQuestionHead(question, type));

  const text = el('div', { className: 'q-text' });
  text.innerHTML = formatQuestionContent(question.content || '');
  host.appendChild(text);

  if (type === 'MCQ') host.appendChild(buildMcqOptions(question, answer));
  else if (type === 'TRUE_FALSE') host.appendChild(buildTrueFalse(question, answer));
  else if (type === 'ESSAY') host.appendChild(buildTextAnswer(question, answer, true));
  else host.appendChild(buildTextAnswer(question, answer, false));

  renderActionBar();
  renderPalette();
}

export function buildQuestionHead(question, type) {
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

export function buildMcqOptions(question, answer) {
  const list = el('div', { className: 'options', attrs: { role: 'radiogroup', 'aria-label': 'Phương án trả lời' } });
  const rawOptions = Array.isArray(question.options) ? question.options : [];

  let optionsList = rawOptions.map((opt, idx) => ({ originalIndex: idx, value: opt }));
  if (state.securityConfig?.shuffle_options !== false) {
    const qId = question.id || `q_${state.currentIndex}`;
    optionsList = shuffleOptionsDeterministically(rawOptions, state.studentCode || '', qId);
  }

  optionsList.forEach((item, displayIndex) => {
    const selected = answer.draft === item.originalIndex;
    const btn = el('button', {
      className: 'option',
      attrs: {
        type: 'button',
        role: 'radio',
        'aria-checked': String(selected),
      },
    });
    if (selected) btn.classList.add('is-selected');
    if (selected && state.flashIndex === state.currentIndex) btn.classList.add('is-flash');
    btn.appendChild(el('span', { className: 'option__key', text: String.fromCharCode(65 + displayIndex) }));
    btn.appendChild(el('span', { className: 'option__label', text: item.value }));
    btn.addEventListener('click', () => selectMcq(item.originalIndex));
    list.appendChild(btn);
  });
  return list;
}

export function buildTrueFalse(question, answer) {
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

export function buildTextAnswer(question, answer, isEssay) {
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

let autoAdvanceTimer = null;
let autoAdvanceEnabled = readAutoAdvancePreference(localStorage);

export function setAutoAdvancePreference(enabled) {
  autoAdvanceEnabled = enabled;
  writeAutoAdvancePreference(localStorage, enabled);
}

export function cancelAutoAdvance() {
  if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
}

export function maybeAutoAdvance(type, answer, changed) {
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
    if (state.currentIndex !== from) return;
    goToQuestion(from + 1);
  }, AUTO_ADVANCE_MS);
}

export function selectMcq(index) {
  const answer = state.answers[state.currentIndex];
  const changed = answer.draft !== index;
  answer.draft = index;
  state.flashIndex = state.currentIndex;
  renderQuestion();
  updatePaletteState();
  maybeAutoAdvance('MCQ', answer, changed);
}

export function selectTrueFalse(subIndex, value) {
  const answer = state.answers[state.currentIndex];
  const changed = answer.draft[subIndex] !== value;
  answer.draft[subIndex] = value;
  state.flashIndex = state.currentIndex;
  renderQuestion();
  updatePaletteState();
  maybeAutoAdvance('TRUE_FALSE', answer, changed);
}

export function selectText(value) {
  const answer = state.answers[state.currentIndex];
  answer.draft = value.slice(0, MAX_TEXT_LENGTH);
  updatePaletteState();
}

export function toggleFlag() {
  const index = state.currentIndex;
  if (state.flags.has(index)) state.flags.delete(index); else state.flags.add(index);
  renderQuestion();
}

export function isDraftReady(type, answer) {
  if (type === 'MCQ') return answer.draft !== null;
  if (type === 'TRUE_FALSE') return answer.draft.some((value) => value !== '');
  return String(answer.draft || '').trim() !== '';
}

export function goToQuestion(index) {
  cancelAutoAdvance();
  state.currentIndex = clampQuestionIndex(index, state.questions.length);
  state.flashIndex = null;
  renderQuestion();
}

export function goNext() {
  if (state.currentIndex >= state.questions.length - 1) { openSubmitConfirm(); return; }
  goToQuestion(state.currentIndex + 1);
}

export function goPrev() {
  if (state.currentIndex <= 0) return;
  goToQuestion(state.currentIndex - 1);
}

export function jumpTo(index) {
  closePalette();
  goToQuestion(index);
}

export function renderActionBar() {
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

export function updatePaletteState() {
  renderPalette();
  updateHeader();
}

export function renderPalette() {
  const grid = $('palette-grid-container');
  if (!grid) return;
  clear(grid);

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

export function openPalette() {
  renderPalette();
  show($('palette-backdrop'));
  $('question-palette-drawer').classList.add('is-open');
  $('question-palette-drawer').setAttribute('aria-hidden', 'false');
}

export function closePalette() {
  const backdrop = $('palette-backdrop');
  const drawer = $('question-palette-drawer');
  if (backdrop) hide(backdrop);
  if (drawer) {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }
}

export function isPaletteOpen() {
  const drawer = $('question-palette-drawer');
  return !!drawer && drawer.classList.contains('is-open');
}

/* =====================================================================
   Keyboard shortcuts
   ===================================================================== */

export function isTypingTarget(event) {
  const tag = (event.target && event.target.tagName) || '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export function onKeyDown(event) {
  if (state.mode !== 'quiz' && state.mode !== 'practice') return;
  if (!$('submitModal').classList.contains('hidden')) return;

  const type = normalizeType(state.questions[state.currentIndex].type);
  const key = event.key;
  const lower = key.toLowerCase();
  const typing = isTypingTarget(event);

  if (key === 'Escape') {
    if (state.isViewingImage) {
      event.preventDefault();
      closeImageLightbox();
      return;
    }
    if (isPaletteOpen()) {
      event.preventDefault();
      closePalette();
      return;
    }
  }

  if (lower === 'f' && !typing) {
    event.preventDefault();
    toggleFlag();
    return;
  }

  if (key === 'ArrowLeft') { event.preventDefault(); goPrev(); return; }
  if (key === 'ArrowRight') { event.preventDefault(); goNext(); return; }

  if (key === 'Enter' && !(typing && (event.target.tagName === 'TEXTAREA'))) {
    event.preventDefault();
    goNext();
    return;
  }

  if (typing) return;

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

export function buildAnswersPayload() {
  const payload = [];
  state.questions.forEach((question, index) => {
    const type = normalizeType(question.type);
    const answer = state.answers[index];
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

export function openSubmitConfirm() {
  if (state.submitting) return;
  const practice = state.mode === 'practice';
  if (state.mode !== 'quiz' && !practice) return;

  const unanswered = getUnansweredQuestions(state.questions, state.answers);
  const list = $('submitModalUnansweredList');
  const continueBtn = $('btnModalContinueExam');
  const title = $('submitModalTitle');
  const desc = $('submitModalDesc');

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
    continueBtn.onclick = () => { closeSubmitConfirm(); goToQuestion(unanswered[0].index); };
  }

  show($('submitModal'));
}

export function closeSubmitConfirm() { hide($('submitModal')); }

export async function submitExam(auto) {
  if (state.submitting) return;
  state.submitting = true;
  closeSubmitConfirm();
  stopTimer();
  stopHeartbeat();
  busy(true, 'Đang nộp bài…');

  const answers = buildAnswersPayload();
  const isForced = typeof auto === 'object' && Boolean(auto?.forcedReason);
  const metrics = {
    blurCount: state.blurCount,
    fullscreenExitCount: state.fullscreenExitCount,
    violationCount: state.violationCount || 0,
    elapsedSeconds: elapsedSeconds(),
    forcedReason: isForced ? auto.forcedReason : null,
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

export function recoverFromFailure(auto, message) {
  if (auto) {
    finishExam();
    renderResult({ failed: true, auto: true, message });
    return;
  }
  state.mode = 'quiz';
  startTimer();
  startHeartbeat();
  toast(message);
}

export function finishExam() {
  state.mode = 'result';
  state.examStatus = 'FINISHED';
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

export function gradeFor(percent) {
  if (percent >= 85) return { message: 'Hoàn thành tốt', sub: 'Bạn nắm chắc phần lớn nội dung.', cls: 'is-ok' };
  if (percent >= 70) return { message: 'Kết quả khá', sub: 'Tiếp tục ôn các câu còn sai.', cls: 'is-ok' };
  if (percent >= 50) return { message: 'Đạt yêu cầu', sub: 'Nên xem lại phần chưa chắc.', cls: 'is-warn' };
  return { message: 'Cần ôn lại', sub: 'Hãy đọc lại tài liệu và làm lại bài.', cls: 'is-danger' };
}

export function renderResult(outcome) {
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
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - percent / 100));
  });

  $('restartBtn').textContent = practice ? 'Ôn bài khác' : 'Làm bài khác';
  $('restartBtn').onclick = restart;

  if (practice) {
    renderPracticeReview(outcome.review || []);
    return;
  }

  checkAndShowCertificateOption(outcome);
}

export function checkAndShowCertificateOption(outcome) {
  if (state.isPractice || state.mode === 'practice') return;
  if (outcome.practice === true) return;

  const total = Math.max(1, outcome.total || 1);
  const percent = Math.round((outcome.score / total) * 100);

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

export function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes} phút ${seconds % 60} giây`;
}

/* =====================================================================
   Certificate modal
   ===================================================================== */

export function openCertificate() {
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

export function closeCertificate() { hide($('certOverlay')); }

export function renderQrCode(url) {
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

export function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

export function formatScore(value) {
  return Math.round(value * 100) / 100;
}

export function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `Thời gian làm bài: ${minutes} phút ${seconds % 60} giây`;
}

export function restart() {
  clearSession();
  window.location.reload();
}
