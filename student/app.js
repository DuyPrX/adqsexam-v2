/**
 * ADQS Exam v2 — Student SPA Main Orchestrator
 * =====================================================================
 * Main entry point, initialization, URL router & global bindings.
 */

import {
  state, $, hide, show, initSupabase, loginError, toast,
} from './js/core/state.js';
import {
  initTheme, toggleTheme, initFontSize, cycleFontSize,
} from './js/core/theme.js';
import {
  formatQuestionContent, shuffleOptionsDeterministically,
  hashStringToSeed, createMulberry32,
} from './js/core/utils.js';
import {
  requestFullscreen, reportViolation, initAntiCheat,
  bindAntiCheat, unbindAntiCheat, onFullscreenChange, updateViolationBadge,
} from './js/exam/anti-cheat.js';
import {
  handleLoginSubmit, bindRosterControls, tryResumeSession,
  prefillFromUrl, loadExamRoster, resetToLogin,
  startTimer, stopTimer, startHeartbeat, stopHeartbeat,
} from './js/exam/exam-session.js';
import {
  openImageLightbox, closeImageLightbox, openPalette, closePalette,
  goPrev, goNext, jumpTo, toggleFlag, openSubmitConfirm, closeSubmitConfirm,
  submitExam, openCertificate, closeCertificate, onKeyDown,
  setAutoAdvancePreference, makeEmptyAnswer, renderQuestion, renderQuizShell,
  renderResult, restart,
} from './js/exam/exam-runner.js';
import {
  handlePracticeSubmit, selectModeTab, selectPracticeSource,
  loadPracticeRoster, clearPracticeBanner, updatePracticeStartState,
  submitPractice, extractPracticeDocx, enterPractice, gradePractice,
} from './js/exam/practice-docx.js';
import {
  bindTreeControls, loadTreeFromUrl, loadTreeActivity, renderTree, showTree,
} from './js/games/tree-arena.js';
import {
  loadTugFromUrl, initTugSession, submitTugAnswer,
} from './js/games/tug-of-war.js';
import { readAutoAdvancePreference } from './exam-nav.js';
import { resolveSupabaseConfig, resolveWorkerBaseUrl } from './app-config.js';
import { playDewdropSound, playBloomFanfare } from './tree-audio.js';

/* =====================================================================
   View router (Phase 8.1)
   ===================================================================== */

/**
 * Shows one top-level view and hides the other.
 */
export function switchView(viewName) {
  const examView = $('view-exam');
  const treeView = $('view-tree');
  const tugView = $('view-tug');
  if (viewName === 'tree') {
    if (examView) examView.style.display = 'none';
    if (tugView) tugView.style.display = 'none';
    if (treeView) treeView.style.display = 'block';
    window.scrollTo(0, 0);
  } else if (viewName === 'tug') {
    if (examView) examView.style.display = 'none';
    if (treeView) treeView.style.display = 'none';
    if (tugView) tugView.style.display = 'block';
    window.scrollTo(0, 0);
  } else {
    if (treeView) treeView.style.display = 'none';
    if (tugView) tugView.style.display = 'none';
    if (examView) examView.style.display = 'block';
  }
}

/* =====================================================================
   SPA Boot & Event Wiring
   ===================================================================== */

