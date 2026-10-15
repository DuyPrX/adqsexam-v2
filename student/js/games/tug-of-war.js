/**
 * ADQS Exam v2 — Student SPA Tug of War Gamepad
 * =====================================================================
 * Tug of War (#view-tug) student logic:
 * controller claim, TEAM_SLOT_TAKEN, auto-landscape lock & 4-color gamepad.
 */

import { state, $, callRpc } from '../core/state.js';
import { switchView } from '../app.js';

/* =====================================================================
   Tug of War ("Kéo Co Tri Thức") Mobile Controller
   ===================================================================== */

let tugSession = null;
let tugPollInterval = null;
let tugFreezeTimerInterval = null;
let tugRealtimeChannel = null;

export function loadTugFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tugCode = params.get('tug') || params.get('tug_of_war');
  if (!tugCode) return false;
  const preferredTeam = params.get('team') || null;
  void initTugSession(tugCode.trim().toUpperCase(), preferredTeam);
  return true;
}

export async function initTugSession(sessionCode, preferredTeam) {
  switchView('tug');
  showTugScreen('checkin');

  const checkinErr = $('tugCheckinError');
  if (checkinErr) {
    checkinErr.classList.add('hidden');
    checkinErr.textContent = '';
  }

  const res = await callRpc('get_tug_of_war_session', {
    p_session_code: sessionCode,
  });

  if (!res.ok || !res.data?.success || !res.data.session) {
    if (checkinErr) {
      checkinErr.textContent = res.data?.message || 'Phiên thi đấu không tồn tại.';
      checkinErr.classList.remove('hidden');
    }
    return;
  }

  tugSession = res.data.session;
  const titleEl = $('tugHeaderTitle');
  if (titleEl) titleEl.textContent = tugSession.title || 'Kéo Co Tri Thức';

  const savedCode = state.studentCode || localStorage.getItem('adqs_student_code') || '';
  const inputCode = $('tugStudentCodeInput');
  if (inputCode && savedCode) {
    inputCode.value = savedCode;
  }

  const btnJoin = $('btnJoinTug');
  if (btnJoin) {
    btnJoin.onclick = async () => {
      const studentCode = inputCode ? inputCode.value.trim().toUpperCase() : '';
      if (!studentCode) {
        if (checkinErr) {
          checkinErr.textContent = 'Vui lòng nhập mã học sinh!';
          checkinErr.classList.remove('hidden');
        }
        return;
      }

      btnJoin.disabled = true;
      btnJoin.textContent = 'Đang vào phòng...';
      if (checkinErr) checkinErr.classList.add('hidden');

      const existingToken = localStorage.getItem('adqs_tug_controller_token');
      const joinRes = await callRpc('join_tug_of_war_lobby', {
        p_session_code: sessionCode,
        p_student_code: studentCode,
        p_preferred_team: preferredTeam,
        p_controller_token: existingToken || null,
      });

      btnJoin.disabled = false;
      btnJoin.textContent = 'Vào Phòng Thi Đấu';

      const slotTakenAlert = $('tugSlotTakenAlert');
      const retryBtn = $('btnRetryTugCheckin');
      if (retryBtn) {
        retryBtn.onclick = () => {
          localStorage.removeItem('adqs_tug_controller_token');
          if (slotTakenAlert) slotTakenAlert.classList.add('hidden');
          if (checkinErr) checkinErr.classList.add('hidden');
        };
      }

      if (!joinRes.ok || !joinRes.data?.success) {
        if (joinRes.data?.code === 'TEAM_SLOT_TAKEN') {
          if (slotTakenAlert) slotTakenAlert.classList.remove('hidden');
          if (checkinErr) checkinErr.classList.add('hidden');
        } else if (checkinErr) {
          checkinErr.textContent = joinRes.data?.message || 'Không thể tham gia phòng.';
          checkinErr.classList.remove('hidden');
          if (slotTakenAlert) slotTakenAlert.classList.add('hidden');
        }
        return;
      }

      if (slotTakenAlert) slotTakenAlert.classList.add('hidden');
      state.studentCode = studentCode;
      localStorage.setItem('adqs_student_code', studentCode);
      if (joinRes.data.controller_token) {
        localStorage.setItem('adqs_tug_controller_token', joinRes.data.controller_token);
      }
      state.tugTeam = joinRes.data.assigned_team;
      state.tugStudentName = joinRes.data.full_name || studentCode;

      enterTugGame(joinRes.data);
    };
  }

  const btnExit = $('btnExitTug');
  if (btnExit) {
    btnExit.onclick = () => {
      window.location.href = window.location.pathname;
    };
  }

  const padButtons = document.querySelectorAll('.tug-pad-btn');
  padButtons.forEach((btn) => {
    btn.onclick = () => {
      const optIdx = parseInt(btn.getAttribute('data-opt'), 10);
      void submitTugAnswer(optIdx);
    };
  });
}

