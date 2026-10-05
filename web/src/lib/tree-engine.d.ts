/**
 * Type declarations for the Tree of Knowledge renderer (Phase 7.2/7.3).
 *
 * The implementation is `./tree-engine.js` — a byte-identical copy of
 * `v2/student/tree-engine.js`, which stays the single source of truth so the
 * student SPA and the teacher projector cannot draw different trees. The e2e
 * suite (Step 30) asserts the two files are identical, so drift is caught in CI
 * rather than discovered as a visual discrepancy.
 *
 * This `.d.ts` exists purely so the TypeScript app gets a checked contract; the
 * bundler still loads the `.js` at runtime.
 */

/** One of the four palettes. `seed % 4` selects it. */
export interface TreeTheme {
  index: number;
  key: 'orchard' | 'sakura' | 'autumn' | 'mystic';
  name: string;
  label: string;
  trunk: string;
  trunkDark: string;
  leaf: string;
  leafAlt: string;
  fruit: string;
  fruitAlt: string;
  fruitGlow: string;
  sky: [string, string];
  soil: [string, string];
}

/** One rung of the growth ladder. */
export interface TreeStage {
  name: 'seed' | 'sprout' | 'sapling' | 'maturing' | 'mature';
  label: string;
  maxInclusive: number;
  maxDepth: number;
}

/** A submission in the shape the engine understands. */
export interface TreeSubmissionInput {
  id?: string | null;
  student_code?: string;
  studentCode?: string;
  student_name?: string;
  studentName?: string;
  word_count?: number;
  wordCount?: number;
  fruit_index?: number;
  fruitIndex?: number;
  submitted_at?: string | null;
  submittedAt?: string | null;
}

/** An anchor in NORMALISED [0,1] coordinates, as returned by `computeTreeState`. */
export interface FruitAnchor {
  id: string | null;
  student_code: string;
  student_name: string;
  word_count: number;
  fruit_index: number;
  /** Radius actually used, after any density shrink. */
  radius: number;
  /** Radius the word count asked for, before shrinking. */
  base_radius: number;
  nx: number;
  ny: number;
}

/** An anchor mapped to pixels, as cached in `TreeRenderer.fruitAnchors`. */
export interface LayoutFruitAnchor extends FruitAnchor {
  x: number;
  y: number;
  pixelRadius: number;
}

/** The complete deterministic visual state of a tree. */
export interface TreeState {
  seed: number;
  themeIndex: number;
  theme: TreeTheme;
  k: number;
  n: number;
  participation: number;
  stage: TreeStage['name'];
  stageLabel: string;
  maxDepth: number;
  vitality: number;
  anchors: FruitAnchor[];
}

/** Reference "design" min-dimension used to convert radii to normalised units. */
export declare const NOMINAL_MIN_DIM: number;
/** Fruit base radius in pixels. */
export declare const BASE_FRUIT_RADIUS: number;
export declare const THEMES: TreeTheme[];
export declare const TREE_STAGES: TreeStage[];
/** The recursion depth of the final stage (`P = 1.0`). */
export declare const MAX_BRANCH_DEPTH: number;

/** Mulberry32. Deterministic; a seed of 0 falls back to 123456. */
export declare function createPRNG(seed: number): () => number;
/** `seed % 4`, normalised for negative/non-finite input. */
export declare function themeIndexForSeed(seed: number): number;
export declare function themeForSeed(seed: number): TreeTheme;
export declare function clamp(value: number, lo: number, hi: number): number;
export declare function stageForParticipation(p: number): TreeStage;

export interface ComputeTreeStateInput {
  totalStudents?: number;
  submissions?: TreeSubmissionInput[] | null;
  timeLimitMinutes?: number;
  createdAt?: string | Date | number | null;
  seed?: number;
}

/**
 * Derives the tree state. PURE: no clock, no `Math.random`, no DOM — identical
 * arguments always produce a deeply equal result.
 */
export declare function computeTreeState(input?: ComputeTreeStateInput): TreeState;

/** Maps normalised anchors to pixels with a single uniform (letterboxed) scale. */
export declare function layoutFruitAnchors(
  anchors: FruitAnchor[],
  width: number,
  height: number,
): LayoutFruitAnchor[];

/** Topmost fruit under a point, or null. */
export declare function hitTestFruits(
  anchors: LayoutFruitAnchor[],
  mouseX: number,
  mouseY: number,
): LayoutFruitAnchor | null;

export interface TreeRendererOptions {
  branchWidth?: number;
  width?: number;
  height?: number;
}

/** Canvas 2D renderer. The constructor is the only DOM boundary. */
export declare class TreeRenderer {
  constructor(canvas: HTMLCanvasElement | null, options?: TreeRendererOptions);
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  options: Required<TreeRendererOptions>;
  animFrameId: number | null;
  time: number;
  /** Clickable/tappable hitboxes in pixels; populated by `render()`. */
  fruitAnchors: LayoutFruitAnchor[];

  /** Fits the backing store to the element so retina/4K displays stay crisp. */
  resize(): { width: number; height: number };
  /** Full render pass for a state from `computeTreeState()`. */
  render(treeData: TreeState): void;
  drawBranch(
    x: number,
    y: number,
    length: number,
    angle: number,
    depth: number,
    maxDepth: number,
    branchPRNG: () => number,
    swayOffset: number,
  ): void;
  drawFruit(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    fruitData: LayoutFruitAnchor,
    theme: TreeTheme,
    isHighlighted: boolean,
  ): void;
  getFruitAt(mouseX: number, mouseY: number): LayoutFruitAnchor | null;
  setHighlight(id: string | null): void;
  startAnimation(treeData: TreeState): void;
  stopAnimation(): void;
}
