/**
 * ADQS Exam v2 — Computer Vision Engine for Gesture Quiz ("Đấu Trường Cử Chỉ AI")
 * ==============================================================================
 * Pure algorithms for MediaPipe hand/pose gesture classification, spatial zone
 * assignment, anti-flicker dwell-time hold tracking, and procedural Web Audio SFX.
 */

import type {
  VisionAdvanceMode,
  VisionDetectionMode,
  VisionExamDistribution,
  VisionPlayerMode,
  VisionQuizConfig,
  VisionQuizQuestionItem,
} from './types';

export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export type PlayerId = 'BLUE' | 'RED';

/* -------------------------------------------------------------------------- */
/* 1. Geometric Math & Distance Utilities                                     */
/* -------------------------------------------------------------------------- */

export function dist(p1: NormalizedLandmark, p2: NormalizedLandmark): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* -------------------------------------------------------------------------- */
/* 2. Hand Finger Counting (1-2-3-4 -> A-B-C-D)                              */
/* -------------------------------------------------------------------------- */

/**
 * Counts how many fingers are extended on a standard 21-landmark MediaPipe hand.
 * Indices:
 * - Thumb: 1..4 (Tip: 4, IP: 3, MCP: 2)
 * - Index: 5..8 (Tip: 8, PIP: 6, MCP: 5)
 * - Middle: 9..12 (Tip: 12, PIP: 10, MCP: 9)
 * - Ring: 13..16 (Tip: 16, PIP: 14, MCP: 13)
 * - Pinky: 17..20 (Tip: 20, PIP: 18, MCP: 17)
 */
export function countExtendedFingersRaw(landmarks: NormalizedLandmark[]): number {
  if (!landmarks || landmarks.length < 21) return 0;
  let count = 0;

  // Thumb: extended if tip is further from MCP than IP is, or tip.y is higher than IP.y
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];
  const thumbMcp = landmarks[2];
  const thumbExtended =
    dist(thumbTip, thumbMcp) > dist(thumbIp, thumbMcp) * 1.1 ||
    thumbTip.y < thumbIp.y - 0.02;
  if (thumbExtended) count++;

  // Index finger
  if (landmarks[8].y < landmarks[6].y) count++;

  // Middle finger
  if (landmarks[12].y < landmarks[10].y) count++;

  // Ring finger
  if (landmarks[16].y < landmarks[14].y) count++;

  // Pinky finger
  if (landmarks[20].y < landmarks[18].y) count++;

  return count;
}

/**
 * Maps extended finger count to quiz option index:
 * - 1 finger  -> 0 (Option A)
 * - 2 fingers -> 1 (Option B)
 * - 3 fingers -> 2 (Option C)
 * - 4 or 5    -> 3 (Option D)
 * - 0 fingers -> null (No selection / fist)
 */
export function countExtendedFingers(landmarks: NormalizedLandmark[]): number | null {
  const raw = countExtendedFingersRaw(landmarks);
  if (raw === 1) return 0;
  if (raw === 2) return 1;
  if (raw === 3) return 2;
  if (raw >= 4) return 3;
  return null;
}

/* -------------------------------------------------------------------------- */
/* 3. Upper-Body Pose Classification                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classifies an upper-body pose using MediaPipe Pose landmarks:
 * - 11: LEFT_SHOULDER, 12: RIGHT_SHOULDER
 * - 13: LEFT_ELBOW,    14: RIGHT_ELBOW
 * - 15: LEFT_WRIST,    16: RIGHT_WRIST
 *
 * Mappings:
 * - Both hands above head            -> 0 (Option A)
 * - Both hands crossed on chest      -> 1 (Option B)
 * - Left arm raised only             -> 2 (Option C)
 * - Right arm raised only            -> 3 (Option D)
 * - Arms neutral / down              -> null
 */
