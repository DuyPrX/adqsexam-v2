/**
 * ADQS Exam v2 — Student SPA Theme & Typography Controller
 * =====================================================================
 */

import { $, el } from './state.js';
import {
  FONT_CYCLE, FONT_KEY, FONT_LABELS, THEME_KEY,
  nextFontStep, nextTheme, normalizeTheme,
} from '../../exam-nav.js';

/** OS dark-mode preference, resolved against the explicit theme choice. */
export function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Current theme, resolving "no explicit choice" against the OS preference. */
export function currentTheme() {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'), prefersDark());
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === 'light' || saved === 'dark' || saved === 'sepia') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  renderThemeIcon();
}

/** Cycles light -> dark -> sepia -> light and persists the choice. */
export function toggleTheme() {
  const next = nextTheme(currentTheme());
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  renderThemeIcon();
}

/**
 * Reflects the active theme on one theme button (glyph + accessible name).
 */
export function paintThemeButton(node, theme) {
  if (!node) return;
  const glyph = theme === 'dark' ? '☀' : theme === 'sepia' ? '🌗' : '🌙';
  const existing = node.querySelector('.btn-label, .theme-label');
  const labelClass = existing ? existing.className : 'btn-label';
  node.textContent = '';
  node.appendChild(document.createTextNode(`${glyph} `));
  node.appendChild(el('span', { className: labelClass, text: 'Giao diện' }));
  node.setAttribute('aria-label', `Giao diện: ${theme === 'dark' ? 'Tối' : theme === 'sepia' ? 'Dịu mắt' : 'Sáng'}`);
}

export function renderThemeIcon() {
  const theme = currentTheme();
  paintThemeButton($('btn-theme-toggle'), theme);
  paintThemeButton($('btn-global-theme-toggle'), theme);
}

/* ---------- font size ---------- */

export function currentFontStep() {
  const attr = document.documentElement.getAttribute('data-font');
  return FONT_CYCLE.includes(attr) ? attr : '';
}

export function initFontSize() {
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch { /* ignore */ }
  if (FONT_CYCLE.includes(saved) && saved !== '') {
    document.documentElement.setAttribute('data-font', saved);
  }
  renderFontIcon();
}

export function cycleFontSize() {
  const next = nextFontStep(currentFontStep());
  if (next === '') document.documentElement.removeAttribute('data-font');
  else document.documentElement.setAttribute('data-font', next);
  try { localStorage.setItem(FONT_KEY, next); } catch { /* ignore */ }
  renderFontIcon();
}

export function renderFontIcon() {
  const node = $('btn-font-toggle');
  if (!node) return;
  node.textContent = '';
  node.appendChild(document.createTextNode('🔤 '));
  node.appendChild(el('span', {
    className: 'btn-label',
    text: `Cỡ chữ: ${FONT_LABELS[currentFontStep()]}`,
  }));
}
