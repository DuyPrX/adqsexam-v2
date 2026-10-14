/**
 * ADQS Exam v2 — Tree of Knowledge procedural renderer (Phase 7.2 / 8.2 / Botanical 3D Clay Upgrade)
 * =====================================================================
 * Drop-in replacement for:
 *   - web/src/lib/tree-engine.js
 *   - student/tree-engine.js
 */

/* =====================================================================
   Constants
   ===================================================================== */

export const NOMINAL_MIN_DIM = 520;
export const BASE_FRUIT_RADIUS = 9;

const CANOPY = { cx: 0.5, cy: 0.44, rx: 0.42, ry: 0.32 };
const ANCHOR_GAP = 0.012;
const RELAX_ITERATIONS = 240;

/* =====================================================================
   A. Seeded PRNG — Mulberry32
   ===================================================================== */

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
   B. Palettes & Botanical Archetypes — 4 distinct species chosen by `seed % 4`
   ===================================================================== */

export const THEMES = [
  {
    index: 0,
    key: 'orchard',
    name: 'Cây Quả Mọng',
    label: 'Đại Thụ Táo Đỏ',
    trunk: '#8c5830',
    trunkDark: '#4a2c14',
    trunkLight: '#ba8252',
    leafShadow: '#064e3b',
    leaf: '#10b981',
    leafAlt: '#6ee7b7',
    flowerPetal: '#fff1f2',
    flowerAlt: '#fda4af',
    flowerCenter: '#facc15',
    fruit: '#e11d48',
    fruitAlt: '#fda4af',
    fruitGlow: 'rgba(244, 63, 94, 0.65)',
    sky: ['#122236', '#070b12'],
    soil: ['#7c4d2b', '#432818'],
    grass: ['#84cc16', '#365314'],
    shapeConfig: {
      trunkWidthScale: 1.25,
      trunkHeightScale: 0.96,
      trunkCurve1: -0.04,
      trunkCurve2: 0.03,
      topLeanX: 0.0,
      rootFlare: 1.45,
      barkStyle: 'hollow_oak',
      leafShape: 'ovate',
      domeAspectY: 0.86,
      flowerType: 'apple5',
      fruitType: 'apple',
      clusters: [
        { ox: -0.155, oy: 0.72, r: 0.118, branchFrom: 0.46, branchThick: 0.62 },
        { ox:  0.155, oy: 0.68, r: 0.114, branchFrom: 0.42, branchThick: 0.60 },
        { ox:  0.000, oy: 1.02, r: 0.168, branchFrom: 0.82, branchThick: 0.75, isMain: true },
      ],
    },
  },
  {
    index: 1,
    key: 'sakura',
    name: 'Cây Anh Đào',
    label: 'Anh Đào Cherry',
    trunk: '#63364d',
    trunkDark: '#331826',
    trunkLight: '#995d7b',
    leafShadow: '#831843',
    leaf: '#ec4899',
    leafAlt: '#fbcfe8',
    flowerPetal: '#ffffff',
    flowerAlt: '#fce7f3',
    flowerCenter: '#e11d48',
    fruit: '#be123c',
    fruitAlt: '#fda4af',
    fruitGlow: 'rgba(251, 113, 133, 0.65)',
    sky: ['#22132a', '#09060e'],
    soil: ['#6e473b', '#3e2723'],
    grass: ['#65a30d', '#365314'],
    shapeConfig: {
      trunkWidthScale: 0.84,
      trunkHeightScale: 1.02,
      trunkCurve1: -0.10,
      trunkCurve2: 0.16,
      topLeanX: 0.06,
      rootFlare: 1.25,
      barkStyle: 'lenticels',
      leafShape: 'sakura_petal',
      domeAspectY: 0.72,
      flowerType: 'sakura5',
      fruitType: 'double_cherry',
      clusters: [
        { ox: -0.160, oy: 0.64, r: 0.098, branchFrom: 0.42, branchThick: 0.48 },
        { ox:  0.180, oy: 0.60, r: 0.096, branchFrom: 0.38, branchThick: 0.46 },
        { ox: -0.065, oy: 0.90, r: 0.118, branchFrom: 0.68, branchThick: 0.52 },
        { ox:  0.075, oy: 1.02, r: 0.142, branchFrom: 0.85, branchThick: 0.58, isMain: true },
      ],
    },
  },
  {
    index: 2,
    key: 'autumn',
    name: 'Cây Mùa Thu',
    label: 'Tùng Bonsai Hồng Nhật',
    trunk: '#7c4722',
    trunkDark: '#3d200c',
    trunkLight: '#b57445',
    leafShadow: '#14532d',
    leaf: '#16a34a',
    leafAlt: '#86efac',
    flowerPetal: '#fffbeb',
    flowerAlt: '#fef3c7',
    flowerCenter: '#f59e0b',
    fruit: '#ea580c',
    fruitAlt: '#fdba74',
    fruitGlow: 'rgba(249, 115, 22, 0.65)',
    sky: ['#231a12', '#0a0806'],
    soil: ['#784e2f', '#432818'],
    grass: ['#65a30d', '#365314'],
    shapeConfig: {
      trunkWidthScale: 1.15,
      trunkHeightScale: 0.98,
      trunkCurve1: -0.22,
      trunkCurve2: 0.20,
      topLeanX: -0.02,
      rootFlare: 1.65,
      barkStyle: 'bonsai_knots',
      leafShape: 'pine_fan',
      domeAspectY: 0.38,
      flowerType: 'camellia6',
      fruitType: 'persimmon',
      clusters: [
        { ox: -0.195, oy: 0.48, r: 0.108, branchFrom: 0.32, branchThick: 0.55 },
        { ox:  0.185, oy: 0.62, r: 0.105, branchFrom: 0.48, branchThick: 0.52 },
        { ox: -0.155, oy: 0.78, r: 0.098, branchFrom: 0.64, branchThick: 0.48 },
        { ox:  0.145, oy: 0.90, r: 0.092, branchFrom: 0.76, branchThick: 0.45 },
        { ox: -0.015, oy: 1.06, r: 0.128, branchFrom: 0.92, branchThick: 0.55, isMain: true },
      ],
    },
  },
  {
    index: 3,
    key: 'mystic',
    name: 'Cây Thần Tiên',
    label: 'Linh Mộc Tinh Cầu',
    trunk: '#4c3575',
    trunkDark: '#24173d',
    trunkLight: '#8b6fc4',
    leafShadow: '#0f4c5c',
    leaf: '#06b6d4',
    leafAlt: '#a5f3fc',
    flowerPetal: '#f472b6',
    flowerAlt: '#fef08a',
    flowerCenter: '#fde047',
    fruit: '#a855f7',
    fruitAlt: '#f3e8ff',
    fruitGlow: 'rgba(168, 85, 247, 0.72)',
    sky: ['#151830', '#070913'],
    soil: ['#523b6e', '#281c38'],
    grass: ['#2dd4bf', '#0f766e'],
    shapeConfig: {
      trunkWidthScale: 1.18,
      trunkHeightScale: 1.00,
      trunkCurve1: 0.0,
      trunkCurve2: 0.0,
      topLeanX: 0.0,
      rootFlare: 1.80,
      barkStyle: 'runes',
      leafShape: 'diamond',
      domeAspectY: 1.06,
      flowerType: 'star4',
      fruitType: 'mystic_orb',
      clusters: [
        { ox: -0.180, oy: 0.56, r: 0.080, branchFrom: 0.36, branchThick: 0.45 },
        { ox:  0.180, oy: 0.56, r: 0.080, branchFrom: 0.36, branchThick: 0.45 },
        { ox: -0.145, oy: 0.84, r: 0.088, branchFrom: 0.62, branchThick: 0.48 },
        { ox:  0.145, oy: 0.84, r: 0.088, branchFrom: 0.62, branchThick: 0.48 },
        { ox:  0.000, oy: 1.02, r: 0.148, branchFrom: 0.85, branchThick: 0.65, isMain: true },
      ],
    },
  },
];