export function classifyBodyPose(landmarks: NormalizedLandmark[]): number | null {
  if (!landmarks || landmarks.length < 17) return null;

  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];

  if (!leftShoulder || !rightShoulder || !leftWrist || !rightWrist) return null;

  const shoulderDist = dist(leftShoulder, rightShoulder) || 0.3;
  const wristDist = dist(leftWrist, rightWrist);

  // Check crossed hands on chest:
  // Wrists are at/near chest level (between chin and elbow) and close together (< 0.5 * shoulderDist)
  const leftNearChest = leftWrist.y > leftShoulder.y - 0.15 && leftWrist.y < leftShoulder.y + 0.35;
  const rightNearChest = rightWrist.y > rightShoulder.y - 0.15 && rightWrist.y < rightShoulder.y + 0.35;
  const isCrossed = leftNearChest && rightNearChest && wristDist < shoulderDist * 0.55;

  if (isCrossed) {
    return 1; // Option B
  }

  const leftRaised = leftWrist.y < leftShoulder.y;
  const rightRaised = rightWrist.y < rightShoulder.y;

  if (leftRaised && rightRaised) {
    return 0; // Option A (Both hands raised)
  }
  if (leftRaised && !rightRaised) {
    return 2; // Option C (Left arm raised)
  }
  if (rightRaised && !leftRaised) {
    return 3; // Option D (Right arm raised)
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 4. Spatial Zone Splitter & Player Assignment                               */
/* -------------------------------------------------------------------------- */

export interface DetectionItem {
  x: number; // 0..1 (horizontal position in mirrored camera view)
  y?: number;
  option: number | null;
  confidence?: number;
  landmarks?: NormalizedLandmark[];
}

export interface PlayerDetectionAssignment {
  blue: DetectionItem | null;
  red: DetectionItem | null;
}

/**
 * Assigns hand/pose detections to players based on `splitRatio` and `swapSides`.
 * In DUEL mode:
 * - x < splitRatio  -> Left Zone
 * - x >= splitRatio -> Right Zone
 * With `swapSides = false`: Left = Blue, Right = Red.
 * With `swapSides = true`:  Left = Red,  Right = Blue.
 */
export function assignDetectionsToPlayers(
  detections: DetectionItem[],
  config: {
    playerMode: VisionPlayerMode;
    splitRatio: number;
    swapSides: boolean;
  }
): PlayerDetectionAssignment {
  if (!detections || detections.length === 0) {
    return { blue: null, red: null };
  }

  const pickBest = (list: DetectionItem[]) => {
    if (list.length === 0) return null;
    return [...list].sort((a, b) => {
      if (a.option !== null && b.option === null) return -1;
      if (b.option !== null && a.option === null) return 1;
      return (b.confidence ?? 1) - (a.confidence ?? 1);
    })[0];
  };

  if (config.playerMode === 'SINGLE') {
    return {
      blue: pickBest(detections),
      red: null,
    };
  }

  const ratio = Math.max(0.1, Math.min(0.9, config.splitRatio ?? 0.5));
  const leftDetections = detections.filter((d) => d.x < ratio);
  const rightDetections = detections.filter((d) => d.x >= ratio);

  const leftBest = pickBest(leftDetections);
  const rightBest = pickBest(rightDetections);

  if (config.swapSides) {
    return {
      blue: rightBest,
      red: leftBest,
    };
  } else {
    return {
      blue: leftBest,
      red: rightBest,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Dwell-Time Hold Confirmation Tracker (Anti-Flicker)                     */
/* -------------------------------------------------------------------------- */

export interface PlayerHoldState {
  currentOption: number | null;
  holdStartTime: number | null;
  lastDetectedTime: number | null;
  progress: number; // 0..1
  isLocked: boolean;
}

export class HoldConfirmationTracker {
  private holdDurationMs: number;
  private graceWindowMs: number;
  private onLock: (player: PlayerId, option: number) => void;
  private states: Record<PlayerId, PlayerHoldState>;

  constructor(options: {
    holdDurationMs?: number;
    graceWindowMs?: number;
    onLockOption?: (player: PlayerId, option: number) => void;
  } = {}) {
    this.holdDurationMs = options.holdDurationMs ?? 1200;
    this.graceWindowMs = options.graceWindowMs ?? 200;
    this.onLock = options.onLockOption || (() => {});
    this.states = {
      BLUE: { currentOption: null, holdStartTime: null, lastDetectedTime: null, progress: 0, isLocked: false },
      RED: { currentOption: null, holdStartTime: null, lastDetectedTime: null, progress: 0, isLocked: false },
    };
  }

  public setConfig(holdDurationMs: number, graceWindowMs: number) {
    this.holdDurationMs = holdDurationMs;
    this.graceWindowMs = graceWindowMs;
  }

  public getState(player: PlayerId): PlayerHoldState {
    return { ...this.states[player] };
  }

  public reset(player?: PlayerId) {
    if (player) {
      this.states[player] = {
        currentOption: null,
        holdStartTime: null,
        lastDetectedTime: null,
        progress: 0,
        isLocked: false,
      };
    } else {
      this.reset('BLUE');
      this.reset('RED');
    }
  }

  public update(player: PlayerId, detectedOption: number | null, now = Date.now()): PlayerHoldState {
    const state = this.states[player];
    if (state.isLocked) {
      return { ...state };
    }

    if (detectedOption === null) {
      // Option lost: check grace window
      if (state.currentOption !== null && state.lastDetectedTime !== null) {
        const timeSinceLast = now - state.lastDetectedTime;
        if (timeSinceLast > this.graceWindowMs) {
          // Grace expired -> reset
          state.currentOption = null;
          state.holdStartTime = null;
          state.lastDetectedTime = null;
          state.progress = 0;
        }
      }
      return { ...state };
    }

    // Detected a valid option
    if (state.currentOption !== detectedOption) {
      // Option switched: reset hold timer for the new option
      state.currentOption = detectedOption;
      state.holdStartTime = now;
      state.lastDetectedTime = now;
      state.progress = 0;
      state.isLocked = false;
      return { ...state };
    }

    // Still holding the same option
    state.lastDetectedTime = now;
    if (state.holdStartTime === null) {
      state.holdStartTime = now;
    }

    const elapsed = now - state.holdStartTime;
    state.progress = Math.min(1, Math.max(0, elapsed / this.holdDurationMs));

    if (state.progress >= 1 && !state.isLocked) {
      state.isLocked = true;
      this.onLock(player, detectedOption);
    }

    return { ...state };
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Question Builders & Option Shuffling                                    */
/* -------------------------------------------------------------------------- */

export function shuffleArray<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

export function shuffleQuestionOptions(q: VisionQuizQuestionItem): VisionQuizQuestionItem {
  if (!q.options || q.options.length <= 1) return { ...q };
  const indices = Array.from({ length: q.options.length }, (_, i) => i);
  const shuffledIndices = shuffleArray(indices);
  const newOptions = shuffledIndices.map((origIdx) => q.options[origIdx]);
  const newCorrectOption = shuffledIndices.indexOf(q.correct_option);
  return {
    ...q,
    options: newOptions,
    correct_option: newCorrectOption >= 0 ? newCorrectOption : 0,
  };
}

export interface BuildVisionQuizQuestionsParams {
  mode: VisionExamDistribution;
  primaryPool: VisionQuizQuestionItem[];
  secondaryPool?: VisionQuizQuestionItem[];
  questionCount: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
}

export function buildVisionQuizQuestions(params: BuildVisionQuizQuestionsParams): {
  blueQuestions: VisionQuizQuestionItem[];
  redQuestions: VisionQuizQuestionItem[];
} {
  const {
    mode,
    primaryPool,
    secondaryPool = [],
    questionCount,
    shuffleQuestions,
    shuffleOptions,
  } = params;

  if (!primaryPool || primaryPool.length === 0) {
    return { blueQuestions: [], redQuestions: [] };
  }

  const prepareSequence = (pool: VisionQuizQuestionItem[]): VisionQuizQuestionItem[] => {
    let list = [...pool];
    if (shuffleQuestions) {
      list = shuffleArray(list);
    }
    const sliced = list.slice(0, Math.min(questionCount, list.length));
    if (shuffleOptions) {
      return sliced.map((q) => shuffleQuestionOptions(q));
    }
    return sliced;
  };

  if (mode === 'SHARED_SYNC') {
    // Both players get the exact same question sequence and same options
    const shared = prepareSequence(primaryPool);
    return {
      blueQuestions: shared.map((q) => ({ ...q })),
      redQuestions: shared.map((q) => ({ ...q })),
    };
  }

  if (mode === 'SAME_EXAM_SHUFFLED') {
    // Both players draw from the same exam pool but have independent question order and options
    const blue = prepareSequence(primaryPool);
    let red = prepareSequence(primaryPool);

    // If possible and count > 1, make the first question distinct for variety
    if (blue.length > 1 && red.length > 1 && blue[0].id === red[0].id) {
      const swapIdx = Math.floor(1 + Math.random() * (red.length - 1));
      const temp = red[0];
      red[0] = red[swapIdx];
      red[swapIdx] = temp;
    }

    return {
      blueQuestions: blue,
      redQuestions: red,
    };
  }

  if (mode === 'DUAL_EXAMS') {
    // Blue gets questions from primaryPool, Red gets questions from secondaryPool
    const blue = prepareSequence(primaryPool);
    const redPool = secondaryPool.length > 0 ? secondaryPool : primaryPool;
    const red = prepareSequence(redPool);
    return {
      blueQuestions: blue,
      redQuestions: red,
    };
  }

  return {
    blueQuestions: prepareSequence(primaryPool),
    redQuestions: prepareSequence(primaryPool),
  };
}

/* -------------------------------------------------------------------------- */
/* 7. Zero-Dependency Procedural Web Audio SFX Engine                         */
/* -------------------------------------------------------------------------- */

export class VisionSoundEffects {
  private ctx: AudioContext | null = null;
  public isMuted = false;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  playCorrect() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.08); // E5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.16); // G5
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Audio error ignored
    }
  }

  playWrong() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.linearRampToValueAtTime(110, now + 0.3);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Audio error ignored
    }
  }

  playFreeze() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.4);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch {
      // Audio error ignored
    }
  }

  playLockTick() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046.5, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } catch {
      // Audio error ignored
    }
  }

  playVictory() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const now = (this.ctx?.currentTime || 0) + i * 0.12;
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.connect(gain);
        gain.connect(this.ctx!.destination);
        osc.start(now);
        osc.stop(now + 0.3);
      });
    } catch {
      // Audio error ignored
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 8. AR Canvas Skeleton Overlay Renderer                                     */
/* -------------------------------------------------------------------------- */

const HAND_CONNECTIONS: [number, number][] = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17],
];

