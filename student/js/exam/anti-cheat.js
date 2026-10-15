/**
 * ADQS Exam v2 — Student SPA Anti-Cheat Defense Suite
 * =====================================================================
 * Client Defense Shield & Security Policy (Phase 11.0 & 11.1)
 */

import { state, $, show, hide } from '../core/state.js';
import { submitExam } from './exam-runner.js';

export const preventDefaultHandler = (event) => event.preventDefault();

export function onFullscreenChange() {
  if (state.mode !== 'quiz') return;
  const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsElement) {
    state.fullscreenExitCount += 1;
    show($('fullscreenOverlay'));
  } else {
    hide($('fullscreenOverlay'));
  }
}

let lastViolationTimes = {};

export function updateViolationBadge() {
  const badge = document.getElementById('securityViolationBadge');
  if (!badge) return;
  const count = state.violationCount || 0;
  const max = state.maxViolations || 3;
  if (count <= 0) {
    badge.className = 'security-violation-badge is-clean';
    badge.textContent = '';
    return;
  }
  badge.textContent = `⚠️ Vi phạm: ${count}/${max} lần`;
  if (count >= max) {
    badge.className = 'security-violation-badge is-danger';
  } else {
    badge.className = 'security-violation-badge is-warning';
  }
}

export function handleViolationRecorded(type, msg) {
  state.violationCount = (state.violationCount || 0) + 1;
  updateViolationBadge();

  const cfg = state.securityConfig || {};
  if (cfg.auto_submit_on_limit && state.violationCount >= state.maxViolations) {
    alert(`⚠️ Bạn đã vi phạm quy chế thi ${state.violationCount}/${state.maxViolations} lần. Hệ thống sẽ tự động nộp bài!`);
    submitExam({ forcedReason: 'AUTO_VIOLATION_LIMIT' });
  }
}

export function reportViolation(type, message, metadata = {}) {
  const now = Date.now();
  if (lastViolationTimes[type] && now - lastViolationTimes[type] < 3000) return;
  lastViolationTimes[type] = now;

  handleViolationRecorded(type, message);

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
export function setupForensicWatermark(name, code, examCode) {
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

export function onSecurityCopyCutContext(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  e.preventDefault();
  if (e.clipboardData) e.clipboardData.setData('text/plain', '');
  reportViolation('COPY_ATTEMPT', 'Thao tác sao chép hoặc mở menu chuột phải bị chặn');
}

export function onSecuritySelectionChange() {
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) {
    const active = document.activeElement;
    if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
      sel.removeAllRanges();
    }
  }
}

export function onSecurityTouch(e) {
  if (state.isViewingImage) return;
  if (e.touches && e.touches.length >= 3) {
    e.preventDefault();
    document.body.classList.add('security-blur');
    reportViolation('MULTI_TOUCH', `Phát hiện cử chỉ chạm ${e.touches.length} ngón tay`);
  }
}

export function onSecurityTouchEnd(e) {
  if (state.isViewingImage) return;
  if (!e.touches || e.touches.length === 0) {
    setTimeout(() => {
      if (!document.hidden && document.hasFocus()) {
        document.body.classList.remove('security-blur');
      }
    }, 600);
  }
}

export function onSecurityWindowBlur() {
  if (state.mode !== 'quiz' && !state.antiCheatBound) return;
  if (!$('fullscreenOverlay').classList.contains('hidden')) return;
  document.body.classList.add('security-blur');
  state.blurCount += 1;
  reportViolation('WINDOW_BLUR', 'Trình duyệt mất tiêu điểm (chuyển app hoặc chụp màn hình)');
}

export function onSecurityWindowFocus() {
  if (document.body.classList.contains('security-blur')) {
    if (state.securityConfig?.enforce_fullscreen && !document.fullscreenElement) {
      return;
    }
    document.body.classList.remove('security-blur');
  }
}

export function onSecurityVisibilityChange() {
  if (state.mode !== 'quiz' && !state.antiCheatBound) return;
  if (document.hidden) {
    document.body.classList.add('security-blur');
    state.blurCount += 1;
    reportViolation('TAB_HIDDEN', 'Rời tab hoặc chuyển sang ứng dụng khác');
  } else {
    if (state.securityConfig?.enforce_fullscreen && !document.fullscreenElement) {
      return;
    }
    document.body.classList.remove('security-blur');
  }
}

/** Text fields must stay usable, so selection blocking skips form controls. */
export function onSelectStart(event) {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  event.preventDefault();
}

