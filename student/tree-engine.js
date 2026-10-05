/**
 * ADQS Exam v2 — Tree of Knowledge procedural renderer (Phase 7.2 / 8.2)
 * =====================================================================
 * A dependency-free, deterministic Canvas 2D renderer for the "Cây tri thức"
 * activity. Every visual property derives from `tree_seed` plus the session's
 * participation/vitality figures, so two clients handed the same session data
 * draw the SAME tree — no tree geometry is ever stored server-side.
 *
 * PHASE 8.2 — ORGANIC REDESIGN
 *   The renderer now grows like a plant rather than assembling primitives:
 *     SEED     P = 0            a dormant seed nestled in a soil mound
 *     SPROUT   0 < P <= 0.15    a tender stalk with two cotyledon leaves
 *     SAPLING  0.15 < P <= 0.50 curved branches + organic foliage puffs
 *     MATURING 0.50 < P < 1.0   a sprawling, gently swaying canopy
 *     BLOOM    P = 1.0          petals + golden sparkles (`isFlourished`)
 *   Submitted answers are rendered as glowing translucent "knowledge dewdrops"
 *   (`drawDewdrop`) whose radiance scales with word count and vitality.
 *
 * ISOMORPHIC BY CONSTRUCTION
 *   Nothing touches `document`, `window`, `requestAnimationFrame` or `Math.random`
 *   at module scope. The only DOM-accepting entry points are the `TreeRenderer`
 *   constructor (`canvas`) and its methods, so the e2e suite can import this
 *   module under plain Node and exercise the real shipped code.
 *
 * TESTABILITY SPLIT (the reason this module is shaped the way it is)
 *   `computeTreeState()` is PURE and returns dewdrop anchors in NORMALISED [0,1]
 *   coordinates. `layoutDewdropAnchors()` maps them to pixels with a UNIFORM
 *   scale factor, which means anchor separation measured in normalised space is
 *   preserved exactly in pixels — so "dewdrops do not overlap" is provable
 *   headless.
 *
 * DETERMINISM DISCIPLINE
 *   The tested geometry avoids implementation-defined math: no `Math.hypot`
 *   (precision varies between engines) and no trigonometry in the anchor path.
 *   Only IEEE-754 basic ops and `Math.sqrt` are used, which are exactly
 *   reproducible. Trig is confined to the drawing path, which is not asserted.
 */

/* =====================================================================
   Constants
   ===================================================================== */

/** Reference "design" min-dimension. Dewdrop radii are expressed relative to it. */
export const NOMINAL_MIN_DIM = 520;

/** Dewdrop base radius in pixels; the spec's `baseRadius` term. */
export const BASE_FRUIT_RADIUS = 9;

/**
 * Canopy ellipse in NORMALISED coordinates. Kept inside (0,1) with room for the
 * largest dewdrop radius so `nx ± r` never leaves the canvas bounding box.
 */
const CANOPY = { cx: 0.5, cy: 0.40, rx: 0.46, ry: 0.38 };

/**
 * Minimum clear space between dewdrop edges, in normalised units.
 *
 * Non-zero on purpose. With a gap of 0 the relaxation converges to exactly
 * TANGENT dewdrops (residual ~1e-13px of float noise), which looks cramped and
 * makes "do not overlap" an assertion against zero rather than a positive
 * margin. ~0.012 is about 6px on a reference canvas — visually comfortable and
 * comfortably provable.
 */
const ANCHOR_GAP = 0.012;

/** Relaxation budget. Deterministic (fixed iteration count, fixed pair order). */
const RELAX_ITERATIONS = 240;

/* =====================================================================
   A. Seeded PRNG — Mulberry32
   ===================================================================== */

/**
 * Mulberry32. Deterministic and dependency-free.
 *
 * The `|| 123456` fallback is significant, not cosmetic: a seed of 0 (which
 * `floor(random() * 1000000)` in the DB default CAN produce) would otherwise
 * leave the generator in a degenerate all-zero state sequence. Kept exactly as
 * specified so the client matches any future server-side port.
 */
