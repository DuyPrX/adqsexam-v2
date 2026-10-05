'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  TreeRenderer,
  computeTreeState,
  type LayoutFruitAnchor,
  type TreeState,
} from '@/lib/tree-engine';
import type { TreeSessionRow, TreeSubmissionRow } from '@/lib/types';

export interface TreeCanvasHandle {
  /** A high-resolution PNG data URL of the tree, for the "memory picture" download. */
  exportImage(): string | null;
}

interface TreeCanvasProps {
  session: TreeSessionRow;
  /** Class size `N` — the participation denominator. */
  totalStudents: number;
  submissions: TreeSubmissionRow[];
  /** Fires when a fruit is tapped (null when the tap lands on empty space). */
  onFruitClick?: (fruit: LayoutFruitAnchor | null) => void;
  /** Fires as the pointer moves over the fruits, for the hover tooltip. */
  onFruitHover?: (fruit: LayoutFruitAnchor | null) => void;
}

/** Backing-store size of the exported memory picture (independent of the window). */
const EXPORT_WIDTH = 2400;
const EXPORT_HEIGHT = 1800;

/**
 * TreeCanvas — React host for the Phase 7.2 procedural renderer (Phase 7.3).
 *
 * The engine is deliberately framework-agnostic and impure-by-design (it draws
 * to a canvas), so this component owns the one thing React must own: the
 * element's lifetime. All tree data is derived through the PURE
 * `computeTreeState()`, which means a Realtime update is just a new
 * `submissions` prop — no incremental "grow one fruit" bookkeeping is needed,
 * and re-running the engine can never drift from a cold render.
 */
export const TreeCanvas = forwardRef<TreeCanvasHandle, TreeCanvasProps>(function TreeCanvas(
  { session, totalStudents, submissions, onFruitClick, onFruitHover },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TreeRenderer | null>(null);

  /**
   * The full visual state. Recomputed only when an input actually changes;
   * `computeTreeState` re-runs the anchor relaxation, so memoising it keeps a
   * pure re-render (e.g. a tooltip state change in the parent) from redoing
   * that work on every frame.
   */
  const treeState = useMemo<TreeState>(
    () =>
      computeTreeState({
        totalStudents,
        submissions,
        timeLimitMinutes: session.time_limit_minutes,
        createdAt: session.created_at,
        seed: session.tree_seed,
      }),
    [totalStudents, submissions, session.time_limit_minutes, session.created_at, session.tree_seed],
  );

  // --- renderer lifecycle --------------------------------------------------
  // The renderer is created once and only re-pointed at new data, so the idle
  // breeze animation never restarts from zero on a Realtime update.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new TreeRenderer(canvas);
    rendererRef.current = renderer;
    renderer.startAnimation(treeState);

    return () => {
      renderer.stopAnimation();
      rendererRef.current = null;
    };
    // Intentionally mounts once: `treeState` is applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push new data into the running animation whenever the state changes.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // `startAnimation` re-points the loop at the new data and preserves
    // `renderer.time`, so the tree grows without a visual jump.
    renderer.startAnimation(treeState);
  }, [treeState]);

  // `resize()` is driven from the element's CSS box, which the browser does not
  // reflow into the backing store on its own (rotation, projector switch, etc.).
  useEffect(() => {
    const handleResize = () => rendererRef.current?.render(treeState);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [treeState]);

  /** Maps a pointer event to canvas-space pixels. */
  const pointerToCanvas = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // The backing store is dpr-scaled but the engine draws in CSS pixels, so
    // scale to clientWidth (not to canvas.width).
    return {
      x: (event.clientX - rect.left) * (canvas.clientWidth / rect.width),
      y: (event.clientY - rect.top) * (canvas.clientHeight / rect.height),
    };
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!onFruitHover) return;
      const point = pointerToCanvas(event);
      const renderer = rendererRef.current;
      if (!point || !renderer) return;
      const fruit = renderer.getFruitAt(point.x, point.y);
      event.currentTarget.style.cursor = fruit ? 'pointer' : 'default';
      onFruitHover(fruit);
    },
    [onFruitHover, pointerToCanvas],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!onFruitClick) return;
      const point = pointerToCanvas(event);
      const renderer = rendererRef.current;
      if (!point || !renderer) return;
      onFruitClick(renderer.getFruitAt(point.x, point.y));
    },
    [onFruitClick, pointerToCanvas],
  );

  useImperativeHandle(
    ref,
    () => ({
      exportImage() {
        // Rendered into a DETACHED canvas at a fixed size rather than exporting
        // the on-screen one: the projector's canvas is viewport-shaped, so an
        // export would otherwise vary with the teacher's window and could be
        // small on a laptop. A detached canvas has clientWidth === 0, so
        // `resize()` falls back to the explicit options below.
        const offscreen = document.createElement('canvas');
        const renderer = new TreeRenderer(offscreen, {
          width: EXPORT_WIDTH,
          height: EXPORT_HEIGHT,
        });
        renderer.render(treeState);
        try {
          return offscreen.toDataURL('image/png');
        } catch {
          // Only reachable on a tainted canvas; this canvas draws purely from
          // literals, so it is a guard rather than an expected path.
          return null;
        }
      },
    }),
    [treeState],
  );

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none select-none"
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerLeave={() => onFruitHover?.(null)}
      aria-label={`Cây tri thức của lớp ${session.title}`}
    />
  );
});