const POSE_CONNECTIONS: [number, number][] = [
  // Shoulders
  [11, 12],
  // Left arm
  [11, 13], [13, 15],
  // Right arm
  [12, 14], [14, 16],
  // Torso
  [11, 23], [12, 24], [23, 24],
];

const OPTION_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981']; // A, B, C, D
const OPTION_LABELS = ['A', 'B', 'C', 'D'];

export function drawVisionOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: VisionQuizConfig,
  assignments: PlayerDetectionAssignment,
  holdStates: { blue: PlayerHoldState; red: PlayerHoldState }
) {
  ctx.clearRect(0, 0, width, height);

  // 1. Draw split line for DUEL mode
  if (config.playerMode === 'DUEL') {
    const splitX = config.splitRatio * width;

    // Glowing divider
    ctx.save();
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, height);
    ctx.stroke();
    ctx.restore();

    // Zone labels at top
    ctx.save();
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.textBaseline = 'top';

    const leftName = config.swapSides ? config.redPlayerName : config.bluePlayerName;
    const rightName = config.swapSides ? config.bluePlayerName : config.redPlayerName;
    const leftColor = config.swapSides ? '#f43f5e' : '#38bdf8';
    const rightColor = config.swapSides ? '#38bdf8' : '#f43f5e';

    ctx.fillStyle = leftColor;
    ctx.fillText(`◀ ${leftName}`, 16, 14);

    ctx.fillStyle = rightColor;
    const rightWidth = ctx.measureText(`${rightName} ▶`).width;
    ctx.fillText(`${rightName} ▶`, width - rightWidth - 16, 14);
    ctx.restore();
  }

  // 2. Draw Landmarks and Skeletons
  const renderPlayerDetection = (
    detection: DetectionItem | null,
    holdState: PlayerHoldState,
    teamColor: string,
    playerLabel: string
  ) => {
    if (!detection || !detection.landmarks || detection.landmarks.length === 0) return;

    const landmarks = detection.landmarks;
    const isHand = landmarks.length >= 21 && landmarks.length < 33;
    const connections = isHand ? HAND_CONNECTIONS : POSE_CONNECTIONS;

    if (config.showSkeleton) {
      ctx.save();
      ctx.strokeStyle = teamColor;
      ctx.fillStyle = teamColor;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = teamColor;
      ctx.shadowBlur = 6;

      // Draw connections
      for (const [startIdx, endIdx] of connections) {
        const p1 = landmarks[startIdx];
        const p2 = landmarks[endIdx];
        if (p1 && p2) {
          const x1 = config.mirrorVideo ? (1 - p1.x) * width : p1.x * width;
          const y1 = p1.y * height;
          const x2 = config.mirrorVideo ? (1 - p2.x) * width : p2.x * width;
          const y2 = p2.y * height;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // Draw landmark dots
      for (const p of landmarks) {
        const x = config.mirrorVideo ? (1 - p.x) * width : p.x * width;
        const y = p.y * height;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }

    // 3. Draw Hold Progress Indicator Ring above detection
    const anchor = isHand ? landmarks[8] || landmarks[0] : landmarks[0] || landmarks[11];
    if (anchor && holdState.currentOption !== null) {
      const anchorX = config.mirrorVideo ? (1 - anchor.x) * width : anchor.x * width;
      const anchorY = Math.max(50, anchor.y * height - 55);

      const optIdx = holdState.currentOption;
      const optColor = OPTION_COLORS[optIdx] || '#ffffff';
      const optLabel = OPTION_LABELS[optIdx] || '?';
      const radius = 26;

      ctx.save();
      // Background disc
      ctx.beginPath();
      ctx.arc(anchorX, anchorY, radius, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.stroke();

      // Progress Arc
      if (holdState.progress > 0) {
        ctx.beginPath();
        ctx.arc(
          anchorX,
          anchorY,
          radius,
          -Math.PI / 2,
          -Math.PI / 2 + holdState.progress * 2 * Math.PI
        );
        ctx.lineWidth = 4;
        ctx.strokeStyle = optColor;
        ctx.shadowColor = optColor;
        ctx.shadowBlur = holdState.isLocked ? 16 : 8;
        ctx.stroke();
      }

      // Center Option Letter
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = optColor;
      ctx.fillText(optLabel, anchorX, anchorY);

      // Lock status badge
      if (holdState.isLocked) {
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = '#10b981';
        ctx.fillText('ĐÃ CHỐT ✓', anchorX, anchorY + radius + 14);
      }
      ctx.restore();
    }
  };

  renderPlayerDetection(assignments.blue, holdStates.blue, '#38bdf8', 'BLUE');
  if (config.playerMode === 'DUEL') {
    renderPlayerDetection(assignments.red, holdStates.red, '#f43f5e', 'RED');
  }
}

/* -------------------------------------------------------------------------- */
/* 9. Supabase Question Bank Loader & Normalizer                             */
/* -------------------------------------------------------------------------- */

export async function fetchAndNormalizeExamQuestions(
  supabase: any,
  examId: string
): Promise<VisionQuizQuestionItem[]> {
  const { data: rawQuestions, error } = await supabase
    .from('question_bank')
    .select('id, question_text, question_type, options, correct_answer, explanation')
    .eq('exam_id', examId)
    .order('position', { ascending: true });

  if (error) {
    throw new Error(`Không tải được câu hỏi: ${error.message}`);
  }
  if (!rawQuestions || rawQuestions.length === 0) {
    return [];
  }

  const eligible = rawQuestions.filter((q: any) => {
    let opts = q.options;
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = [];
      }
    }
    return Array.isArray(opts) && opts.length >= 2;
  });

  return eligible.map((q: any) => {
    let options: string[] = [];
    if (typeof q.options === 'string') {
      try {
        options = JSON.parse(q.options);
      } catch {
        options = [];
      }
    } else if (Array.isArray(q.options)) {
      options = q.options.map(String);
    }

    let correctOption = 0;
    if (typeof q.correct_answer === 'number') {
      correctOption = q.correct_answer;
    } else if (typeof q.correct_answer === 'string') {
      const parsed = parseInt(q.correct_answer, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < options.length) {
        correctOption = parsed;
      } else {
        const letterIdx = ['A', 'B', 'C', 'D'].indexOf(q.correct_answer.trim().toUpperCase());
        if (letterIdx >= 0) correctOption = letterIdx;
      }
    }

    return {
      id: q.id,
      question_text: q.question_text,
      options,
      correct_option: correctOption,
      explanation: q.explanation || null,
    };
  });
}