export function createPRNG(seed) {
  let s = (seed >>> 0) || 123456;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =====================================================================
   B. Palettes — 4 archetypes, chosen by `seed % 4`
   ===================================================================== */

export const THEMES = [
  {
    index: 0,
    key: 'orchard',
    name: 'Cây Quả Mọng',
    label: 'Vườn Mùa Hè',
    trunk: '#6b4423',
    trunkDark: '#4a2f18',
    leaf: '#2e9e5b',
    leafAlt: '#43c47a',
    fruit: '#e0243c',
    fruitAlt: '#ff5470',
    fruitGlow: 'rgba(255, 84, 112, 0.55)',
    sky: ['#eaf6ff', '#f7fbf4'],
    soil: ['#8a5a32', '#5c3a1e'],
  },
  {
    index: 1,
    key: 'sakura',
    name: 'Cây Anh Đào',
    label: 'Hoa Anh Đào',
    trunk: '#4b4145',
    trunkDark: '#332c30',
    leaf: '#f7a8c8',
    leafAlt: '#ffc9de',
    fruit: '#ff5c8a',
    fruitAlt: '#ff9ec2',
    fruitGlow: 'rgba(255, 92, 138, 0.6)',
    sky: ['#fff1f6', '#fdf6ff'],
    soil: ['#7a6a62', '#4f443f'],
  },
  {
    index: 2,
    key: 'autumn',
    name: 'Cây Mùa Thu',
    label: 'Mùa Thu Vàng',
    trunk: '#9a6a33',
    trunkDark: '#6d471f',
    leaf: '#f2a71b',
    leafAlt: '#f7c948',
    fruit: '#ef6c1a',
    fruitAlt: '#ffa04a',
    fruitGlow: 'rgba(255, 160, 74, 0.55)',
    sky: ['#fff7e6', '#fdf3e0'],
    soil: ['#8f6b3d', '#5e4423'],
  },
  {
    index: 3,
    key: 'mystic',
    name: 'Cây Thần Tiên',
    label: 'Ánh Sáng Huyền Bí',
    trunk: '#c9d2d6',
    trunkDark: '#98a6ac',
    leaf: '#28d6d0',
    leafAlt: '#6df3ea',
    fruit: '#a855f7',
    fruitAlt: '#c98bff',
    fruitGlow: 'rgba(201, 139, 255, 0.65)',
    sky: ['#eef7ff', '#e9f5f7'],
    soil: ['#6f7d85', '#455057'],
  },
];

/** `seed % 4`, normalised to handle undefined/negative/non-finite input. */
export function themeIndexForSeed(seed) {
  const n = Number(seed);
  if (!Number.isFinite(n)) return 0;
  return ((Math.trunc(n) % 4) + 4) % 4;
}

/** The palette for a seed. */
export function themeForSeed(seed) {
  return THEMES[themeIndexForSeed(seed)];
}

/* =====================================================================
   C. Growth mathematics
   ===================================================================== */

/**
 * The five growth stage IDENTIFIERS (Phase 8.2). Exposed as string constants so
 * call sites compare against `TREE_STAGES.BLOOM` rather than a bare literal.
 */
export const TREE_STAGES = {
  SEED: 'seed',           // P = 0
  SPROUT: 'sprout',       // 0 < P <= 0.15
  SAPLING: 'sapling',     // 0.15 < P <= 0.50
  MATURING: 'maturing',   // 0.50 < P < 1.0
  BLOOM: 'bloom',         // P >= 1.0 (full flourish celebration)
};

/**
 * The growth ladder. `maxInclusive` is the participation upper bound, so the
 * ladder is checked in order and the FIRST match wins:
 *   P = 0        -> seed      (exactly zero participation)
 *   P <= 0.15    -> sprout
 *   P <= 0.50    -> sapling
 *   P < 1.00     -> maturing
 *   P = 1.00     -> bloom     (checked by short-circuit, see below)
 *
 * BLOOM is reached only at exactly P = 1.0, so its `maxInclusive` mirrors
 * MATURING and is never the deciding rung — `stageForParticipation` returns it
 * before the loop for `ratio >= 1`.
 */
export const STAGE_LADDER = [
  { name: TREE_STAGES.SEED, label: 'Hạt giống', maxInclusive: 0.0, maxDepth: 0 },
  { name: TREE_STAGES.SPROUT, label: 'Mầm non', maxInclusive: 0.15, maxDepth: 1 },
  { name: TREE_STAGES.SAPLING, label: 'Cây non', maxInclusive: 0.50, maxDepth: 3 },
  { name: TREE_STAGES.MATURING, label: 'Cây trưởng thành', maxInclusive: 1.0, maxDepth: 5 },
  { name: TREE_STAGES.BLOOM, label: 'Đơm hoa kết trái', maxInclusive: 1.0, maxDepth: 7 },
];

/** The maximum recursion depth of the final stage — the `P = 1.0` target. */
export const MAX_BRANCH_DEPTH = STAGE_LADDER[STAGE_LADDER.length - 1].maxDepth;

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Resolves the growth stage for a participation ratio. */
export function stageForParticipation(p) {
  const ratio = clamp(Number.isFinite(p) ? p : 0, 0, 1.0);
  // A fully-participating class is the one and only flourish state.
  if (ratio >= 1.0) return STAGE_LADDER[STAGE_LADDER.length - 1];
  for (const stage of STAGE_LADDER) {
    if (ratio <= stage.maxInclusive) return stage;
  }
  return STAGE_LADDER[STAGE_LADDER.length - 1];
}

/** Parses a timestamp that may be an ISO string, a Date, or epoch millis. */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Vitality `V ∈ [0.2, 1.0]`.
 *
 * A class that answers promptly keeps a bright, saturated canopy; one that
 * dribbles in answers right at the deadline dulls it. With k = 0 there is no
 * evidence to judge, so V defaults to a full 1.0 rather than punishing an empty
 * session.
 *
 * Elapsed time is floored at 0 (a clock skew must not *inflate* vitality past
 * the honest value) but deliberately NOT capped: submissions past the limit push
 * V below 0.4 toward the 0.2 floor, which is the intent of the clamp.
 */
export function computeVitality({ submissions, createdAt, timeLimitMinutes }) {
  const k = submissions.length;
  if (k === 0) return 1.0;

  const createdMs = toMillis(createdAt);
  if (createdMs === null) return 1.0;

  const maxSeconds = Math.max(Number(timeLimitMinutes) || 0, 0) * 60;
  if (maxSeconds <= 0) return 1.0;

  let total = 0;
  let counted = 0;
  for (const submission of submissions) {
    const submittedMs = toMillis(submission.submitted_at ?? submission.submittedAt);
    if (submittedMs === null) continue;
    total += Math.max(0, (submittedMs - createdMs) / 1000);
    counted += 1;
  }
  // No usable timestamps -> no evidence, so do not degrade the tree.
  if (counted === 0) return 1.0;

  const avgSubmissionTime = total / counted;
  return clamp(1.0 - (avgSubmissionTime / maxSeconds) * 0.6, 0.2, 1.0);
}

/* =====================================================================
   D. Dewdrop anchor placement
   ===================================================================== */

/**
 * The spec's per-dewdrop radius formula, in PIXELS:
 *   radius = baseRadius + clamp(wordCount / 12, 1.5, 6)
 * A longer answer radiates further; the clamp keeps a very long answer from
 * crowding its neighbours (a class full of long answers would otherwise have to
 * shrink every anchor, punishing everyone).
 */
export function dewdropRadiusPx(wordCount) {
  const words = Number.isFinite(Number(wordCount)) ? Number(wordCount) : 0;
  return BASE_FRUIT_RADIUS + clamp(words / 12, 1.5, 6);
}

/** Back-compat alias for the Phase 7.2 name. */
export const fruitRadiusPx = dewdropRadiusPx;

/**
 * Places one anchor per submission inside the canopy ellipse.
 *
 * Strategy: rejection-sample initial positions (no trigonometry, so the result
 * is exactly reproducible), then run a deterministic relaxation that pushes
 * overlapping pairs apart. Convergence is guaranteed by first SHRINKING the
 * radii if the roster is too dense to pack, so a large class degrades dewdrop
 * size rather than producing an overlapping mess.
 */
function placeAnchors(submissions, rand) {
  const count = submissions.length;
  if (count === 0) return [];

  // Desired radii, converted from pixels to normalised units.
  const desired = submissions.map(
    (submission) => dewdropRadiusPx(submission.word_count ?? submission.wordCount) / NOMINAL_MIN_DIM,
  );

  // Packing feasibility: shrink uniformly when the roster cannot fit. The
  // cushion factor (~1.35x radius) is the gap the relaxation needs to converge.
  const canopyArea = Math.PI * CANOPY.rx * CANOPY.ry * 0.5;
  const neededArea = desired.reduce((sum, r) => sum + Math.PI * (r * 1.35) ** 2, 0);
  const fitScale = clamp(Math.sqrt(canopyArea / Math.max(neededArea, 1e-9)), 0.35, 1);
  const radii = desired.map((r) => r * fitScale);

  // --- seed positions (rejection sampling inside the ellipse) --------------
  const xs = new Array(count);
  const ys = new Array(count);
  for (let i = 0; i < count; i += 1) {
    let px = CANOPY.cx;
    let py = CANOPY.cy;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const cx = CANOPY.cx + (rand() * 2 - 1) * CANOPY.rx;
      const cy = CANOPY.cy + (rand() * 2 - 1) * CANOPY.ry;
      const nx = (cx - CANOPY.cx) / CANOPY.rx;
      const ny = (cy - CANOPY.cy) / CANOPY.ry;
      if (nx * nx + ny * ny <= 1) {
        px = cx;
        py = cy;
        break;
      }
    }
    xs[i] = px;
    ys[i] = py;
  }

  // --- deterministic relaxation -------------------------------------------
  // Fixed pair order (i<j) and a fixed iteration count: same inputs -> same
  // output, bit for bit. `Math.sqrt`, never `Math.hypot`.
  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
    let moved = false;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = xs[j] - xs[i];
        let dy = ys[j] - ys[i];
        const minDist = radii[i] + radii[j] + ANCHOR_GAP;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= minDist) continue;

        // Coincident pair: nudge along a fixed axis so the direction is defined.
        if (dist < 1e-9) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const push = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        xs[i] -= ux * push;
        ys[i] -= uy * push;
        xs[j] += ux * push;
        ys[j] += uy * push;
        moved = true;
      }
    }

    // Keep every centre far enough inside the ellipse that `centre ± radius`
    // still lies within the canvas bounding box.
    for (let i = 0; i < count; i += 1) {
      const limitX = Math.max(CANOPY.rx - radii[i], 1e-6);
      const limitY = Math.max(CANOPY.ry - radii[i], 1e-6);
      let nx = (xs[i] - CANOPY.cx) / limitX;
      let ny = (ys[i] - CANOPY.cy) / limitY;
      const norm = Math.sqrt(nx * nx + ny * ny);
      if (norm > 1) {
        nx /= norm;
        ny /= norm;
        xs[i] = CANOPY.cx + nx * limitX;
        ys[i] = CANOPY.cy + ny * limitY;
        moved = true;
      }
    }

    if (!moved) break;
  }

  return submissions.map((submission, i) => ({
    id: submission.id ?? null,
    student_code: submission.student_code ?? submission.studentCode ?? '',
    student_name: submission.student_name ?? submission.studentName ?? '',
    word_count: Number(submission.word_count ?? submission.wordCount) || 0,
    fruit_index: Number(submission.fruit_index ?? submission.fruitIndex) || i + 1,
    // Final radius AFTER any density shrink — the value the non-overlap
    // guarantee is stated against.
    radius: radii[i],
    base_radius: desired[i],
    nx: xs[i],
    ny: ys[i],
  }));
}