let onSplitScreenResize = null;
let onDeviceMotion = null;
let onEnforcedFullscreenChange = null;

export function initAntiCheat(cfg) {
  if (cfg) state.securityConfig = cfg;
  state.violationCount = 0;
  state.maxViolations = typeof (cfg && cfg.max_violations) === 'number' ? cfg.max_violations : 3;
  updateViolationBadge();
  bindAntiCheat(state.securityConfig);
}

export function bindAntiCheat(cfg) {
  if (state.mode === 'practice' || state.isPractice) return;
  if (state.antiCheatBound) return;
  state.antiCheatBound = true;

  const config = cfg || state.securityConfig || {
    prevent_copy: true,
    detect_multitouch: true,
    blur_on_leave: true,
    watermark: true,
    enforce_fullscreen: true,
    detect_split_screen: true,
    detect_motion: false,
    shuffle_options: true,
    max_violations: 3,
    auto_submit_on_limit: false,
  };
  state.securityConfig = config;
  state.violationCount = 0;
  state.maxViolations = typeof config.max_violations === 'number' ? config.max_violations : 3;
  updateViolationBadge();

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

  // 5. Fullscreen Enforcement
  if (config.enforce_fullscreen) {
    const reqFs = () => {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => { });
      }
    };
    reqFs();

    onEnforcedFullscreenChange = () => {
      if (!document.fullscreenElement && (state.examStatus === 'IN_PROGRESS' || state.mode === 'quiz')) {
        document.body.classList.add('security-blur');
        reportViolation('FULLSCREEN_EXIT', 'Thí sinh đã thoát chế độ toàn màn hình');
      }
    };
    document.addEventListener('fullscreenchange', onEnforcedFullscreenChange);

    const fsBtn = document.getElementById('btnEnterFullscreen');
    if (fsBtn) {
      fsBtn.onclick = (e) => {
        if (e) e.stopPropagation();
        reqFs();
        if (document.hasFocus()) document.body.classList.remove('security-blur');
      };
    }
  }

  // 6. Split-Screen & Resizing
  if (config.detect_split_screen) {
    const baseH = window.innerHeight;
    onSplitScreenResize = () => {
      if (state.examStatus !== 'IN_PROGRESS' && state.mode !== 'quiz') return;
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!isInput && window.innerHeight / baseH < 0.65) {
        document.body.classList.add('security-blur');
        reportViolation('SPLIT_SCREEN_DETECTED', 'Phát hiện màn hình bị thu nhỏ (nghi vấn chia đôi màn hình)');
      }
    };
    window.addEventListener('resize', onSplitScreenResize);
  }

  // 7. Device Motion Guard
  if (config.detect_motion) {
    let lastAccTime = 0;
    onDeviceMotion = (e) => {
      if (state.examStatus !== 'IN_PROGRESS' && state.mode !== 'quiz') return;
      const acc = e.accelerationIncludingGravity;
      if (!acc) return;
      const mag = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);
      if (Math.abs(mag - 9.81) > 4.5 && Date.now() - lastAccTime > 3000) {
        lastAccTime = Date.now();
        reportViolation('PHONE_MOVED', 'Phát hiện thiết bị bị nhấc lên hoặc di chuyển mạnh');
      }
    };
    if (typeof DeviceMotionEvent !== 'undefined') {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission().then(res => {
          if (res === 'granted') window.addEventListener('devicemotion', onDeviceMotion);
        }).catch(() => { });
      } else {
        window.addEventListener('devicemotion', onDeviceMotion);
      }
    }
  }
}

export function unbindAntiCheat() {
  if (!state.antiCheatBound) return;
  state.antiCheatBound = false;

  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
  if (onEnforcedFullscreenChange) {
    document.removeEventListener('fullscreenchange', onEnforcedFullscreenChange);
    onEnforcedFullscreenChange = null;
  }
  if (onSplitScreenResize) {
    window.removeEventListener('resize', onSplitScreenResize);
    onSplitScreenResize = null;
  }
  if (onDeviceMotion) {
    window.removeEventListener('devicemotion', onDeviceMotion);
    onDeviceMotion = null;
  }

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

  state.violationCount = 0;
  updateViolationBadge();
}

export async function requestFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return;
  try { await request.call(root); } catch { /* user may decline */ }
}

export async function exitFullscreenIfNeeded() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { if (exit) await exit.call(document); } catch { /* ignore */ }
  }
}