export function themeIndexForSeed(seed) {
  const n = Number(seed);
  if (!Number.isFinite(n)) return 0;
  return ((Math.trunc(n) % 4) + 4) % 4;
}

export function themeForSeed(seed) {
  return THEMES[themeIndexForSeed(seed)];
}

/* =====================================================================
   B.2 Team seeds (Phase 8.4 — 4-team competition arena)
   ===================================================================== */

export const TEAM_NUMBERS = [1, 2, 3, 4];

export function getTeamSeed(baseSeed, teamNumber) {
  const team = clampTeamNumber(teamNumber);
  return ((Number(baseSeed) || 0) + team * 7919) >>> 0;
}

export function clampTeamNumber(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 1;
  return n < 1 ? 1 : n > 4 ? 4 : n;
}

/* =====================================================================
   C. Growth mathematics
   ===================================================================== */

export const TREE_STAGES = {
  SEED: 'seed',
  SPROUT: 'sprout',
  SAPLING: 'sapling',
  MATURING: 'maturing',
  BLOOM: 'bloom',
};

export const STAGE_LADDER = [
  { name: TREE_STAGES.SEED, label: 'Hạt giống', maxInclusive: 0.0, maxDepth: 0 },
  { name: TREE_STAGES.SPROUT, label: 'Mầm non', maxInclusive: 0.15, maxDepth: 1 },
  { name: TREE_STAGES.SAPLING, label: 'Cây non', maxInclusive: 0.50, maxDepth: 3 },
  { name: TREE_STAGES.MATURING, label: 'Cây trưởng thành', maxInclusive: 1.0, maxDepth: 5 },
  { name: TREE_STAGES.BLOOM, label: 'Đơm hoa kết trái', maxInclusive: 1.0, maxDepth: 7 },
];

export const MAX_BRANCH_DEPTH = STAGE_LADDER[STAGE_LADDER.length - 1].maxDepth;

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function stageForParticipation(p) {
  const ratio = clamp(Number.isFinite(p) ? p : 0, 0, 1.0);
  if (ratio >= 1.0) return STAGE_LADDER[STAGE_LADDER.length - 1];
  for (const stage of STAGE_LADDER) {
    if (ratio <= stage.maxInclusive) return stage;
  }
  return STAGE_LADDER[STAGE_LADDER.length - 1];
}

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
  if (counted === 0) return 1.0;

  const avgSubmissionTime = total / counted;
  return clamp(1.0 - (avgSubmissionTime / maxSeconds) * 0.6, 0.2, 1.0);
}

/* =====================================================================
   D. Dewdrop anchor placement
   ===================================================================== */

export function dewdropRadiusPx(wordCount) {
  const words = Number.isFinite(Number(wordCount)) ? Number(wordCount) : 0;
  return BASE_FRUIT_RADIUS + clamp(words / 12, 1.5, 6);
}

export const fruitRadiusPx = dewdropRadiusPx;

function placeAnchors(submissions, rand) {
  const count = submissions.length;
  if (count === 0) return [];

  const desired = submissions.map(
    (submission) => dewdropRadiusPx(submission.word_count ?? submission.wordCount) / NOMINAL_MIN_DIM,
  );

  const canopyArea = Math.PI * CANOPY.rx * CANOPY.ry * 0.5;
  const neededArea = desired.reduce((sum, r) => sum + Math.PI * (r * 1.35) ** 2, 0);
  const fitScale = clamp(Math.sqrt(canopyArea / Math.max(neededArea, 1e-9)), 0.35, 1);
  const radii = desired.map((r) => r * fitScale);

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

  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
    let moved = false;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = xs[j] - xs[i];
        let dy = ys[j] - ys[i];
        const minDist = radii[i] + radii[j] + ANCHOR_GAP;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= minDist) continue;

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
    radius: radii[i],
    base_radius: desired[i],
    nx: xs[i],
    ny: ys[i],
  }));
}