/* =====================================================================
   E. computeTreeState — the pure state entry point
   ===================================================================== */

/**
 * Derives the complete, deterministic visual state for a tree session.
 *
 * @param {object}   input
 * @param {number}   input.totalStudents      Class size `N` (floored at 1).
 * @param {object[]} input.submissions        One entry per submitted answer.
 * @param {number}   input.timeLimitMinutes   Session window.
 * @param {string|Date|number} input.createdAt
 * @param {number}   input.seed               `tree_seed`.
 * @returns {object} State including `anchors` in normalised coordinates.
 *
 * Purity note: this function reads no clock and no RNG other than the seeded
 * PRNG, so identical arguments always yield a deeply equal result.
 */
export function computeTreeState({
  totalStudents,
  submissions,
  timeLimitMinutes,
  createdAt,
  seed,
} = {}) {
  const list = Array.isArray(submissions) ? submissions.filter(Boolean) : [];
  const k = list.length;
  const n = Math.max(Number(totalStudents) || 0, 1);
  const participation = Math.min(k / n, 1.0);

  const stage = stageForParticipation(participation);
  const vitality = computeVitality({ submissions: list, createdAt, timeLimitMinutes });

  const themeIndex = themeIndexForSeed(seed);
  const theme = THEMES[themeIndex];

  // Order the anchors by fruit_index (then student_code) so the placement is a
  // function of the DATA, not of the array's incidental ordering.
  const ordered = list
    .slice()
    .sort((a, b) => {
      const fa = Number(a.fruit_index ?? a.fruitIndex) || 0;
      const fb = Number(b.fruit_index ?? b.fruitIndex) || 0;
      if (fa !== fb) return fa - fb;
      return String(a.student_code ?? '').localeCompare(String(b.student_code ?? ''));
    });

  const rand = createPRNG(seed);
  const anchors = placeAnchors(ordered, rand);

  return {
    seed: Number(seed) || 0,
    themeIndex,
    theme,
    k,
    n,
    participation,
    stage: stage.name,
    stageLabel: stage.label,
    maxDepth: stage.maxDepth,
    // Phase 8.2 — the whole-class celebration flag. True only at P = 1.0.
    isFlourished: participation >= 1.0,
    vitality,
    anchors,
  };
}

