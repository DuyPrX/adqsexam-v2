/**
 * ADQS Exam v2 — Student SPA Pure Utilities & Helpers
 * =====================================================================
 */

/**
 * Phase 8.8 — canonical form for comparing a student's typed text with a roster
 * row. Unifies NFC, collapses whitespace, and lowercases.
 */
export function normalizeText(str) {
  if (!str) return '';
  return str.toString().normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* =====================================================================
   Deterministic PRNG & Question Helpers
   ===================================================================== */

/**
 * Phase 11.2 — deterministic option shuffle helpers.
 * Fast 32-bit string hash (Murmur-inspired 32-bit mixer).
 */
export function hashStringToSeed(str) {
  let hash = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash ^ str.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return hash >>> 0;
}

/**
 * Phase 11.2 — Mulberry32 PRNG (32-bit state generator).
 */
export function createMulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Phase 11.2 — Fisher-Yates shuffle with seeded PRNG.
 * Preserves canonical original index for each option.
 */
export function shuffleOptionsDeterministically(options, studentCode, questionId) {
  if (!Array.isArray(options) || options.length <= 1) {
    return (options || []).map((opt, idx) => ({ originalIndex: idx, value: opt }));
  }
  const seed = hashStringToSeed(`${studentCode}_${questionId}`);
  const rng = createMulberry32(seed);

  // Attach canonical original index before shuffling
  const wrapped = options.map((opt, idx) => ({
    originalIndex: idx,
    value: opt,
  }));

  // Fisher-Yates with seeded rng
  for (let i = wrapped.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wrapped[i], wrapped[j]] = [wrapped[j], wrapped[i]];
  }

  return wrapped;
}

/**
 * Phase 11.3 — format question content with markdown image and raw <img> tags
 * transformed to .question-img.
 */
export function formatQuestionContent(rawText) {
  if (!rawText) return '';
  let html = String(rawText).replace(
    /!\[(.*?)\]\((.*?)\)/g,
    '<img src="$2" alt="$1" class="question-img" />'
  );
  html = html.replace(/<img(?![^>]*class=["'][^"']*question-img)/gi, '<img class="question-img"');
  return html;
}

/**
 * Escape HTML special characters for safe attribute/text rendering.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Question type normalisation.
 */
export function normalizeType(raw) {
  const value = String(raw || '').toUpperCase();
  if (value === 'TRUE_FALSE') return 'TRUE_FALSE';
  if (value === 'SHORT_ANSWER') return 'SHORT_ANSWER';
  if (value === 'ESSAY') return 'ESSAY';
  return 'MCQ';
}

export const TYPE_LABEL = {
  MCQ: 'Trắc nghiệm',
  TRUE_FALSE: 'Đúng / Sai',
  SHORT_ANSWER: 'Trả lời ngắn',
  ESSAY: 'Tự luận',
};

export const TYPE_BADGE_CLASS = {
  MCQ: 'q-badge--mcq',
  TRUE_FALSE: 'q-badge--tf',
  SHORT_ANSWER: 'q-badge--short',
  ESSAY: 'q-badge--essay',
};

/**
 * UUID v4 validator.
 */
export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