/* =====================================================================
   E. computeTreeState — the pure state entry point
   ===================================================================== */

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
    isFlourished: participation >= 1.0,
    vitality,
    anchors,
  };
}

/* =====================================================================
   F. Pixel layout + hit testing (pure, so they are testable headless)
   ===================================================================== */

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

export const layoutFruitAnchors = layoutDewdropAnchors;

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

export const hitTestFruits = hitTestDewdrops;

/* =====================================================================
   G. TreeRenderer — 3D Claymorphism + 4 Botanical Species
   ===================================================================== */

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
    this._smoothParticipation = null;
    this._prevAnchorCount = 0;
    this._bounce = 0;
    this._highlightId = null;
  }

  get dewdropAnchors() {
    return this.fruitAnchors;
  }

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

  _drawBackdrop(ctx, w, h, theme) {
    ctx.clearRect(0, 0, w, h);
    if (typeof ctx.createRadialGradient === 'function') {
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.58, h * 0.05, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      bg.addColorStop(0, theme.sky[0]);
      bg.addColorStop(1, theme.sky[1]);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = theme.sky[1];
      ctx.fillRect(0, 0, w, h);
    }
  }

  _drawSoil(ctx, w, h, theme, participation = 0) {
    const groundY = h * 0.85;
    const unit = Math.min(w, h);
    const moundRx = unit * 0.29;
    const moundRy = unit * 0.062;

    if (typeof ctx.createRadialGradient === 'function') {
      const sh = ctx.createRadialGradient(w / 2, groundY + moundRy * 0.65, moundRx * 0.1, w / 2, groundY + moundRy * 0.65, moundRx * 1.25);
      sh.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
      sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.ellipse(w / 2, groundY + moundRy * 0.65, moundRx * 1.25, moundRy * 1.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (typeof ctx.createLinearGradient === 'function') {
      const sideGrad = ctx.createLinearGradient(w / 2 - moundRx, groundY, w / 2 + moundRx, groundY);
      sideGrad.addColorStop(0, theme.soil[1]);
      sideGrad.addColorStop(0.45, theme.soil[0]);
      sideGrad.addColorStop(1, '#23140b');
      ctx.fillStyle = sideGrad;
    } else {
      ctx.fillStyle = theme.soil[0];
    }
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + moundRy * 0.25, moundRx, moundRy * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();

    const grassFactor = smoothstep(0.35, 0.70, participation);
    if (typeof ctx.createRadialGradient === 'function') {
      const topGrad = ctx.createRadialGradient(
        w / 2 - moundRx * 0.2,
        groundY - moundRy * 0.2,
        moundRx * 0.08,
        w / 2,
        groundY,
        moundRx * 0.95,
      );
      if (grassFactor > 0.35 && theme.grass) {
        topGrad.addColorStop(0, theme.grass[0]);
        topGrad.addColorStop(1, theme.grass[1]);
      } else {
        topGrad.addColorStop(0, theme.soil[0]);
        topGrad.addColorStop(1, theme.soil[1]);
      }
      ctx.fillStyle = topGrad;
    } else {
      ctx.fillStyle = theme.soil[0];
    }
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY - moundRy * 0.08, moundRx * 0.94, moundRy * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();

    return groundY;
  }

  /** 4 Species-Specific Leaf Morphologies (`ovate`, `pine_fan`, `diamond`, `sakura_petal`) */
  _drawClayLeafScale(ctx, x, y, rot, size, theme, isGlowingSprout = false) {
    if (size <= 0.8) return;
    const leafShape = isGlowingSprout ? 'ovate' : (theme.shapeConfig?.leafShape || 'ovate');
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    if (leafShape === 'pine_fan' && typeof ctx.createLinearGradient === 'function') {
      ctx.fillStyle = 'rgba(4, 12, 8, 0.42)';
      ctx.beginPath();
      ctx.ellipse(0, size * 0.1, size * 0.95, size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();

      const needleCount = 5;
      for (let n = 0; n < needleCount; n += 1) {
        const nAng = ((n / (needleCount - 1)) - 0.5) * 1.35;
        ctx.save();
        ctx.rotate(nAng);
        const nGrad = ctx.createLinearGradient(0, -size, 0, size * 0.3);
        nGrad.addColorStop(0, theme.leafAlt);
        nGrad.addColorStop(0.55, theme.leaf);
        nGrad.addColorStop(1, theme.leafShadow || theme.trunkDark);
        ctx.fillStyle = nGrad;
        ctx.beginPath();
        ctx.ellipse(0, -size * 0.35, size * 0.22, size * 0.68, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(4, 10, 8, 0.40)';
    ctx.beginPath();
    ctx.ellipse(0, size * 0.16, size * 0.68, size * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();

    if (typeof ctx.createRadialGradient === 'function') {
      const grad = ctx.createRadialGradient(-size * 0.22, -size * 0.32, size * 0.08, 0, 0, size * 1.05);
      if (isGlowingSprout) {
        grad.addColorStop(0, '#e0f2fe');
        grad.addColorStop(0.5, '#67e8f9');
        grad.addColorStop(1, '#0d9488');
      } else {
        grad.addColorStop(0, theme.leafAlt);
        grad.addColorStop(0.55, theme.leaf);
        grad.addColorStop(1, theme.leafShadow || theme.trunkDark);
      }
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = theme.leaf;
    }

    ctx.beginPath();
    if (leafShape === 'diamond') {
      ctx.moveTo(0, -size * 1.08);
      ctx.lineTo(size * 0.68, -size * 0.08);
      ctx.lineTo(0, size * 0.85);
      ctx.lineTo(-size * 0.68, -size * 0.08);
      ctx.closePath();
    } else if (leafShape === 'sakura_petal' && typeof ctx.bezierCurveTo === 'function') {
      ctx.moveTo(0, -size * 1.05);
      ctx.bezierCurveTo(size * 0.62, -size * 0.45, size * 0.55, size * 0.60, 0, size * 0.85);
      ctx.bezierCurveTo(-size * 0.55, size * 0.60, -size * 0.62, -size * 0.45, 0, -size * 1.05);
    } else if (typeof ctx.bezierCurveTo === 'function') {
      ctx.moveTo(0, -size * 0.92);
      ctx.bezierCurveTo(size * 0.88, -size * 0.45, size * 0.80, size * 0.68, 0, size * 0.85);
      ctx.bezierCurveTo(-size * 0.80, size * 0.68, -size * 0.88, -size * 0.45, 0, -size * 0.92);
    } else {
      ctx.arc(0, 0, size * 0.75, 0, Math.PI * 2);
    }
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = Math.max(0.8, size * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.62);
    ctx.lineTo(0, size * 0.45);
    ctx.stroke();

    ctx.restore();
  }

  /** 4 Species-Specific Signature Fruits (`apple`, `double_cherry`, `persimmon`, `mystic_orb`) */
  _drawSignatureFruit(ctx, x, y, radius, theme) {
    if (radius <= 1.2 || typeof ctx.createRadialGradient !== 'function') return;
    const fruitType = theme.shapeConfig?.fruitType || 'apple';
    ctx.save();
    ctx.translate(x, y);

    if (fruitType === 'apple') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.beginPath();
      ctx.arc(0, radius * 0.25, radius * 1.02, 0, Math.PI * 2);
      ctx.fill();

      const aGrad = ctx.createRadialGradient(-radius * 0.3, -radius * 0.3, radius * 0.1, 0, 0, radius * 1.1);
      aGrad.addColorStop(0, '#fda4af');
      aGrad.addColorStop(0.35, '#ef4444');
      aGrad.addColorStop(1, '#881337');
      ctx.fillStyle = aGrad;

      ctx.beginPath();
      ctx.moveTo(0, -radius * 0.78);
      ctx.bezierCurveTo(radius * 1.15, -radius * 1.05, radius * 1.22, radius * 0.75, 0, radius * 0.95);
      ctx.bezierCurveTo(-radius * 1.22, radius * 0.75, -radius * 1.15, -radius * 1.05, 0, -radius * 0.78);
      ctx.fill();

      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = Math.max(1.5, radius * 0.18);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -radius * 0.72);
      ctx.quadraticCurveTo(radius * 0.15, -radius * 1.25, radius * 0.35, -radius * 1.32);
      ctx.stroke();

      ctx.fillStyle = '#4ade80';
      ctx.beginPath();
      ctx.ellipse(radius * 0.42, -radius * 1.02, radius * 0.45, radius * 0.22, -0.35, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.beginPath();
      ctx.ellipse(-radius * 0.38, -radius * 0.25, radius * 0.20, radius * 0.32, 0.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (fruitType === 'double_cherry') {
      const rCherry = radius * 0.72;
      ctx.strokeStyle = '#65a30d';
      ctx.lineWidth = Math.max(1.4, radius * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-rCherry * 0.95, rCherry * 0.65);
      ctx.quadraticCurveTo(-rCherry * 0.3, -rCherry * 0.6, 0, -rCherry * 1.45);
      ctx.quadraticCurveTo(rCherry * 0.4, -rCherry * 0.5, rCherry * 0.95, rCherry * 0.85);
      ctx.stroke();

      ctx.fillStyle = '#84cc16';
      ctx.beginPath();
      ctx.ellipse(rCherry * 0.3, -rCherry * 1.45, rCherry * 0.48, rCherry * 0.22, 0.3, 0, Math.PI * 2);
      ctx.fill();

      [[-rCherry * 0.95, rCherry * 0.78], [rCherry * 0.95, rCherry * 0.95]].forEach(([cx, cy]) => {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(cx, cy + 2, rCherry, 0, Math.PI * 2);
        ctx.fill();

        const cGrad = ctx.createRadialGradient(cx - rCherry * 0.3, cy - rCherry * 0.3, 1, cx, cy, rCherry);
        cGrad.addColorStop(0, '#fda4af');
        cGrad.addColorStop(0.35, '#e11d48');
        cGrad.addColorStop(1, '#4c0519');
        ctx.fillStyle = cGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, rCherry, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(cx - rCherry * 0.32, cy - rCherry * 0.28, rCherry * 0.24, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (fruitType === 'persimmon') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, radius * 0.35, radius * 1.12, radius * 0.90, 0, 0, Math.PI * 2);
      ctx.fill();

      const pGrad = ctx.createRadialGradient(-radius * 0.3, -radius * 0.2, 1, 0, 0, radius * 1.15);
      pGrad.addColorStop(0, '#fef08a');
      pGrad.addColorStop(0.35, '#f97316');
      pGrad.addColorStop(1, '#9a3412');
      ctx.fillStyle = pGrad;
      ctx.beginPath();
      ctx.ellipse(0, radius * 0.15, radius * 1.08, radius * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#15803d';
      for (let c = 0; c < 4; c += 1) {
        ctx.save();
        ctx.translate(0, -radius * 0.52);
        ctx.rotate((c / 4) * Math.PI * 2 + 0.4);
        ctx.beginPath();
        ctx.ellipse(radius * 0.36, 0, radius * 0.42, radius * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.ellipse(-radius * 0.4, -radius * 0.05, radius * 0.25, radius * 0.16, -0.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const glow = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 2.1);
      glow.addColorStop(0, 'rgba(253, 224, 71, 0.75)');
      glow.addColorStop(1, 'rgba(168, 85, 247, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2.1, 0, Math.PI * 2);
      ctx.fill();

      const mGrad = ctx.createRadialGradient(-radius * 0.25, -radius * 0.25, 1, 0, 0, radius);
      mGrad.addColorStop(0, '#ffffff');
      mGrad.addColorStop(0.4, '#fde047');
      mGrad.addColorStop(1, '#ca8a04');
      ctx.fillStyle = mGrad;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.92, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(165, 243, 252, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.45, radius * 0.42, -0.35, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawSeed(ctx, w, groundY, theme) {
    const unit = Math.min(w, this._h || w);
    const seedRx = unit * 0.036;
    const seedRy = unit * 0.025;
    const breath = 0.48 + Math.abs(Math.sin(this.time * 1.5)) * 0.22;

    if (typeof ctx.createRadialGradient === 'function') {
      const glow = ctx.createRadialGradient(w / 2, groundY - seedRy, 0, w / 2, groundY - seedRy, seedRx * 3.4);
      glow.addColorStop(0, theme.fruitGlow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = breath;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(w / 2, groundY - seedRy, seedRx * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = theme.trunk;
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY - seedRy * 0.3, seedRx, seedRy, 0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSprout(ctx, w, groundY, theme) {
    const unit = Math.min(w, this._h || w);
    const stalkH = unit * 0.14;
    const stalkTop = groundY - stalkH;
    const breeze = Math.sin(this.time * 1.8) * unit * 0.008;

    if (typeof ctx.createRadialGradient === 'function') {
      const aura = ctx.createRadialGradient(w / 2, stalkTop, 2, w / 2, stalkTop, unit * 0.16);
      aura.addColorStop(0, 'rgba(103, 232, 249, 0.28)');
      aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(w / 2, stalkTop, unit * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = Math.max(4, unit * 0.018);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(w / 2, groundY);
    if (typeof ctx.quadraticCurveTo === 'function') {
      ctx.quadraticCurveTo(w / 2 + breeze, groundY - stalkH * 0.5, w / 2 + breeze * 1.2, stalkTop);
    } else {
      ctx.lineTo(w / 2, stalkTop);
    }
    ctx.stroke();

    const leafSize = unit * 0.042;
    this._drawClayLeafScale(ctx, w / 2 + breeze - leafSize * 0.65, stalkTop, -1.05, leafSize, theme, true);
    this._drawClayLeafScale(ctx, w / 2 + breeze + leafSize * 0.65, stalkTop, 1.05, leafSize, theme, true);
  }

  _foliagePuff(ctx, x, y, radius, theme, isMainDome = false) {
    if (radius <= 2) return;
    const aspectY = theme.shapeConfig?.domeAspectY || 0.85;

    ctx.fillStyle = theme.leafShadow || theme.trunkDark;
    ctx.beginPath();
    ctx.ellipse(x, y + radius * aspectY * 0.08, radius * 0.90, radius * aspectY * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();

    const rings = isMainDome ? 3 : 2;
    const baseLeafSize = radius * (isMainDome ? 0.29 : 0.35);

    for (let r = rings; r >= 0; r -= 1) {
      const ringDist = (r / rings) * radius * 0.82;
      const count = r === 0 ? 1 : r * 6;
      for (let i = 0; i < count; i += 1) {
        const ang = (i / count) * Math.PI * 2 + r * 0.52;
        const lx = x + Math.cos(ang) * ringDist;
        const ly = y + Math.sin(ang) * ringDist * aspectY;
        const scale = 1 - (r / (rings + 2)) * 0.14;
        const rot = aspectY < 0.55 ? Math.cos(ang) * 0.45 : ang + Math.PI / 2;
        this._drawClayLeafScale(ctx, lx, ly, rot, baseLeafSize * scale, theme, false);
      }
    }
  }

  _drawFlower(ctx, x, y, radius, theme, isBud = false, isAlt = false) {
    if (radius <= 1) return;
    const flowerType = theme.shapeConfig?.flowerType || 'apple5';
    ctx.save();
    ctx.translate(x, y);

    if (isBud) {
      if (typeof ctx.createRadialGradient === 'function') {
        const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, radius * 1.8);
        glow.addColorStop(0, 'rgba(254, 240, 138, 0.65)');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.45, radius * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.arc(0, radius * 0.22, radius * 0.95, 0, Math.PI * 2);
    ctx.fill();

    const petalColor = isAlt ? (theme.flowerAlt || '#fef08a') : (theme.flowerPetal || '#ff80ab');
    const petals = flowerType === 'camellia6' ? 6 : (flowerType === 'star4' ? 4 : 5);

    for (let i = 0; i < petals; i += 1) {
      ctx.save();
      ctx.rotate((i / petals) * Math.PI * 2);
      ctx.fillStyle = petalColor;
      ctx.beginPath();

      if (flowerType === 'sakura5' && typeof ctx.bezierCurveTo === 'function') {
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-radius * 0.5, -radius * 0.35, -radius * 0.45, -radius * 1.05, -radius * 0.14, -radius * 1.12);
        ctx.lineTo(0, -radius * 0.88);
        ctx.lineTo(radius * 0.14, -radius * 1.12);
        ctx.bezierCurveTo(radius * 0.45, -radius * 1.05, radius * 0.5, -radius * 0.35, 0, 0);
      } else if (flowerType === 'star4' && typeof ctx.quadraticCurveTo === 'function') {
        ctx.moveTo(0, -radius * 1.28);
        ctx.quadraticCurveTo(radius * 0.32, -radius * 0.32, 0, 0);
        ctx.quadraticCurveTo(-radius * 0.32, -radius * 0.32, 0, -radius * 1.28);
      } else {
        ctx.ellipse(0, -radius * 0.58, radius * 0.44, radius * 0.56, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }

    if (flowerType === 'camellia6') {
      for (let i = 0; i < 6; i += 1) {
        ctx.save();
        ctx.rotate(((i + 0.5) / 6) * Math.PI * 2);
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.ellipse(0, -radius * 0.34, radius * 0.26, radius * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.fillStyle = theme.flowerCenter || '#facc15';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.34, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawBloomAndFruits(ctx, w, groundY, theme, participation) {
    const tips = this._tips;
    if (tips.length === 0) return;

    const unit = Math.min(w, this._h || w);
    const aspectY = theme.shapeConfig?.domeAspectY || 0.85;
    const flowerRadius = Math.max(5.5, unit * 0.024);
    const isBlooming = participation >= 0.65 || this._isFlourished;
    const fruitMaturity = smoothstep(0.72, 0.96, participation);

    tips.forEach((tip, idx) => {
      const domeR = tip.domeRadius || unit * 0.11;

      const flowerSlots = [
        { ang: -Math.PI * 0.5, dist: 0.22 },
        { ang: -Math.PI * 0.82, dist: 0.62 },
        { ang: -Math.PI * 0.18, dist: 0.62 },
      ];
      flowerSlots.forEach((slot, fIdx) => {
        const fx = tip.x + Math.cos(slot.ang) * domeR * slot.dist;
        const fy = tip.y + Math.sin(slot.ang) * domeR * slot.dist * aspectY;
        this._drawFlower(ctx, fx, fy, flowerRadius, theme, !isBlooming, (fIdx + idx) % 2 === 0);
      });

      if (fruitMaturity > 0.02) {
        const fruitRadius = Math.max(6.5, unit * 0.029) * fruitMaturity;
        const fruitSlots = tip.isMain ? [-0.68, 0.0, 0.68] : [-0.52, 0.52];

        fruitSlots.forEach((xRatio, rIdx) => {
          const rx = tip.x + xRatio * domeR * 0.85;
          const ry = tip.y + domeR * aspectY * (rIdx === 1 ? 0.35 : 0.62);
          this._drawSignatureFruit(ctx, rx, ry, fruitRadius, theme);
        });
      }
    });

    if (participation >= 0.85) {
      const gScale = smoothstep(0.85, 1.0, participation) * flowerRadius * 0.72;
      const groundSpots = [[-0.16, 0.005], [-0.08, 0.022], [0.10, 0.018], [0.18, -0.005]];
      groundSpots.forEach(([gx, gy], gIdx) => {
        this._drawFlower(ctx, w / 2 + gx * unit, groundY + gy * unit, gScale, theme, false, gIdx % 2 === 0);
      });
    }

    const sparkleCount = isBlooming ? 14 : 6;
    for (let i = 0; i < sparkleCount; i += 1) {
      const tip = tips[i % tips.length];
      const phase = this.time * 1.8 + i * 1.3;
      const sx = tip.x + Math.cos(phase * 0.7) * unit * 0.16;
      const sy = tip.y + Math.sin(phase) * unit * 0.10;
      const sr = Math.max(2, unit * 0.0055);

      ctx.fillStyle = '#fde047';
      ctx.globalAlpha = 0.45 + 0.5 * Math.abs(Math.sin(phase * 2));
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawBarkDetails(ctx, pointOnTrunk, trunkW, trunkH, theme, growthNorm) {
    if (growthNorm < 0.35) return;
    const barkStyle = theme.shapeConfig?.barkStyle || 'hollow_oak';
    const midPt = pointOnTrunk(0.45);

    ctx.save();
    if (barkStyle === 'hollow_oak') {
      const hr = trunkW * 0.42;
      ctx.fillStyle = theme.trunkLight || theme.trunk;
      ctx.beginPath();
      ctx.ellipse(midPt.x, midPt.y, hr * 1.25, hr * 1.55, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#1e1108';
      ctx.beginPath();
      ctx.ellipse(midPt.x, midPt.y, hr * 0.85, hr * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (barkStyle === 'lenticels') {
      ctx.strokeStyle = 'rgba(255, 228, 230, 0.32)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      [0.22, 0.36, 0.52, 0.66].forEach((t, i) => {
        const pt = pointOnTrunk(t);
        const dir = i % 2 === 0 ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(pt.x - trunkW * 0.35, pt.y);
        ctx.lineTo(pt.x + dir * trunkW * 0.42, pt.y);
        ctx.stroke();
      });
    } else if (barkStyle === 'bonsai_knots') {
      [0.32, 0.62].forEach((t, i) => {
        const pt = pointOnTrunk(t);
        const kx = pt.x + (i === 0 ? -trunkW * 0.25 : trunkW * 0.22);
        ctx.fillStyle = theme.trunkDark;
        ctx.beginPath();
        ctx.ellipse(kx, pt.y, trunkW * 0.32, trunkW * 0.24, 0.3, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (barkStyle === 'runes' && typeof ctx.quadraticCurveTo === 'function') {
      const p1 = pointOnTrunk(0.15);
      const p2 = pointOnTrunk(0.45);
      const p3 = pointOnTrunk(0.72);
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(this.time * 3);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(p2.x - trunkW * 0.3, p2.y, p3.x, p3.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCanopy(ctx, w, h, groundY, treeData, theme) {
    const p = clamp(this._smoothParticipation ?? treeData.participation ?? 0.5, 0.15, 1.0);
    const unit = Math.min(w, h);
    const sway = Math.sin(this.time * 1.6) * unit * 0.008;
    const cfg = theme.shapeConfig || THEMES[0].shapeConfig;

    const growthNorm = smoothstep(0.12, 0.85, p);
    const trunkH = unit * (0.20 + 0.25 * growthNorm) * (cfg.trunkHeightScale || 1.0);
    const trunkW = unit * (0.022 + 0.030 * growthNorm) * (cfg.trunkWidthScale || 1.0);

    const baseX = w / 2;
    const ctrl1X = baseX + unit * cfg.trunkCurve1 * growthNorm;
    const ctrl1Y = groundY - trunkH * 0.36;
    const ctrl2X = baseX + unit * cfg.trunkCurve2 * growthNorm;
    const ctrl2Y = groundY - trunkH * 0.70;
    const topX = baseX + unit * cfg.topLeanX * growthNorm + sway;
    const topY = groundY - trunkH;

    const pointOnTrunk = (t) => {
      const mt = 1 - t;
      return {
        x: mt * mt * mt * baseX + 3 * mt * mt * t * ctrl1X + 3 * mt * t * t * ctrl2X + t * t * t * topX,
        y: mt * mt * mt * groundY + 3 * mt * mt * t * ctrl1Y + 3 * mt * t * t * ctrl2Y + t * t * t * topY,
      };
    };

    if (typeof ctx.createLinearGradient === 'function') {
      const tGrad = ctx.createLinearGradient(baseX - trunkW * 2, groundY, baseX + trunkW * 2, groundY);
      tGrad.addColorStop(0, theme.trunkLight || theme.trunk);
      tGrad.addColorStop(0.5, theme.trunk);
      tGrad.addColorStop(1, theme.trunkDark);
      ctx.fillStyle = tGrad;
    } else {
      ctx.fillStyle = theme.trunk;
    }

    ctx.beginPath();
    ctx.moveTo(baseX - trunkW * cfg.rootFlare, groundY + 4);
    if (typeof ctx.bezierCurveTo === 'function') {
      ctx.bezierCurveTo(
        ctrl1X - trunkW * 0.75, ctrl1Y,
        ctrl2X - trunkW * 0.50, ctrl2Y,
        topX - trunkW * 0.28, topY,
      );
      ctx.lineTo(topX + trunkW * 0.28, topY);
      ctx.bezierCurveTo(
        ctrl2X + trunkW * 0.50, ctrl2Y,
        ctrl1X + trunkW * 0.75, ctrl1Y,
        baseX + trunkW * cfg.rootFlare, groundY + 4,
      );
    } else {
      ctx.lineTo(topX, topY);
      ctx.lineTo(baseX + trunkW, groundY);
    }
    ctx.closePath();
    ctx.fill();

    this._drawBarkDetails(ctx, pointOnTrunk, trunkW, trunkH, theme, growthNorm);

    this._tips = cfg.clusters.map((cl) => {
      const attachPt = pointOnTrunk(cl.branchFrom);
      const tipX = baseX + cl.ox * unit * (0.65 + 0.35 * growthNorm) + sway * (0.6 + cl.oy * 0.4);
      const tipY = groundY - trunkH * cl.oy;
      const domeRadius = unit * cl.r * (0.55 + 0.45 * growthNorm);

      if (!cl.isMain) {
        ctx.strokeStyle = theme.trunk;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, trunkW * (cl.branchThick || 0.52));
        ctx.beginPath();
        ctx.moveTo(attachPt.x, attachPt.y);
        if (typeof ctx.quadraticCurveTo === 'function') {
          ctx.quadraticCurveTo(
            (attachPt.x + tipX) * 0.5,
            attachPt.y - unit * 0.02,
            tipX,
            tipY,
          );
        } else {
          ctx.lineTo(tipX, tipY);
        }
        ctx.stroke();
      }

      return { x: tipX, y: tipY, domeRadius, isMain: !!cl.isMain };
    });

    if (p <= 0.40) {
      const lSize = unit * 0.042;
      this._tips.forEach((tip) => {
        this._drawClayLeafScale(ctx, tip.x - lSize * 0.45, tip.y, -0.75, lSize, theme, false);
        this._drawClayLeafScale(ctx, tip.x + lSize * 0.45, tip.y, 0.75, lSize, theme, false);
      });
    } else {
      this._tips.forEach((tip) => {
        this._foliagePuff(ctx, tip.x, tip.y, tip.domeRadius, theme, tip.isMain);
      });
    }

    if (p >= 0.50 || this._isFlourished) {
      this._drawBloomAndFruits(ctx, w, groundY, theme, p);
    }
  }

  /** Backward compatibility for any test calling `drawBranch` directly */
  drawBranch(x, y, length, angle, depth, maxDepth, branchPRNG, swayOffset) {
    const ctx = this.ctx;
    const theme = this._theme || THEMES[0];
    if (!ctx || depth > maxDepth || length < 1) return;
    const sway = swayOffset * (depth + 1) * 1.2;
    const endX = x + Math.cos(angle) * length + sway;
    const endY = y + Math.sin(angle) * length;
    ctx.strokeStyle = theme.trunk;
    ctx.lineWidth = Math.max(1, (maxDepth - depth + 1) * 2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    if (depth === maxDepth) {
      this._tips.push({ x: endX, y: endY, depth });
    }
  }

  drawDewdrop(ctx, x, y, dewdropData, theme, isHighlighted, showNamePill = false) {
    if (!ctx) return;
    const palette = theme || THEMES[0];
    const radius = Math.max(2, dewdropData.pixelRadius ?? dewdropData.radius ?? 8);
    const vitality = this._vitality ?? 1;

    const bob = Math.sin(this.time * 2.4 + (dewdropData.fruit_index || 0)) * 2.2;
    const drawY = y + bob;

    const glowScale = isHighlighted ? 2.5 : 1.75;
    const glowRadius = radius * glowScale * (0.75 + vitality * 0.45);
    if (typeof ctx.createRadialGradient === 'function') {
      const glow = ctx.createRadialGradient(x, drawY, radius * 0.2, x, drawY, glowRadius);
      glow.addColorStop(0, palette.fruitGlow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, drawY, glowRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    const tipY = drawY - radius * 1.65;
    ctx.fillStyle = palette.fruit;
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    if (typeof ctx.bezierCurveTo === 'function') {
      ctx.bezierCurveTo(x + radius * 1.25, drawY - radius * 0.45, x + radius * 0.98, drawY + radius * 0.9, x, drawY + radius * 0.95);
      ctx.bezierCurveTo(x - radius * 0.98, drawY + radius * 0.9, x - radius * 1.25, drawY - radius * 0.45, x, tipY);
    } else {
      ctx.arc(x, drawY, radius, 0, Math.PI * 2);
    }
    ctx.fill();

    ctx.fillStyle = palette.fruitAlt;
    ctx.beginPath();
    ctx.arc(x, drawY + radius * 0.15, Math.max(1, radius * 0.45), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.arc(x - radius * 0.32, drawY - radius * 0.18, Math.max(0.9, radius * 0.24), 0, Math.PI * 2);
    ctx.fill();

    if (isHighlighted) {
      const pulse = 0.65 + 0.35 * Math.abs(Math.sin(this.time * 3.2));
      ctx.strokeStyle = `rgba(251,191,36,${pulse.toFixed(3)})`;
      ctx.lineWidth = Math.max(2, radius * 0.28);
      ctx.beginPath();
      ctx.arc(x, drawY + radius * 0.1, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    const rawName = dewdropData.student_name || '';
    if ((showNamePill || isHighlighted) && rawName && typeof ctx.fillText === 'function') {
      const parts = String(rawName).trim().split(/\s+/);
      const shortName = parts[parts.length - 1] || rawName;
      const label = `${shortName} 🌱`;

      ctx.save();
      ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
      const pillW = Math.max(54, label.length * 6.8 + 14);
      const pillH = 20;
      const px = x - pillW / 2;
      const py = drawY - radius * 2.4 - pillH;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.strokeStyle = isHighlighted ? '#fbbf24' : 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(px, py, pillW, pillH, 10);
      } else {
        ctx.rect(px, py, pillW, pillH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, py + 14);
      ctx.restore();
    }
  }

  drawFruit(ctx, x, y, fruitData, theme, isHighlighted) {
    this.drawDewdrop(ctx, x, y, fruitData, theme, isHighlighted);
  }

  render(treeData) {
    const ctx = this.ctx;
    if (!ctx || !treeData) return;

    this._treeData = treeData;
    this._theme = treeData.theme || THEMES[0];
    this._vitality = treeData.vitality ?? 1;
    this._stage = treeData.stage || TREE_STAGES.SEED;
    this._isFlourished = treeData.isFlourished === true;
    this._tips = [];

    const targetP = treeData.participation ?? 0;
    if (this._smoothParticipation === null) {
      this._smoothParticipation = targetP;
    } else {
      this._smoothParticipation += (targetP - this._smoothParticipation) * 0.08;
    }

    const anchorCount = Array.isArray(treeData.anchors) ? treeData.anchors.length : 0;
    if (anchorCount > this._prevAnchorCount && this._prevAnchorCount > 0) {
      this._bounce = 0.055;
    }
    this._prevAnchorCount = anchorCount;
    this._bounce = Math.max(0, this._bounce - 0.003);

    const { width, height } = this.resize();
    const w = width || this.options.width;
    const h = height || this.options.height;
    const theme = this._theme;
    this._w = w;
    this._h = h;

    this._showFoliage = this._stage === TREE_STAGES.SAPLING
      || this._stage === TREE_STAGES.MATURING
      || this._stage === TREE_STAGES.BLOOM;

    this._drawBackdrop(ctx, w, h, theme);
    const groundY = this._drawSoil(ctx, w, h, theme, this._smoothParticipation);

    if (this._stage === TREE_STAGES.SEED) {
      this._drawSeed(ctx, w, groundY, theme);
      this.fruitAnchors = [];
      return;
    }

    ctx.save();
    if (this._bounce > 0.001) {
      const bx = 1 + Math.sin(this.time * 24) * this._bounce;
      const by = 1 - Math.sin(this.time * 24) * this._bounce;
      ctx.translate(w / 2, groundY);
      ctx.scale(bx, by);
      ctx.translate(-w / 2, -groundY);
    }

    if (this._stage === TREE_STAGES.SPROUT) {
      this._drawSprout(ctx, w, groundY, theme);
    } else {
      this._drawCanopy(ctx, w, h, groundY, treeData, theme);
    }
    ctx.restore();

    this.fruitAnchors = layoutDewdropAnchors(treeData.anchors, w, h);
    const totalAnchors = this.fruitAnchors.length;
    this.fruitAnchors.forEach((anchor, idx) => {
      const isHighlight = anchor.id !== null && anchor.id === this._highlightId;
      const isRecent = totalAnchors > 0 && idx >= totalAnchors - 2;
      this.drawDewdrop(ctx, anchor.x, anchor.y, anchor, theme, isHighlight, isRecent);
    });
  }

  getDewdropAt(mouseX, mouseY) {
    return hitTestDewdrops(this.fruitAnchors, mouseX, mouseY);
  }

  getFruitAt(mouseX, mouseY) {
    return this.getDewdropAt(mouseX, mouseY);
  }

  setHighlight(id) {
    this._highlightId = id;
    if (this._treeData) this.render(this._treeData);
  }

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