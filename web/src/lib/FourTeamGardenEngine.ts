/**
 * MODULE: FourTeamGardenEngine.ts
 * Engine 2.5D dựng đồng thời 4 Cây chi tiết cao cho 4 Nhóm thi đua
 * Hỗ trợ 2 chế độ: Thu thập ý kiến (Brainstorming) & Trắc nghiệm chung đề (Quiz 2x/3x)
 */

export const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface TeamSpecies {
  id: 'bonsai' | 'sakura' | 'citrus' | 'mystic';
  teamDefaultName: string;
  badgeColor: string;
  trunkDark: string;
  trunkLight: string;
  canopyShadow: string;
  canopyMid: string;
  canopyHighlight: string;
  flowerPetal: string;
  flowerCenter: string;
  fruitMain: string;
  fruitGold: string;
  padStyle: 'cloud' | 'dome' | 'lush' | 'crystal';
}

export const TEAM_SPECIES: TeamSpecies[] = [
  {
    id: 'bonsai',
    teamDefaultName: 'Nhóm 1: Tùng Ngọc Lục',
    badgeColor: '#10b981',
    trunkDark: '#3f2e21',
    trunkLight: '#785a40',
    canopyShadow: '#064e3b',
    canopyMid: '#059669',
    canopyHighlight: '#34d399',
    flowerPetal: '#ecfdf5',
    flowerCenter: '#facc15',
    fruitMain: '#fb923c',
    fruitGold: '#fde047',
    padStyle: 'cloud' // Tán mây Bonsai dẹt ngang
  },
  {
    id: 'sakura',
    teamDefaultName: 'Nhóm 2: Anh Đào Sakura',
    badgeColor: '#f43f5e',
    trunkDark: '#3b1d2e',
    trunkLight: '#703854',
    canopyShadow: '#831843',
    canopyMid: '#db2777',
    canopyHighlight: '#f9a8d4',
    flowerPetal: '#fff1f2',
    flowerCenter: '#e11d48',
    fruitMain: '#be123c',
    fruitGold: '#fef08a',
    padStyle: 'dome' // Tán vòm tròn mềm mại
  },
  {
    id: 'citrus',
    teamDefaultName: 'Nhóm 3: Cam Mặt Trời',
    badgeColor: '#f59e0b',
    trunkDark: '#452612',
    trunkLight: '#854d27',
    canopyShadow: '#14532d',
    canopyMid: '#16a34a',
    canopyHighlight: '#86efac',
    flowerPetal: '#ffffff',
    flowerCenter: '#eab308',
    fruitMain: '#f97316',
    fruitGold: '#fef08a',
    padStyle: 'lush' // Tán xum xuê nhiều tầng
  },
  {
    id: 'mystic',
    teamDefaultName: 'Nhóm 4: Linh Mộc Tinh Vân',
    badgeColor: '#8b5cf6',
    trunkDark: '#1e1b4b',
    trunkLight: '#4338ca',
    canopyShadow: '#0f172a',
    canopyMid: '#0284c7',
    canopyHighlight: '#38bdf8',
    flowerPetal: '#e0e7ff',
    flowerCenter: '#c084fc',
    fruitMain: '#a855f7',
    fruitGold: '#67e8f9',
    padStyle: 'crystal' // Tán vươn cao huyền ảo
  }
];

export interface BranchConfig {
  startY: number;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
  r: number;
  delay: number;
}

export interface OrnamentConfig {
  bIdx: number;
  ox: number;
  oy: number;
  leafAngle: number;
  leafSize: number;
  threshold: number;
  hasFlower: boolean;
  hasFruit: boolean;
  delay: number;
}

export interface TreeLayout {
  branches: BranchConfig[];
  ornaments: OrnamentConfig[];
}

export interface Drop {
  x: number;
  y: number;
  targetY: number;
  vy: number;
  r: number;
  color: string;
  glow: string;
  isBad: boolean;
}

export interface Ripple {
  x: number;
  y: number;
  rx: number;
  ry: number;
  alpha: number;
  color: string;
}

export interface GrowthParams {
  growth: number;
  flowerRate: number;
  fruitRate: number;
  mutationRate: number;
  [key: string]: number;
}