/* =====================================================================
   F. Pixel layout + hit testing (pure, so they are testable headless)
   ===================================================================== */

/**
 * Maps normalised anchors to pixels.
 *
 * A SINGLE uniform `scale` is used for both axes (letterboxed by `ox`/`oy`)
 * precisely so that normalised separation is preserved in pixels — a per-axis
 * scale would squash the canopy and could introduce overlaps on a wide canvas.
 */
export function layoutDewdropAnchors(anchors, width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const scale = Math.min(w, h);
  const ox = (w - scale) / 2;
  const oy = (h - scale) / 2;

  return anchors.map((anchor) => ({
    ...anchor,
    x: ox + anchor.nx * scale,
    y: oy + anchor.ny * scale,
    pixelRadius: Math.max(2, anchor.radius * scale),
  }));
}

/** Back-compat alias for the Phase 7.2 name. */
export const layoutFruitAnchors = layoutDewdropAnchors;

/**
 * Finds the dewdrop under a point, or null.
 *
 * Iterates last-to-first so the most recently drawn (visually topmost) dewdrop
 * wins, matching what the user perceives when two hitboxes just touch.
 * Squared distances only — no `sqrt`, so it stays exact and cheap.
 */
export function hitTestDewdrops(anchors, mouseX, mouseY) {
  const px = Number(mouseX);
  const py = Number(mouseY);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

  for (let i = anchors.length - 1; i >= 0; i -= 1) {
    const anchor = anchors[i];
    const dx = px - anchor.x;
    const dy = py - anchor.y;
    if (dx * dx + dy * dy <= anchor.pixelRadius * anchor.pixelRadius) return anchor;
  }
  return null;
}

