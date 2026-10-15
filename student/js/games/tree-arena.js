/**
 * ADQS Exam v2 — Student SPA Tree of Knowledge Arena
 * =====================================================================
 * Tree of Knowledge (#view-tree) student logic:
 * lobby, spectator, brainstorm & speed quiz modes, realtime listeners.
 */

import {
  state, $, el, clear, show, hide, rpcMessage, callRpc,
} from '../core/state.js';
import {
  TreeRenderer, clampTeamNumber, computeTreeState, getTeamSeed, hitTestFruits,
} from '../../tree-engine.js';
import {
  countTreeWords, normalizeAnswerText, treeWordCounterLabel,
} from '../../tree-words.js';
import {
  isAudioMuted, playBloomFanfare, playDewdropSound, resumeAudioContext, toggleAudioMute,
} from '../../tree-audio.js';
import { switchView } from '../app.js';

/* =====================================================================
   Tree of Knowledge screen (Phase 7.2 renderer / Phase 7.4 interaction)
   ===================================================================== */

/** Lazily created renderer for #tree-preview-canvas. */
export function treeRenderer() {
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
export function pointerToCanvas(event) {
  const canvas = $('tree-preview-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.clientWidth / rect.width : 1;
  const scaleY = rect.height ? canvas.clientHeight / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/** Renders the currently selected fruit into #treeFruitInfo (or hides it). */
export function showFruitInfo(fruit) {
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
export function onTreePointerMove(event) {
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
export function onTreePointerDown(event) {
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
 */
export function renderTree(session, submissions, animate) {
  const renderer = treeRenderer();
  if (!renderer || !session) return null;

  const team = clampTeamNumber(state.studentTeam);
  const teamSubmissions = submissions.filter(
    (row) => clampTeamNumber(row.team_number) === team,
  );
  const teamTotal = state.treeTeamCounts
    ? Number(state.treeTeamCounts[team]) || 0
    : Math.ceil((Number(session.totalStudents) || 0) / 4);

  const treeData = computeTreeState({
    totalStudents: Math.max(teamTotal, 1),
    submissions: teamSubmissions,
    timeLimitMinutes: session.timeLimitMinutes,
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

  if (treeData.isFlourished && !state.treeFlourished) {
    state.treeFlourished = true;
    playBloomFanfare();
  }

  latchTreeChampion();
  renderLeaderboard();

  return treeData;
}

/**
 * Phase 8.4 — latches the FIRST team to reach full participation.
 */
export function latchTreeChampion() {
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
export function renderLeaderboard() {
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
export function showTree(session, submissions, animate) {
  show($('treeScreen'));
  return renderTree(session, submissions, animate);
}

/**
 * Toggles between the tree's mutually exclusive states.
 */
export function setTreeView(view) {
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
 * Phase 9.1 — broadcast student presence in lobby.
 */
export function broadcastStudentLobbyPresence() {
  const ch = state.treeSessionChannel;
  if (!ch) return;

  const code = state.treeIdentity?.student_code || state.studentCode || null;
  const name = state.treeIdentity?.full_name || null;

  try {
    void ch.track({
      student_code: code,
      full_name: name,
      team: state.studentTeam || null,
      joined_at: Date.now(),
    });
    if (code) {
      void ch.send({
        type: 'broadcast',
        event: 'student_checkin',
        payload: {
          student_code: code,
          full_name: name,
          team: state.studentTeam || null,
        },
      });
    }
  } catch {
    // Ignore transient socket errors
  }
}

export function renderTreeLobby() {
  setTreeView('lobby');
  const session = state.treeSession;
  if (!session) return;

  broadcastStudentLobbyPresence();

  $('treeLobbyTitle').textContent = session.title || 'Cây Tri Thức';
  $('treeLobbyTeam').textContent = state.studentTeam
    ? `🌱 Bạn thuộc Cây ${state.studentTeam}. Hãy nhìn lên máy chiếu, trận đấu sẽ bắt đầu khi thầy/cô bấm nút!`
    : '🌱 Đã vào phòng! Hãy nhìn lên máy chiếu, trận đấu sẽ bắt đầu khi thầy/cô bấm nút!';
  $('treeLobbyHint').textContent =
    `${session.className || ''} · ${session.gameMode === 'SPEED_QUIZ' ? 'Đua tốc độ' : 'Bão não từ khóa'}`
    + ` · Thời gian ${session.timeLimitMinutes} phút`;
}

export function renderTreeSpectator() {
  setTreeView('spectator');
  const session = state.treeSession;
  $('treeSpectatorTitle').textContent = `👁️ ${session ? session.title : 'Chế độ quan sát'}`;
  $('treeSpectatorMeta').textContent = session
    ? `${session.className || ''} · Bạn đã được đánh dấu vắng mặt ở hoạt động này.`
    : '';
}

/** Non-blocking status banner inside the workspace. */
export function treeStatus(message, kind) {
  const node = $('treeStatusMessage');
  if (!node) return;
  node.className = 'alert hidden';
  if (!message) { node.textContent = ''; return; }
  node.classList.remove('hidden');
  if (kind) node.classList.add(`alert--${kind}`);
  node.textContent = message;
}

/** Error banner inside the check-in card. */
export function treeCheckinError(message) {
  const node = $('treeCheckinError');
  if (!node) return;
  if (!message) { hide(node); node.textContent = ''; return; }
  node.textContent = message;
  show(node);
}

/**
 * Phase 7.4 — opens a tree activity from `?session=`/`?tree=`.
 */
export function loadTreeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('tree') || params.get('session') || params.get('tree_code');
  if (!sessionId) return false;
  loadTreeActivity(sessionId);
  return true;
}

/**
 * Loads a tree session and shows the check-in screen.
 */
export async function loadTreeActivity(sessionRef) {
  switchView('tree');

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
    startedAt: session.started_at || session.created_at,
    className: payload.class_name || '',
    totalStudents: Math.max(Number(payload.total_students) || 0, 1),
    sessionCode: session.session_code || '',
    gameMode: session.game_mode === 'SPEED_QUIZ' ? 'SPEED_QUIZ' : 'BRAINSTORM',
    targetScore: Number(session.target_score) || 20,
    timeRemainingSeconds: Number(session.time_remaining_seconds) || 0,
  };
  state.treeMembers = Array.isArray(payload.candidates) ? payload.candidates : [];
  state.treeSubmissions = [];
  state.treeIdentity = null;
  state.treeSubmitted = false;
  state.treeFlourished = false;
  state.treeTeamCounts = payload.team_counts || null;
  state.treeChampionTeam = null;
  state.treeSessionId = session.id || null;
  state.treeStatus = session.status === 'LOBBY' ? 'LOBBY' : 'ACTIVE';
  state.treeGameMode = state.treeSession.gameMode;
  state.treeIsAbsent = session.is_absent === true;
  state.studentTeam = clampTeamNumber(session.team_number);
  if (session.student_name && state.studentCode) {
    state.treeIdentity = { student_code: state.studentCode, full_name: session.student_name };
  }

  $('treeCheckinTitle').textContent = state.treeSession.title;
  $('treeCheckinQuestion').textContent = state.treeSession.questionText;
  $('treeCheckinMeta').textContent =
    `${state.treeSession.className} · Tối thiểu ${state.treeSession.minWords} từ`
    + ` · Thời gian ${state.treeSession.timeLimitMinutes} phút`;
  populateTreeStudentSelect();
  $('treeAnswerInput').value = '';

  await loadTreeSubmissions(session.id);
  subscribeTreeChannel(session.id);
  subscribeTreeSessionChannel(session.id);

  showTree(state.treeSession, state.treeSubmissions, true);

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

export function showTreeError(message) {
  setTreeView('checkin');
  $('treeCheckinTitle').textContent = 'Không thể tham gia';
  $('treeCheckinQuestion').textContent = '';
  $('treeCheckinMeta').textContent = '';
  clear($('treeStudentSelect'));
  $('treeStudentSelect').appendChild(el('option', { text: '-- Chọn tên bạn --', attrs: { value: '' } }));
  $('btnEnterTree').disabled = true;
  treeCheckinError(message);
}

export function populateTreeStudentSelect() {
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

export async function loadTreeSubmissions(sessionId) {
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

export function subscribeTreeChannel(sessionId) {
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

export function unsubscribeTreeChannel() {
  if (state.treeChannel && state.supabase) {
    state.supabase.removeChannel(state.treeChannel);
  }
  state.treeChannel = null;
  if (state.treeSessionChannel && state.supabase) {
    state.supabase.removeChannel(state.treeSessionChannel);
  }
  state.treeSessionChannel = null;
}

let treeLobbyPollInterval = null;

export function stopTreeLobbyPolling() {
  if (treeLobbyPollInterval) {
    clearInterval(treeLobbyPollInterval);
    treeLobbyPollInterval = null;
  }
}

export function triggerBoutStartTransition(sessionPayload) {
  if (state.treeStatus !== 'LOBBY') return;
  stopTreeLobbyPolling();

  state.treeStatus = 'ACTIVE';
  if (sessionPayload && state.treeSession) {
    if (sessionPayload.started_at) {
      state.treeSession.startedAt = sessionPayload.started_at;
    }
    if (sessionPayload.time_remaining_seconds !== undefined) {
      state.treeSession.timeRemainingSeconds = Number(sessionPayload.time_remaining_seconds) || 0;
    }
  }

  if (typeof handleRealtimeSessionUpdate === 'function' && sessionPayload) {
    try {
      handleRealtimeSessionUpdate({ new: sessionPayload });
    } catch {
      // Fallback
    }
  }

  if (state.treeIdentity && !state.treeIsAbsent) {
    finishTreeWorkspace();
  }
}

export function subscribeTreeSessionChannel(sessionId) {
  stopTreeLobbyPolling();

  if (state.treeSessionChannel && state.supabase) {
    state.supabase.removeChannel(state.treeSessionChannel);
    state.treeSessionChannel = null;
  }
  if (!state.supabase || !sessionId) return;

  const presenceKey =
    state.treeIdentity?.student_code ||
    state.studentCode ||
    `anon_${Math.random().toString(36).slice(2, 8)}`;

  state.treeSessionChannel = state.supabase
    .channel(`tree-lobby-${sessionId}`, {
      config: { presence: { key: presenceKey } },
    })
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'tree_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => {
        if (typeof handleRealtimeSessionUpdate === 'function') {
          handleRealtimeSessionUpdate(payload);
        }
        if (payload?.new && payload.new.status !== 'LOBBY') {
          triggerBoutStartTransition(payload.new);
        }
      }
    )
    .on('broadcast', { event: 'bout_started' }, () => {
      triggerBoutStartTransition({
        status: 'ACTIVE',
        started_at: new Date().toISOString(),
      });
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        broadcastStudentLobbyPresence();
      }
    });

  treeLobbyPollInterval = setInterval(async () => {
    if (state.treeStatus !== 'LOBBY') {
      stopTreeLobbyPolling();
      return;
    }

    broadcastStudentLobbyPresence();

    const ref = state.treeSession?.sessionCode || sessionId;
    if (!ref) return;

    const res = await callRpc('get_public_tree_session', {
      p_session_code: String(ref),
      p_student_code: state.treeIdentity?.student_code || state.studentCode || null,
    });

    if (res.ok && res.data?.success && res.data.session) {
      const s = res.data.session;
      if (s.status && s.status !== 'LOBBY') {
        triggerBoutStartTransition(s);
      }
    }
  }, 2500);
}

export function handleRealtimeSessionUpdate(payload) {
  const row = payload.new;
  if (!row || row.id !== state.treeSessionId) return;
  if (state.treeIsAbsent) return;
  if (state.treeStatus === 'ACTIVE') return;

  state.treeStatus = row.status === 'ACTIVE' ? 'ACTIVE' : state.treeStatus;
  if (state.treeStatus !== 'ACTIVE') return;

  if (state.treeSession) {
    state.treeSession.timeRemainingSeconds =
      Number(row.time_remaining_seconds) || state.treeSession.timeRemainingSeconds;
  }
  if (state.treeIdentity) finishTreeWorkspace();
}

export function handleRealtimeSubmission(payload) {
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
    if (row.session_id !== session.id) return;

    const index = state.treeSubmissions.findIndex((existing) => existing.id === row.id);
    if (index === -1) {
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

export function updateTreeWordCounter() {
  const session = state.treeSession;
  if (!session) return;

  const words = countTreeWords($('treeAnswerInput').value);
  const counter = $('treeWordCounter');
  counter.textContent = treeWordCounterLabel(words, session.minWords);
  counter.classList.toggle('is-met', words >= session.minWords);
  counter.classList.toggle('is-short', words > 0 && words < session.minWords);

  $('btnSubmitTreeAnswer').disabled = words < session.minWords;
}

export function enterTreeWorkspace() {
  const studentCode = $('treeStudentSelect').value;
  const session = state.treeSession;
  if (!session) return;

  const member = state.treeMembers.find((m) => m.student_code === studentCode);
  if (!member) { treeCheckinError('Vui lòng chọn tên của bạn trong danh sách.'); return; }

  state.treeIdentity = { student_code: member.student_code, full_name: member.full_name };
  state.studentTeam = clampTeamNumber(member.team_number);
  treeCheckinError('');

  if (state.treeStatus === 'LOBBY') {
    renderTreeLobby();
    return;
  }
  finishTreeWorkspace();
}

export function finishTreeWorkspace() {
  const session = state.treeSession;
  if (!session) return;
  setTreeView('workspace');

  renderTree(session, state.treeSubmissions, true);
  applyTreeModePresentation();

  const reminder = $('treeQuestionReminder');
  if (reminder) reminder.textContent = session.questionText;

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

export function applyTreeModePresentation() {
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

export function startTreeCountdown(seconds) {
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

export function stopTreeCountdown() {
  if (state.treeCountdownTimer) {
    window.clearInterval(state.treeCountdownTimer);
    state.treeCountdownTimer = null;
  }
}

export function paintTreeCountdown() {
  const badge = $('treeTimeBadge');
  if (!badge) return;
  const total = Math.max(0, Number(state.treeRemainingSeconds) || 0);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  badge.textContent = `⏳ ${minutes}:${String(secs).padStart(2, '0')}`;
  badge.classList.toggle('is-urgent', total <= 60);
}

export async function submitTreeAnswer() {
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
      state.treeStatus = 'LOBBY';
      renderTreeLobby();
      return;
    } else if (payload.code === 'STUDENT_ABSENT') {
      state.treeIsAbsent = true;
      renderTreeSpectator();
      return;
    } else {
      treeStatus(rpcMessage(payload.code, payload.message), 'error');
    }
    button.disabled = false;
    return;
  }

  state.treeSubmitted = true;
  const submissionId = payload.submission_id;
  state.treeHighlightId = submissionId;

  await loadTreeSubmissions(session.id);
  renderTree(session, state.treeSubmissions, true);
  state.treeRenderer.setHighlight(submissionId);

  playDewdropSound(state.treeData ? state.treeData.vitality : 1);

  treeStatus('🌱 Giọt sương tri thức của bạn đã hòa vào cây! Bạn có thể sửa và gửi lại trước khi hết giờ.', 'success');
  button.disabled = false;
  $('treeAnswerInput').focus();
}

export function bindTreeControls() {
  $('treeStudentSelect').addEventListener('change', () => {
    $('btnEnterTree').disabled = !$('treeStudentSelect').value;
    treeCheckinError('');
  });
  $('btnEnterTree').addEventListener('click', enterTreeWorkspace);
  $('treeAnswerInput').addEventListener('input', updateTreeWordCounter);
  $('btnSubmitTreeAnswer').addEventListener('click', submitTreeAnswer);

  const audioButton = $('btnTreeAudioToggle');
  if (audioButton) {
    syncTreeAudioToggle(audioButton);
    audioButton.addEventListener('click', () => {
      void resumeAudioContext();
      toggleAudioMute();
      syncTreeAudioToggle(audioButton);
    });
  }

  document.addEventListener('pointerdown', () => { void resumeAudioContext(); }, {
    capture: true,
    once: true,
  });
}

export function syncTreeAudioToggle(button) {
  const muted = isAudioMuted();
  button.textContent = muted ? '🔇' : '🔊';
  button.setAttribute('aria-pressed', String(!muted));
  button.title = muted ? 'Bật âm thanh' : 'Tắt âm thanh';
}