export interface TeamState {
  index: number;
  name: string;
  species: TeamSpecies;
  scoreText: string;
  subText: string;
  isWinner: boolean;
  rank: number | null;
  target: GrowthParams;
  current: GrowthParams;
  bounce: number;
  shake: number;
  drops: Drop[];
  ripples: Ripple[];
  fallingPetals: any[];
  layout: TreeLayout;
}

export type DropType = 'dew' | 'nutrient' | 'sun' | 'rain';

export class FourTeamGardenEngine {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  teams: TeamState[];
  lastTime: number;
  isRunning: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2D context is not available');
    }
    this.ctx = context;

    this.teams = TEAM_SPECIES.map((spec, idx) => ({
      index: idx,
      name: spec.teamDefaultName,
      species: spec,
      scoreText: '0 / 10',
      subText: 'Đang chờ...',
      isWinner: false,
      rank: null,
      target: { growth: 0.06, flowerRate: 0, fruitRate: 0, mutationRate: 0 },
      current: { growth: 0.06, flowerRate: 0, fruitRate: 0, mutationRate: 0 },
      bounce: 0,
      shake: 0,
      drops: [],
      ripples: [],
      fallingPetals: [],
      layout: this.generateTreeLayout(idx + 1)
    }));

    this.lastTime = performance.now();
    this.isRunning = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  generateTreeLayout(seedInput: number): TreeLayout {
    let s = seedInput * 9973;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };

    const branches: BranchConfig[] = [
      { startY: 0.38, cx: -32, cy: -48, ex: -68, ey: -82, r: 0.58, delay: 0.00 },
      { startY: 0.46, cx:  36, cy: -54, ex:  72, ey: -88, r: 0.56, delay: 0.05 },
      { startY: 0.62, cx: -42, cy: -68, ex: -82, ey: -125, r: 0.50, delay: 0.10 },
      { startY: 0.70, cx:  40, cy: -72, ex:  78, ey: -132, r: 0.48, delay: 0.14 },
      { startY: 0.88, cx:   4, cy: -95, ex:   0, ey: -168, r: 0.44, delay: 0.18 }
    ];

    const ornaments: OrnamentConfig[] = [];
    branches.forEach((b, bIdx) => {
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * Math.PI * 2 + rand() * 0.5;
        const dist = 14 + rand() * 26;
        ornaments.push({
          bIdx,
          ox: Math.cos(angle) * dist * 1.25,
          oy: Math.sin(angle) * dist * 0.85,
          leafAngle: angle,
          leafSize: 13 + rand() * 7,
          threshold: (bIdx * 7 + i) / 35,
          hasFlower: i % 2 === 0,
          hasFruit: i % 3 === 0,
          delay: b.delay + i * 0.02
        });
      }
    });

    return { branches, ornaments };
  }

  // =================================================================
  // API TÍCH HỢP CHO 2 CHẾ ĐỘ CHƠI
  // =================================================================

  updateOpinionMode(
    teamIndex: number,
    {
      validSubmittedCount,
      totalMembers,
      wordCountRatio = 1,
      dropType = 'nutrient',
      isWinner = false
    }: {
      validSubmittedCount: number;
      totalMembers: number;
      wordCountRatio?: number;
      dropType?: DropType | null;
      isWinner?: boolean;
    }
  ) {
    const team = this.teams[teamIndex];
    if (!team) return;

    const completion = clamp(validSubmittedCount / Math.max(1, totalMembers), 0, 1);
    const qualityBonus = clamp((wordCountRatio - 0.8) / 0.8, 0, 1.3);

    team.target.growth = clamp(0.06 + completion * 0.94, 0.06, 1.0);
    team.target.flowerRate = completion > 0.4 ? clamp(completion * (0.7 + qualityBonus * 0.5), 0, 1.3) : 0;
    team.target.fruitRate = completion > 0.7 ? clamp((completion - 0.5) * 2 * (0.6 + qualityBonus * 0.6), 0, 1.3) : 0;
    team.target.mutationRate = clamp((wordCountRatio - 1.3) * 1.2, 0, 1);

    team.scoreText = `${validSubmittedCount} / ${totalMembers} Thành viên`;
    team.subText = completion >= 1 ? 'Đã hoàn thành 100%!' : `Chất lượng từ: ${Math.round(wordCountRatio * 100)}%`;
    team.isWinner = isWinner;

    if (dropType) this.spawnDrop(teamIndex, dropType);
  }

  updateQuizMode(
    teamIndex: number,
    {
      correctAnswers,
      totalMembers,
      multiplier = 3,
      comboStreak = 0,
      lastAnswerCorrect = true,
      isFastAnswer = false,
      isWinner = false
    }: {
      correctAnswers: number;
      totalMembers: number;
      multiplier?: number;
      comboStreak?: number;
      lastAnswerCorrect?: boolean | null;
      isFastAnswer?: boolean;
      isWinner?: boolean;
    }
  ) {
    const team = this.teams[teamIndex];
    if (!team) return;

    const targetTotal = Math.max(1, totalMembers * multiplier);
    const progress = clamp(correctAnswers / targetTotal, 0, 1);

    team.target.growth = clamp(0.06 + smoothstep(0.0, 0.60, progress) * 0.94, 0.06, 1.0);
    team.target.flowerRate = smoothstep(0.32, 0.78, progress) * 1.25;
    team.target.fruitRate = smoothstep(0.62, 1.00, progress) * 1.30;
    team.target.mutationRate = clamp(comboStreak / 10, 0, 1);

    team.scoreText = `${correctAnswers} / ${targetTotal} Câu đúng (${multiplier}x)`;
    team.subText = comboStreak >= 3 ? `🔥 Combo x${comboStreak}` : `Tiến độ: ${Math.round(progress * 100)}%`;
    team.isWinner = isWinner;

    if (lastAnswerCorrect === true) {
      this.spawnDrop(teamIndex, isFastAnswer ? 'sun' : 'dew');
    } else if (lastAnswerCorrect === false) {
      this.spawnDrop(teamIndex, 'rain');
    }
  }

  setTeamGrowth(teamIndex: number, growth: number) {
    const team = this.teams[teamIndex];
    if (!team) return;
    const g = clamp(growth, 0.06, 1.0);
    team.target.growth = g;
    team.target.flowerRate = g > 0.4 ? clamp((g - 0.4) * 2.0, 0, 1.3) : 0;
    team.target.fruitRate = g > 0.65 ? clamp((g - 0.65) * 3.0, 0, 1.3) : 0;
    team.target.mutationRate = g >= 1.0 ? 1 : 0;
    team.scoreText = `${Math.round(g * 100)}% Phát triển`;
    team.subText = g >= 1.0 ? 'Hoàn thành 100%!' : `Tiến độ: ${Math.round(g * 100)}%`;
    team.isWinner = g >= 1.0;
  }

  triggerWinner(teamIndex: number) {
    this.teams.forEach((t, i) => {
      t.isWinner = i === teamIndex;
    });
    const team = this.teams[teamIndex];
    if (team) {
      team.target.growth = 1.0;
      team.target.flowerRate = 1.25;
      team.target.fruitRate = 1.30;
      team.target.mutationRate = 1.0;
      team.scoreText = 'Chiến thắng 🏆';
      team.subText = 'Đạt đích đầu tiên!';
      this.spawnDrop(teamIndex, 'sun');
      this.spawnDrop(teamIndex, 'sun');
    }
  }

  resetAll() {
    this.teams.forEach((team) => {
      team.target = { growth: 0.06, flowerRate: 0, fruitRate: 0, mutationRate: 0 };
      team.current = { growth: 0.06, flowerRate: 0, fruitRate: 0, mutationRate: 0 };
      team.scoreText = '0 / 10';
      team.subText = 'Đang chờ...';
      team.isWinner = false;
      team.bounce = 0;
      team.shake = 0;
      team.drops = [];
      team.ripples = [];
    });
  }

  spawnDrop(teamIndex: number, type: DropType = 'dew') {
    const team = this.teams[teamIndex];
    if (!team) return;

    const styles: Record<DropType, { color: string; glow: string; isBad: boolean }> = {
      dew:      { color: '#38bdf8', glow: 'rgba(56, 189, 248, 0.5)', isBad: false },
      nutrient: { color: '#4ade80', glow: 'rgba(74, 222, 128, 0.5)', isBad: false },
      sun:      { color: '#facc15', glow: 'rgba(250, 204, 21, 0.65)', isBad: false },
      rain:     { color: '#94a3b8', glow: 'rgba(148, 163, 184, 0.3)', isBad: true }
    };
    const st = styles[type] || styles.dew;

    team.drops.push({
      x: (Math.random() - 0.5) * 65,
      y: -240 - Math.random() * 40,
      targetY: -6 + (Math.random() - 0.5) * 10,
      vy: 190 + Math.random() * 60,
      r: st.isBad ? 5 : 7.5,
      ...st
    });
  }

  // =================================================================
  // ĐỒ HỌA 2.5D CHI TIẾT CAO (VOLUMETRIC BOTANICAL ART)
  // =================================================================

  drawPot25D(ctx: CanvasRenderingContext2D, team: TeamState, timeSec: number) {
    const { species, isWinner } = team;

    // Hào quang chiến thắng dưới chân chậu
    const auraRadius = isWinner ? 115 + Math.sin(timeSec * 4) * 8 : 85;
    const auraGrad = ctx.createRadialGradient(0, 22, 8, 0, 22, auraRadius);
    auraGrad.addColorStop(0, isWinner ? 'rgba(250, 204, 21, 0.55)' : `${species.badgeColor}33`);
    auraGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = auraGrad;
    ctx.beginPath();
    ctx.ellipse(0, 22, auraRadius, auraRadius * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thân chậu gốm đổ bóng trụ 3 điểm
    const potGrad = ctx.createLinearGradient(-72, 0, 72, 0);
    potGrad.addColorStop(0, '#7c4728');
    potGrad.addColorStop(0.32, '#cc7a47');
    potGrad.addColorStop(0.72, '#a35c30');
    potGrad.addColorStop(1, '#5e3218');

    ctx.fillStyle = potGrad;
    ctx.beginPath();
    ctx.moveTo(-70, -5);
    ctx.lineTo(-56, 26);
    ctx.ellipse(0, 26, 56, 16, 0, Math.PI, 0, true);
    ctx.lineTo(70, -5);
    ctx.closePath();
    ctx.fill();

    // Dải màu nhận diện Nhóm quanh thân chậu
    ctx.strokeStyle = isWinner ? '#facc15' : species.badgeColor;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.ellipse(0, 10, 63, 17, 0, 0.08 * Math.PI, 0.92 * Math.PI);
    ctx.stroke();

    // Vành chậu 2.5D
    ctx.fillStyle = '#b86938';
    ctx.beginPath();
    ctx.ellipse(0, -4, 75, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#df8b56';
    ctx.beginPath();
    ctx.ellipse(0, -8, 75, 19, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mặt đất tơi xốp bên trong chậu
    const soilGrad = ctx.createRadialGradient(-12, -10, 5, 0, -8, 66);
    soilGrad.addColorStop(0, '#784e2f');
    soilGrad.addColorStop(0.7, '#4e301b');
    soilGrad.addColorStop(1, '#2e1b0e');
    ctx.fillStyle = soilGrad;
    ctx.beginPath();
    ctx.ellipse(0, -8, 66, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawFoliagePad(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rx: number,
    ry: number,
    species: TeamSpecies,
    scale: number,
    sway: number
  ) {
    if (scale <= 0.02) return;
    ctx.save();
    ctx.translate(x + sway, y);
    ctx.scale(scale, scale);

    // Lớp 1: Bóng tối đáy tán lá (Ambient Occlusion)
    ctx.fillStyle = species.canopyShadow;
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.22, rx * 1.02, ry * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();

    // Lớp 2: Khối tán lá trung gian (3 vòm đám mây)
    ctx.fillStyle = species.canopyMid;
    const puffs = [
      { ox: -rx * 0.38, oy: ry * 0.05, rX: rx * 0.65, rY: ry * 0.78 },
      { ox:  rx * 0.38, oy: ry * 0.05, rX: rx * 0.65, rY: ry * 0.78 },
      { ox:  0,         oy: -ry * 0.18, rX: rx * 0.78, rY: ry * 0.85 }
    ];
    puffs.forEach((pf) => {
      ctx.beginPath();
      ctx.ellipse(pf.ox, pf.oy, pf.rX, pf.rY, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Lớp 3: Ánh sáng đỉnh vòm lá (Top Rim Highlight)
    const hlGrad = ctx.createRadialGradient(-rx * 0.15, -ry * 0.45, 2, 0, -ry * 0.15, rx * 0.85);
    hlGrad.addColorStop(0, species.canopyHighlight);
    hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hlGrad;
    ctx.beginPath();
    ctx.ellipse(0, -ry * 0.2, rx * 0.72, ry * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawOrganicTrunk(
    ctx: CanvasRenderingContext2D,
    height: number,
    baseWidth: number,
    species: TeamSpecies,
    growth: number,
    wind: number
  ) {
    const topSway = wind * 3.5;
    const grad = ctx.createLinearGradient(-baseWidth, 0, baseWidth, 0);
    grad.addColorStop(0, species.trunkLight);
    grad.addColorStop(0.55, species.trunkDark);
    grad.addColorStop(1, '#1c120c');

    ctx.fillStyle = grad;
    ctx.beginPath();
    // Rễ trái xòe rộng ôm đất
    ctx.moveTo(-baseWidth * 1.45, 3);
    ctx.quadraticCurveTo(-baseWidth * 0.55, -height * 0.45, topSway - baseWidth * 0.22, -height);
    ctx.lineTo(topSway + baseWidth * 0.22, -height);
    // Rễ phải xòe rộng
    ctx.quadraticCurveTo(baseWidth * 0.55, -height * 0.45, baseWidth * 1.45, 3);
    // Đáy gốc chia thùy rễ
    ctx.quadraticCurveTo(baseWidth * 0.5, -1, 0, 4);
    ctx.quadraticCurveTo(-baseWidth * 0.5, -1, -baseWidth * 1.45, 3);
    ctx.closePath();
    ctx.fill();
  }

  drawSingleLeaf(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    size: number,
    color: string
  ) {
    if (size <= 0.8) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(size * 0.5, -size * 0.4, size, 0);
    ctx.quadraticCurveTo(size * 0.5, size * 0.4, 0, 0);
    ctx.fill();
    ctx.restore();
  }

  drawBlossom(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    species: TeamSpecies
  ) {
    if (scale <= 0.04) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    ctx.fillStyle = species.flowerPetal;
    for (let i = 0; i < 5; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.ellipse(5.2, 0, 5.2, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = species.flowerCenter;
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawGlowingFruit(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    species: TeamSpecies,
    isGold: boolean
  ) {
    if (radius <= 0.6) return;
    ctx.save();
    ctx.translate(x, y);

    const color = isGold ? species.fruitGold : species.fruitMain;
    if (isGold || species.id === 'mystic') {
      const glow = ctx.createRadialGradient(0, 0, radius * 0.3, 0, 0, radius * 2.1);
      glow.addColorStop(0, isGold ? 'rgba(253, 224, 71, 0.65)' : 'rgba(168, 85, 247, 0.45)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Đổ bóng khối cầu 2.5D
    const fGrad = ctx.createRadialGradient(-radius * 0.3, -radius * 0.3, radius * 0.1, 0, 0, radius);
    fGrad.addColorStop(0, '#ffffff');
    fGrad.addColorStop(0.25, color);
    fGrad.addColorStop(1, '#450a0a');
    ctx.fillStyle = fGrad;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  renderTeamStation(
    ctx: CanvasRenderingContext2D,
    team: TeamState,
    cx: number,
    cy: number,
    scale: number,
    timeSec: number
  ) {
    const { species, current, layout, isWinner } = team;
    const { growth, flowerRate, fruitRate, mutationRate } = current;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // Vẽ Chậu cây Isometric
    this.drawPot25D(ctx, team, timeSec);

    // Vẽ Sóng dinh dưỡng trên mặt đất
    team.ripples.forEach((rp) => {
      ctx.save();
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = Math.max(0, rp.alpha);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, rp.rx, rp.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });

    // Độ nảy đàn hồi & rung lắc
    const bounceX = 1 + Math.sin(timeSec * 28) * team.bounce;
    const bounceY = 1 - Math.sin(timeSec * 28) * team.bounce;
    const shakeOffset = Math.sin(timeSec * 45) * team.shake * 6;

    ctx.save();
    ctx.translate(shakeOffset, -8);
    ctx.scale(bounceX, bounceY);

    const wind = Math.sin(timeSec * 2.0 + team.index * 1.4);

    // GIAI ĐOẠN 1: Hạt mầm nứt vỏ (0.00 -> 0.25)
    const seedAlpha = 1 - smoothstep(0.18, 0.30, growth);
    if (seedAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = seedAlpha;
      const arch = smoothstep(0.02, 0.16, growth);
      ctx.strokeStyle = '#84cc16';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.quadraticCurveTo(5, -26 * arch, 14 * arch, -8 * arch);
      ctx.stroke();

      ctx.fillStyle = '#d99b66';
      ctx.beginPath();
      ctx.ellipse(-3, -2, 11, 8, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // GIAI ĐOẠN 2 -> 5: Thân, Cành, Tán lá đa tầng, Hoa & Quả
    if (growth > 0.12) {
      const trunkH = lerp(42, 148, smoothstep(0.12, 0.65, growth));
      const trunkW = lerp(3.5, 13, smoothstep(0.16, 0.75, growth));

      // A. Vẽ các vòm tán lá lớp nền (Back Volumetric Pads)
      if (growth > 0.35) {
        layout.branches.forEach((b) => {
          const bGrow = smoothstep(0.35 + b.delay, 0.62 + b.delay, growth);
          if (bGrow <= 0.01) return;
          const padRx = species.padStyle === 'cloud' ? 42 : 34;
          const padRy = species.padStyle === 'cloud' ? 16 : 26;
          this.drawFoliagePad(ctx, b.ex * bGrow, b.ey * bGrow - 8, padRx, padRy, species, bGrow * 0.9, wind * 3);
        });
      }

      // B. Vẽ Thân chính và Cành uốn
      this.drawOrganicTrunk(ctx, trunkH, trunkW, species, growth, wind);

      if (growth > 0.30) {
        layout.branches.forEach((b) => {
          const bGrow = smoothstep(0.30 + b.delay, 0.56 + b.delay, growth);
          if (bGrow <= 0.01) return;
          const sy = -trunkH * b.startY;
          ctx.strokeStyle = species.trunkDark;
          ctx.lineWidth = trunkW * b.r * bGrow;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(0, sy);
          ctx.quadraticCurveTo(
            b.cx * bGrow + wind * 2,
            sy + (b.cy - sy) * bGrow,
            b.ex * bGrow + wind * 3.5,
            b.ey * bGrow
          );
          ctx.stroke();
        });
      }

      // C. Lá mầm non ở Giai đoạn 2 (Sprout)
      const sproutAlpha = smoothstep(0.14, 0.25, growth) * (1 - smoothstep(0.38, 0.50, growth));
      if (sproutAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = sproutAlpha;
        this.drawSingleLeaf(ctx, wind * 2, -trunkH, -2.4, 24, species.canopyHighlight);
        this.drawSingleLeaf(ctx, wind * 2, -trunkH, -0.7, 24, species.canopyMid);
        ctx.restore();
      }

      // D. Vòm tán lá tiền cảnh + Chi tiết Lá rìa, Hoa, Quả
      if (growth > 0.36) {
        layout.branches.forEach((b) => {
          const bGrow = smoothstep(0.38 + b.delay, 0.66 + b.delay, growth);
          if (bGrow <= 0.01) return;
          const padRx = species.padStyle === 'cloud' ? 38 : 30;
          const padRy = species.padStyle === 'cloud' ? 14 : 22;
          this.drawFoliagePad(ctx, b.ex * bGrow, b.ey * bGrow, padRx, padRy, species, bGrow, wind * 4);
        });

        layout.ornaments.forEach((orn, idx) => {
          const b = layout.branches[orn.bIdx];
          const bGrow = smoothstep(0.38 + orn.delay, 0.65 + orn.delay, growth);
          if (bGrow <= 0.01) return;

          const ox = (b.ex + orn.ox) * bGrow + wind * 4;
          const oy = (b.ey + orn.oy) * bGrow;

          // Lá đơn sắc nét
          this.drawSingleLeaf(
            ctx, ox, oy,
            orn.leafAngle + wind * 0.1,
            orn.leafSize * bGrow,
            idx % 2 === 0 ? species.canopyHighlight : species.canopyMid
          );

          // Hoa nở theo tham số flowerRate
          if (orn.hasFlower && flowerRate > orn.threshold) {
            const fScale = clamp((flowerRate - orn.threshold) * 2.4, 0, 1.15) * bGrow;
            this.drawBlossom(ctx, ox, oy - 3, fScale, species);
          }

          // Quả chín theo tham số fruitRate & mutationRate
          if (orn.hasFruit && fruitRate > orn.threshold) {
            const rScale = clamp((fruitRate - orn.threshold) * 2.2, 0, 1.25) * bGrow;
            const isGold = orn.threshold < mutationRate;
            this.drawGlowingFruit(ctx, ox, oy + 6, 9.5 * rScale, species, isGold);
          }
        });
      }
    }

    ctx.restore(); // Đóng nhóm thân cây

    // Vẽ Giọt sương / Dinh dưỡng đang rơi
    team.drops.forEach((d) => {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.moveTo(0, -d.r * 1.5);
      ctx.bezierCurveTo(d.r, -d.r * 0.2, d.r, d.r, 0, d.r);
      ctx.bezierCurveTo(-d.r, d.r, -d.r, -d.r * 0.2, 0, -d.r * 1.5);
      ctx.fill();
      ctx.restore();
    });

    // Bảng tên Nhóm & Điểm số ngay dưới chân chậu
    ctx.save();
    ctx.translate(0, 56);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = isWinner ? '#facc15' : species.badgeColor;
    ctx.lineWidth = isWinner ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.roundRect(-95, -18, 190, 54, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isWinner ? '#fde047' : '#f8fafc';
    ctx.font = 'bold 13px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isWinner ? `🏆 ${team.name}` : team.name, 0, -1);

    ctx.fillStyle = species.canopyHighlight;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(team.scoreText, 0, 16);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText(team.subText, 0, 31);
    ctx.restore();

    ctx.restore();
  }

  loop(now: number) {
    if (!this.isRunning) return;
    requestAnimationFrame(this.loop);

    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const timeSec = now / 1000;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) {
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    this.ctx.clearRect(0, 0, W, H);

    // Chia đều khoảng cách ngang cho 4 Nhóm
    const stationScale = clamp(Math.min(W / 1150, H / 480), 0.55, 1.15);
    const baseY = H * 0.72;

    this.teams.forEach((team, idx) => {
      // 1. Lerp mượt các tham số
      const target = team.target;
      const current = team.current;
      for (const k in target) {
        current[k] += (target[k] - current[k]) * Math.min(1, dt * 4.5);
      }
      team.bounce = Math.max(0, team.bounce - dt * 3.0);
      team.shake = Math.max(0, team.shake - dt * 3.5);

      // 2. Cập nhật vật lý giọt rơi
      for (let i = team.drops.length - 1; i >= 0; i--) {
        const d = team.drops[i];
        d.vy += 500 * dt;
        d.y += d.vy * dt;
        if (d.y >= d.targetY) {
          team.ripples.push({ x: d.x, y: d.targetY, rx: 5, ry: 2, alpha: 0.9, color: d.color });
          if (d.isBad) {
            team.shake = 0.8;
          } else {
            team.bounce = 0.065;
          }
          team.drops.splice(i, 1);
        }
      }

      for (let i = team.ripples.length - 1; i >= 0; i--) {
        const rp = team.ripples[i];
        rp.rx += 48 * dt;
        rp.ry += 14 * dt;
        rp.alpha -= 1.5 * dt;
        if (rp.alpha <= 0) team.ripples.splice(i, 1);
      }

      // 3. Vẽ Trạm Cây của Nhóm
      const cx = (W / 4) * (idx + 0.5);
      this.renderTeamStation(this.ctx, team, cx, baseY, stationScale, timeSec);
    });
  }

  destroy() {
    this.isRunning = false;
  }
}