/** Back-compat alias for the Phase 7.2 name. */
export const hitTestFruits = hitTestDewdrops;

/* =====================================================================
   G. TreeRenderer
   ===================================================================== */

/**
 * Canvas 2D renderer.
 *
 * The constructor is the only DOM boundary: it captures `canvas` and its 2D
 * context, and does nothing else, so a headless caller can supply a stub.
 */
export class TreeRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.options = {
      branchWidth: 7,
      width: 800,
      height: 600,
      ...options,
    };
    this.animFrameId = null;
    this.time = 0;
    /** Clickable/tappable dewdrop hitboxes in PIXELS, populated by `render()`. */
    this.fruitAnchors = [];
    this._treeData = null;
    this._tips = [];
    this._theme = THEMES[0];
    this._vitality = 1;
    this._stage = TREE_STAGES.SEED;
    this._showFoliage = false;
    this._isFlourished = false;
    this._w = this.options.width;
    this._h = this.options.height;
  }

  /** Phase 8.2 name for the hitbox cache; same array as `fruitAnchors`. */
  get dewdropAnchors() {
    return this.fruitAnchors;
  }

  /** Fits the backing store to the element so retina/4K displays stay crisp. */
  resize() {
    if (!this.canvas) return { width: 0, height: 0 };
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const cssWidth = this.canvas.clientWidth || this.options.width;
    const cssHeight = this.canvas.clientHeight || this.options.height;

    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    if (this.ctx && typeof this.ctx.setTransform === 'function') {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width: cssWidth, height: cssHeight };
  }

  /* ---------------- private drawing helpers ---------------- */

  /** Sky gradient backdrop. */
  _drawBackdrop(ctx, w, h, theme) {
    ctx.clearRect(0, 0, w, h);
    if (typeof ctx.createLinearGradient === 'function') {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, theme.sky[0]);
      sky.addColorStop(1, theme.sky[1]);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /**
   * Layered, gently curved soil mound the plant grows out of.
   * @returns {number} The ground line Y the trunk/seed sits on.
   */
  _drawSoil(ctx, w, h, theme) {
    const groundY = h * 0.88;
    ctx.fillStyle = theme.soil[0];
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + h * 0.06, w * 0.36, h * 0.10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.soil[1];
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + h * 0.10, w * 0.30, h * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    // A soft nutrient ridge so the mound reads as rich soil, not a grey blob.
    ctx.fillStyle = theme.leaf;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + h * 0.015, w * 0.30, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return groundY;
  }

  /** A dormant seed nestled in the mound (P = 0). */
  _drawSeed(ctx, w, groundY, theme) {
    const seedRx = w * 0.030;
    const seedRy = w * 0.021;
    // Soft dormant vitality: a slow breath that never fully fades.
    const breath = 0.42 + Math.abs(Math.sin(this.time * 1.2)) * 0.12;
    if (typeof ctx.createRadialGradient === 'function') {
      const glow = ctx.createRadialGradient(w / 2, groundY, 0, w / 2, groundY, seedRx * 3);
      glow.addColorStop(0, theme.fruitGlow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = breath;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(w / 2, groundY, seedRx * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = theme.trunkDark;
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY, seedRx, seedRy, 0.3, 0, Math.PI * 2);
    ctx.fill();
    // Inner seam: the hint of the crack the sprout will split open.
    ctx.strokeStyle = theme.trunk;
    ctx.lineWidth = Math.max(1, w * 0.003);
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY, seedRx * 0.62, seedRy * 0.62, 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** A tender stalk with two drooping cotyledon leaves (0 < P <= 0.15). */
  _drawSprout(ctx, w, groundY, theme) {
    const stalkTop = groundY - w * 0.055;
    const breeze = Math.sin(this.time) * w * 0.006;
    ctx.strokeStyle = theme.leaf;
    ctx.lineWidth = Math.max(2, w * 0.006);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w / 2, groundY);
    ctx.quadraticCurveTo(w / 2 + breeze, groundY - w * 0.030, w / 2, stalkTop);
    ctx.stroke();

    // Two cotyledon leaves, angling out and drooping tenderly.
    const leafR = w * 0.026;
    this._foliagePuff(ctx, w / 2 - leafR * 0.95, stalkTop + leafR * 0.20, leafR, theme, 0.95);
    this._foliagePuff(ctx, w / 2 + leafR * 0.95, stalkTop + leafR * 0.20, leafR, theme, 0.95);

    // Central budding tip.
    ctx.fillStyle = theme.leafAlt;
    ctx.beginPath();
    ctx.arc(w / 2, stalkTop - leafR * 0.18, leafR * 0.34, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * A cluster of overlapping translucent circles with a soft radial gradient —
   * the volumetric "foliage puff" primitive shared by the sprout and canopy.
   */
  _foliagePuff(ctx, x, y, radius, theme, alphaScale = 1) {
    const blobs = [
      [0, 0, 1.0, 0.72],
      [-0.62, 0.34, 0.74, 0.55],
      [0.60, 0.26, 0.70, 0.60],
    ];
    const vitality = this._vitality ?? 1;
    for (const [ox, oy, scale, alpha] of blobs) {
      const bx = x + ox * radius;
      const by = y + oy * radius;
      const br = radius * scale;
      if (typeof ctx.createRadialGradient === 'function') {
        const grad = ctx.createRadialGradient(bx - br * 0.3, by - br * 0.3, br * 0.1, bx, by, br);
        grad.addColorStop(0, theme.leafAlt);
        grad.addColorStop(1, theme.leaf);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = theme.leaf;
      }
      ctx.globalAlpha = clamp(alpha * alphaScale * (0.7 + vitality * 0.3), 0.15, 0.95);
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** One five-petal pastel blossom with a golden pistil. */
  _drawFlower(ctx, x, y, radius, theme) {
    const petals = 5;
    ctx.fillStyle = theme.leafAlt;
    for (let i = 0; i < petals; i += 1) {
      const angle = (i / petals) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(angle) * radius * 0.7, y + Math.sin(angle) * radius * 0.7, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The P = 1.0 celebration: blossoms + drifting golden sparkles on the canopy. */
  _drawBloom(ctx, w, theme) {
    const tips = this._tips;
    if (tips.length === 0) return;
    const count = Math.min(tips.length, 14);

    for (let i = 0; i < count; i += 1) {
      const tip = tips[i];
      this._drawFlower(ctx, tip.x, tip.y - w * 0.012, Math.max(6, w * 0.012), theme);
    }
    for (let i = 0; i < count; i += 1) {
      const tip = tips[(i * 3) % tips.length];
      const phase = this.time * 2 + i;
      const sr = Math.max(1.5, w * 0.0035);
      ctx.fillStyle = '#fde68a';
      ctx.globalAlpha = 0.5 + 0.45 * Math.abs(Math.sin(phase * 1.7));
      ctx.beginPath();
      ctx.arc(tip.x + Math.sin(phase) * w * 0.03, tip.y - w * 0.03 - (i % 3) * w * 0.012, sr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** The branch + foliage pass for SAPLING / MATURING / BLOOM. */
  _drawCanopy(ctx, w, h, groundY, treeData, theme) {
    const branchPRNG = createPRNG((treeData.seed >>> 0) ^ 0x9e3779b9);
    // Gentle idle breeze; `time` only advances via startAnimation().
    const swayOffset = Math.sin(this.time * 0.8) * 1.4;
    const trunkLength = h * (0.16 + 0.1 * treeData.participation);
    this.drawBranch(w / 2, groundY, trunkLength, -Math.PI / 2, 0, treeData.maxDepth, branchPRNG, swayOffset);
    if (this._isFlourished) this._drawBloom(ctx, w, theme);
  }

  /** Recursive branch pass. Collects leaf tips and paints terminal foliage. */
  drawBranch(x, y, length, angle, depth, maxDepth, branchPRNG, swayOffset) {
    const ctx = this.ctx;
    const theme = this._theme || THEMES[0];
    if (!ctx || depth > maxDepth || length < 1) return;

    // Branch width tapers with depth; sway grows toward the tips.
    const sway = swayOffset * (depth + 1) * 1.6;
    const endX = x + Math.cos(angle) * length + sway;
    const endY = y + Math.sin(angle) * length;

    // Organic curvature: the trunk leader stays straight, deeper branches bow
    // under a trigonometric breeze. The END point is unchanged, so tip (and thus
    // bloom) placement stays a pure function of the seed.
    const curve = depth === 0 ? 0 : Math.sin(this.time * 1.3 + depth) * length * 0.1;
    const ctrlX = x + Math.cos(angle) * length * 0.5 - Math.sin(angle) * curve + sway * 0.6;
    const ctrlY = y + Math.sin(angle) * length * 0.5 + Math.cos(angle) * curve;

    ctx.strokeStyle = depth <= 1 ? theme.trunkDark : theme.trunk;
    ctx.lineWidth = Math.max(1, (maxDepth - depth + 1) * this.options.branchWidth * 0.35);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + sway * 0.6, y);
    if (typeof ctx.quadraticCurveTo === 'function') {
      ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
    } else {
      ctx.lineTo(endX, endY);
    }
    ctx.stroke();

    if (depth === maxDepth) {
      this._tips.push({ x: endX, y: endY, depth });
      // Terminal foliage puff — only once the tree has a canopy to speak of.
      if (this._showFoliage) {
        const radius = Math.max(7, (this._w || this.options.width) * 0.026 * (0.8 + (this._vitality ?? 1) * 0.4));
        this._foliagePuff(ctx, endX, endY, radius, theme);
      }
      return;
    }

    // Trunk (depth 0) continues as a single leader; branches split in two.
    const childCount = depth === 0 ? 1 : 2;
    for (let i = 0; i < childCount; i += 1) {
      const bias = childCount === 1 ? 0 : i === 0 ? -0.38 : 0.38;
      const spread = bias + (branchPRNG() * 2 - 1) * 0.34;
      const shrink = 0.68 + branchPRNG() * 0.12;
      this.drawBranch(
        endX,
        endY,
        length * shrink,
        angle + spread,
        depth + 1,
        maxDepth,
        branchPRNG,
        swayOffset,
      );
    }
  }

  /**
   * Draws one knowledge dewdrop: an ethereal glow ring, a translucent teardrop
   * with a specular highlight, and (when highlighted) a pulsing golden halo.
   * Radiance scales with vitality and with the submission's word count (via the
   * anchor's radius).
   */
  drawDewdrop(ctx, x, y, dewdropData, theme, isHighlighted) {
    if (!ctx) return;
    const palette = theme || THEMES[0];
    const radius = Math.max(2, dewdropData.pixelRadius ?? dewdropData.radius ?? 8);
    const vitality = this._vitality ?? 1;

    // 1. Outer ethereal glow ring — brighter with vitality, brighter again when
    //    highlighted (the student's own droplet or an inspected one).
    const glowScale = isHighlighted ? 2.4 : 1.6;
    const glowRadius = radius * glowScale * (0.7 + vitality * 0.5);
    if (typeof ctx.createRadialGradient === 'function') {
      const glow = ctx.createRadialGradient(x, y, radius * 0.2, x, y, glowRadius);
      glow.addColorStop(0, palette.fruitGlow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Translucent teardrop body: a bulbous base drawn up to a pointed tip.
    const tipY = y - radius * 1.7;
    ctx.fillStyle = palette.fruit;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    if (typeof ctx.bezierCurveTo === 'function') {
      ctx.bezierCurveTo(x + radius * 1.3, y - radius * 0.5, x + radius * 1.0, y + radius * 0.9, x, y + radius * 0.95);
      ctx.bezierCurveTo(x - radius * 1.0, y + radius * 0.9, x - radius * 1.3, y - radius * 0.5, x, tipY);
    } else {
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // 3. Inner luminous core + specular highlight (white dot top-left).
    ctx.fillStyle = palette.fruitAlt;
    ctx.beginPath();
    ctx.arc(x, y + radius * 0.15, Math.max(1, radius * 0.45), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x - radius * 0.34, y - radius * 0.18, Math.max(0.8, radius * 0.24), 0, Math.PI * 2);
    ctx.fill();

    // 4. Pulsing golden halo for the highlighted droplet.
    if (isHighlighted) {
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(this.time * 3));
      ctx.strokeStyle = `rgba(251,191,36,${pulse.toFixed(3)})`;
      ctx.lineWidth = Math.max(2, radius * 0.28);
      ctx.beginPath();
      ctx.arc(x, y + radius * 0.15, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Back-compat alias for the Phase 7.2 name. */
  drawFruit(ctx, x, y, fruitData, theme, isHighlighted) {
    this.drawDewdrop(ctx, x, y, fruitData, theme, isHighlighted);
  }

  /** Full render pass for a state produced by `computeTreeState()`. */
  render(treeData) {
    const ctx = this.ctx;
    if (!ctx || !treeData) return;

    this._treeData = treeData;
    this._theme = treeData.theme || THEMES[0];
    this._vitality = treeData.vitality ?? 1;
    this._stage = treeData.stage || TREE_STAGES.SEED;
    this._isFlourished = treeData.isFlourished === true;
    this._tips = [];

    const { width, height } = this.resize();
    const w = width || this.options.width;
    const h = height || this.options.height;
    const theme = this._theme;
    this._w = w;
    this._h = h;

    // Foliage only makes sense once there is a canopy to hang it on.
    this._showFoliage = this._stage === TREE_STAGES.SAPLING
      || this._stage === TREE_STAGES.MATURING
      || this._stage === TREE_STAGES.BLOOM;

    this._drawBackdrop(ctx, w, h, theme);
    const groundY = this._drawSoil(ctx, w, h, theme);

    // --- stage-specific plant artwork -------------------------------------
    if (this._stage === TREE_STAGES.SEED) {
      this._drawSeed(ctx, w, groundY, theme);
      this.fruitAnchors = [];
      return;
    }
    if (this._stage === TREE_STAGES.SPROUT) {
      this._drawSprout(ctx, w, groundY, theme);
    } else {
      this._drawCanopy(ctx, w, h, groundY, treeData, theme);
    }

    // --- knowledge dewdrops ------------------------------------------------
    this.fruitAnchors = layoutDewdropAnchors(treeData.anchors, w, h);
    this.fruitAnchors.forEach((anchor) => {
      this.drawDewdrop(ctx, anchor.x, anchor.y, anchor, theme, anchor.id === this._highlightId);
    });
  }

  /** Interactive hit-test for tapping/hovering a knowledge dewdrop. */
  getDewdropAt(mouseX, mouseY) {
    return hitTestDewdrops(this.fruitAnchors, mouseX, mouseY);
  }

  /** Back-compat alias for the Phase 7.2 name. */
  getFruitAt(mouseX, mouseY) {
    return this.getDewdropAt(mouseX, mouseY);
  }

  /** Highlights one dewdrop by id/student_code on the next render. */
  setHighlight(id) {
    this._highlightId = id;
    if (this._treeData) this.render(this._treeData);
  }

  /** Gentle idle breeze. No-ops where `requestAnimationFrame` is unavailable. */
  startAnimation(treeData) {
    this.stopAnimation();
    this._treeData = treeData;
    if (typeof requestAnimationFrame !== 'function') return;

    const step = () => {
      this.time += 1 / 60;
      this.render(this._treeData);
      this.animFrameId = requestAnimationFrame(step);
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  stopAnimation() {
    if (this.animFrameId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animFrameId);
    }
    this.animFrameId = null;
  }
}