export async function boot() {
  initTheme();
  initFontSize();

  try {
    state.supabase = initSupabase();
  } catch (error) {
    loginError(error.message);
    const startBtn = $('startBtn');
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const loginForm = $('loginForm');
  if (loginForm) loginForm.addEventListener('submit', handleLoginSubmit);
  bindRosterControls();
  bindTreeControls();

  window.addEventListener('resize', () => {
    if (state.treeData && state.treeRenderer) state.treeRenderer.render(state.treeData);
  });

  const practiceForm = $('practiceForm');
  if (practiceForm) practiceForm.addEventListener('submit', handlePracticeSubmit);
  const tabOfficial = $('tabOfficial');
  if (tabOfficial) tabOfficial.addEventListener('click', () => selectModeTab('official'));
  const tabPractice = $('tabPractice');
  if (tabPractice) tabPractice.addEventListener('click', () => selectModeTab('practice'));
  const practiceSourceCodeBtn = $('practiceSourceCodeBtn');
  if (practiceSourceCodeBtn) practiceSourceCodeBtn.addEventListener('click', () => selectPracticeSource('code'));
  const practiceSourceFileBtn = $('practiceSourceFileBtn');
  if (practiceSourceFileBtn) practiceSourceFileBtn.addEventListener('click', () => selectPracticeSource('file'));

  const practiceCodeInput = $('practice-exam-code');
  if (practiceCodeInput) {
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
      event.preventDefault();
      void loadPracticeRoster(practiceCodeInput.value);
    });
    practiceCodeInput.addEventListener('blur', () => {
      const current = practiceCodeInput.value.trim().toUpperCase();
      if (current && current === state.practiceVerifiedCode && state.practiceCodeStatus) return;
      void loadPracticeRoster(practiceCodeInput.value);
    });
    practiceCodeInput.addEventListener('input', () => {
      state.practiceCodeStatus = null;
      state.practiceVerifiedCode = '';
      clearPracticeBanner();
      updatePracticeStartState();
    });
  }

  const btnOpenPalette = $('btn-open-palette');
  if (btnOpenPalette) btnOpenPalette.addEventListener('click', openPalette);
  const btnClosePalette = $('btn-close-palette');
  if (btnClosePalette) btnClosePalette.addEventListener('click', closePalette);
  const paletteBackdrop = $('palette-backdrop');
  if (paletteBackdrop) paletteBackdrop.addEventListener('click', closePalette);
  const btnThemeToggle = $('btn-theme-toggle');
  if (btnThemeToggle) btnThemeToggle.addEventListener('click', toggleTheme);
  const btnGlobalThemeToggle = $('btn-global-theme-toggle');
  if (btnGlobalThemeToggle) btnGlobalThemeToggle.addEventListener('click', toggleTheme);
  const btnFontToggle = $('btn-font-toggle');
  if (btnFontToggle) btnFontToggle.addEventListener('click', cycleFontSize);
  const btnPrev = $('btn-prev-question');
  if (btnPrev) btnPrev.addEventListener('click', goPrev);
  const btnNext = $('btn-next-question');
  if (btnNext) btnNext.addEventListener('click', goNext);
  const btnFlag = $('btn-flag-question');
  if (btnFlag) btnFlag.addEventListener('click', toggleFlag);
  const btnFinish = $('btn-finish-exam');
  if (btnFinish) btnFinish.addEventListener('click', openSubmitConfirm);

  const autoAdvanceBox = $('chk-auto-advance');
  if (autoAdvanceBox) {
    const autoAdvanceEnabled = readAutoAdvancePreference(localStorage);
    autoAdvanceBox.checked = autoAdvanceEnabled;
    autoAdvanceBox.addEventListener('change', (event) => {
      setAutoAdvancePreference(event.target.checked);
    });
  }

  const fsResumeBtn = $('fsResumeBtn');
  if (fsResumeBtn) fsResumeBtn.addEventListener('click', () => { requestFullscreen(); hide($('fullscreenOverlay')); });
  const evictedBtn = $('evictedBtn');
  if (evictedBtn) evictedBtn.addEventListener('click', () => window.location.reload());

  const btnMotion = $('btnRequestMotion');
  if (btnMotion) {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      btnMotion.classList.remove('hidden');
    }
    btnMotion.addEventListener('click', async () => {
      try {
        if (typeof DeviceMotionEvent?.requestPermission === 'function') {
          const res = await DeviceMotionEvent.requestPermission();
          if (res === 'granted') {
            btnMotion.classList.add('hidden');
            toast('Đã cấp quyền cảm biến di chuyển');
          }
        }
      } catch (e) {
        console.warn('Motion permission request failed', e);
      }
    });
  }

  const btnResumeBlur = $('btnResumeSecurityBlur');
  if (btnResumeBlur) {
    btnResumeBlur.addEventListener('click', () => {
      if (state.securityConfig?.enforce_fullscreen && !document.fullscreenElement) {
        requestFullscreen();
      }
      document.body.classList.remove('security-blur');
    });
  }

  const btnFullscreen = $('btnEnterFullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', (e) => {
      if (e) e.stopPropagation();
      requestFullscreen();
      if (document.hasFocus()) document.body.classList.remove('security-blur');
    });
  }

  const blurOverlay = $('securityBlurOverlay');
  if (blurOverlay) {
    blurOverlay.addEventListener('click', () => {
      if (!document.hidden && document.hasFocus()) {
        if (state.securityConfig?.enforce_fullscreen && !document.fullscreenElement) {
          requestFullscreen();
        }
        document.body.classList.remove('security-blur');
      }
    });
  }

  if ($('btnModalConfirmSubmit')) {
    $('btnModalConfirmSubmit').addEventListener('click', () => {
      closeSubmitConfirm();
      if (state.mode === 'practice') submitPractice();
      else submitExam(false);
    });
  }

  const certBtn = $('certBtn');
  if (certBtn) certBtn.addEventListener('click', openCertificate);
  const certCloseBtn = $('certCloseBtn');
  if (certCloseBtn) certCloseBtn.addEventListener('click', closeCertificate);
  const certPrintBtn = $('certPrintBtn');
  if (certPrintBtn) certPrintBtn.addEventListener('click', () => window.print());

  document.addEventListener('keydown', onKeyDown);

  const btnCloseLightbox = $('btnCloseLightbox');
  if (btnCloseLightbox) {
    btnCloseLightbox.addEventListener('click', closeImageLightbox);
  }
  const imageLightboxModal = $('imageLightboxModal');
  if (imageLightboxModal) {
    imageLightboxModal.addEventListener('click', (e) => {
      if (e.target === imageLightboxModal) {
        closeImageLightbox();
      }
    });
  }
  const questionHost = $('questionHost');
  if (questionHost) {
    questionHost.addEventListener('click', (e) => {
      const img = e.target.closest('img.question-img');
      if (img) {
        openImageLightbox(img.getAttribute('src'), img.getAttribute('alt') || '');
      }
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (loadTugFromUrl()) return;
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

// Global browser attachments
if (typeof window !== 'undefined') {
  window.formatQuestionContent = formatQuestionContent;
  window.openImageLightbox = openImageLightbox;
  window.closeImageLightbox = closeImageLightbox;
  window.shuffleOptionsDeterministically = shuffleOptionsDeterministically;
  window.hashStringToSeed = hashStringToSeed;
  window.createMulberry32 = createMulberry32;
  window.reportViolation = reportViolation;
  window.initAntiCheat = initAntiCheat;
  window.bindAntiCheat = bindAntiCheat;
  window.unbindAntiCheat = unbindAntiCheat;
  window.submitExam = submitExam;
  window.switchView = switchView;
  window.loadTreeFromUrl = loadTreeFromUrl;
  window.loadTugFromUrl = loadTugFromUrl;
  window.boot = boot;
}

// Auto-boot in browser
if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  boot();
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', boot);
}

export {
  formatQuestionContent,
  openImageLightbox,
  closeImageLightbox,
  shuffleOptionsDeterministically,
  hashStringToSeed,
  createMulberry32,
  reportViolation,
  initAntiCheat,
  bindAntiCheat,
  unbindAntiCheat,
  submitExam,
  loadTreeFromUrl,
  loadTugFromUrl,
};