export function showTugScreen(screenName) {
  const screens = ['checkin', 'lobby', 'active', 'finished'];
  screens.forEach((s) => {
    const el = $(`tug${s.charAt(0).toUpperCase() + s.slice(1)}Screen`);
    if (el) {
      if (s === screenName) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  });
}

export function enterTugGame(data) {
  const teamBadge = $('tugTeamBadge');
  if (teamBadge) {
    if (state.tugTeam === 'BLUE') {
      teamBadge.className = 'tug-team-badge is-blue';
      teamBadge.textContent = `🔵 ${data.blue_team_name || 'Đội Xanh'}`;
    } else {
      teamBadge.className = 'tug-team-badge is-red';
      teamBadge.textContent = `🔴 ${data.red_team_name || 'Đội Đỏ'}`;
    }
  }

  // Attempt auto-landscape presentation on device orientation API
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.lock === 'function') {
    screen.orientation.lock('landscape').catch(() => {});
  }

  subscribeTugRealtime(data.session_id);
  syncTugState(tugSession);
}

export function subscribeTugRealtime(sessionId) {
  if (tugRealtimeChannel) {
    void state.supabase.removeChannel(tugRealtimeChannel);
  }

  tugRealtimeChannel = state.supabase
    .channel(`tug-student-${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'tug_of_war_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => {
        if (payload.new) {
          tugSession = payload.new;
          syncTugState(tugSession);
        }
      }
    )
    .subscribe();

  if (tugPollInterval) clearInterval(tugPollInterval);
  tugPollInterval = setInterval(async () => {
    if (!tugSession || tugSession.status === 'FINISHED') {
      clearInterval(tugPollInterval);
      return;
    }
    const res = await callRpc('get_tug_of_war_session', {
      p_session_code: tugSession.session_code,
    });
    if (res.ok && res.data?.success && res.data.session) {
      tugSession = res.data.session;
      syncTugState(tugSession);
    }
  }, 2000);
}

export function syncTugState(session) {
  if (!session) return;

  if (session.status === 'LOBBY') {
    showTugScreen('lobby');
    const icon = $('tugLobbyTeamIcon');
    const title = $('tugLobbyTeamTitle');
    const name = $('tugLobbyStudentName');
    if (icon) icon.textContent = state.tugTeam === 'BLUE' ? '🔵' : '🔴';
    if (title) title.textContent = state.tugTeam === 'BLUE' ? (session.blue_team_name || 'Đội Xanh') : (session.red_team_name || 'Đội Đỏ');
    if (name) name.textContent = state.tugStudentName || state.studentCode || '';
    return;
  }

  if (session.status === 'FINISHED') {
    showTugScreen('finished');
    const winner = session.winner;
    const isWinner = winner === state.tugTeam;
    const isDraw = winner === 'DRAW' || !winner;
    const icon = $('tugFinishIcon');
    const title = $('tugFinishTitle');
    const sub = $('tugFinishSubtitle');
    const scores = $('tugFinishScores');
    if (icon) icon.textContent = isWinner ? '🏆' : isDraw ? '🤝' : '💪';
    if (title) title.textContent = isWinner ? 'CHIẾN THẮNG!' : isDraw ? 'HÒA NHAU!' : 'NỖ LỰC TUYỆT VỜI!';
    if (sub) {
      sub.textContent = isWinner
        ? 'Đội của bạn đã xuất sắc giành chiến thắng trong trận kéo co!'
        : isDraw
        ? 'Hai đội thi đấu rất ngang tài ngang sức!'
        : 'Đừng nản lòng, hãy cố gắng hơn ở các thử thách sau nhé!';
    }
    if (scores) {
      scores.innerHTML = `
        <div style="font-weight: 700; font-size: 14px; color: #93c5fd;">${session.blue_team_name}: ${session.blue_score} điểm</div>
        <div style="color: #64748b;">—</div>
        <div style="font-weight: 700; font-size: 14px; color: #fca5a5;">${session.red_team_name}: ${session.red_score} điểm</div>
      `;
    }
    return;
  }

  if (session.status === 'ACTIVE') {
    showTugScreen('active');
    renderTugActiveQuestion(session);
  }
}

export function renderTugActiveQuestion(session) {
  const isBlue = state.tugTeam === 'BLUE';
  const currentIdx = isBlue ? session.blue_current_idx : session.red_current_idx;
  const score = isBlue ? session.blue_score : session.red_score;
  const frozenUntilStr = isBlue ? session.blue_frozen_until : session.red_frozen_until;

  const prog = $('tugQuestionProgress');
  const scoreEl = $('tugTeamScore');
  const teamDot = $('tugGamepadTeamDot');
  const teamName = $('tugGamepadTeamName');

  if (prog) prog.textContent = `Câu ${Math.min(currentIdx + 1, session.question_count)} / ${session.question_count}`;
  if (scoreEl) scoreEl.textContent = `${score}đ`;
  if (teamDot) teamDot.textContent = isBlue ? '🔵' : '🔴';
  if (teamName) teamName.textContent = isBlue ? (session.blue_team_name || 'Đội Xanh') : (session.red_team_name || 'Đội Đỏ');

  const padButtons = document.querySelectorAll('.tug-pad-btn');

  if (frozenUntilStr) {
    const freezeUntil = new Date(frozenUntilStr).getTime();
    const remainingMs = freezeUntil - Date.now();
    if (remainingMs > 0) {
      padButtons.forEach((b) => { b.disabled = true; });
      showTugFreeze(remainingMs);
      return;
    } else {
      hideTugFreeze();
    }
  } else {
    hideTugFreeze();
  }

  if (currentIdx >= session.question_count) {
    padButtons.forEach((b) => { b.disabled = true; });
    return;
  }

  // Not frozen and not finished: unlock all 4 buttons
  padButtons.forEach((b) => { b.disabled = false; });
}

export function showTugFreeze(ms) {
  const overlay = $('tugFreezeOverlay');
  if (overlay) overlay.classList.remove('hidden');
  const timerEl = $('tugFreezeTimer');

  if (tugFreezeTimerInterval) clearInterval(tugFreezeTimerInterval);
  const targetTime = Date.now() + ms;

  const update = () => {
    const left = Math.max(0, targetTime - Date.now());
    if (timerEl) timerEl.textContent = `${(left / 1000).toFixed(1)}s`;
    if (left <= 0) {
      clearInterval(tugFreezeTimerInterval);
      hideTugFreeze();
      const padButtons = document.querySelectorAll('.tug-pad-btn');
      padButtons.forEach((b) => { b.disabled = false; });
    }
  };

  update();
  tugFreezeTimerInterval = setInterval(update, 100);
}

export function hideTugFreeze() {
  if (tugFreezeTimerInterval) clearInterval(tugFreezeTimerInterval);
  const overlay = $('tugFreezeOverlay');
  if (overlay) overlay.classList.add('hidden');
}

export async function submitTugAnswer(optionIdx) {
  if (!tugSession || tugSession.status !== 'ACTIVE') return;
  const isBlue = state.tugTeam === 'BLUE';
  const currentIdx = isBlue ? tugSession.blue_current_idx : tugSession.red_current_idx;

  const padButtons = document.querySelectorAll('.tug-pad-btn');
  padButtons.forEach((b) => { b.disabled = true; });

  const res = await callRpc('submit_tug_of_war_answer', {
    p_session_code: tugSession.session_code,
    p_team: state.tugTeam,
    p_question_idx: currentIdx,
    p_selected_option: optionIdx,
    p_student_code: state.studentCode || 'APP',
  });

  if (res.ok && res.data) {
    const data = res.data;
    if (data.code === 'TEAM_FROZEN') {
      showTugFreeze(data.remaining_ms || 3000);
      return;
    }

    if (data.success) {
      tugSession.blue_score = data.blue_score ?? tugSession.blue_score;
      tugSession.red_score = data.red_score ?? tugSession.red_score;
      tugSession.blue_current_idx = data.blue_current_idx ?? tugSession.blue_current_idx;
      tugSession.red_current_idx = data.red_current_idx ?? tugSession.red_current_idx;
      tugSession.blue_frozen_until = data.blue_frozen_until ?? tugSession.blue_frozen_until;
      tugSession.red_frozen_until = data.red_frozen_until ?? tugSession.red_frozen_until;
      tugSession.status = data.status ?? tugSession.status;
      tugSession.winner = data.winner ?? tugSession.winner;

      if (data.is_correct) {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate([40]);
        }
        const flashOverlay = $('tugCorrectFlashOverlay');
        if (flashOverlay) {
          flashOverlay.classList.remove('hidden');
          setTimeout(() => {
            flashOverlay.classList.add('hidden');
          }, 450);
        }
      } else {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate([150, 50, 150]);
        }
        showTugFreeze((tugSession.freeze_seconds || 3) * 1000);
      }

      syncTugState(tugSession);
    } else {
      padButtons.forEach((b) => { b.disabled = false; });
    }
  } else {
    padButtons.forEach((b) => { b.disabled = false; });
  }
}
