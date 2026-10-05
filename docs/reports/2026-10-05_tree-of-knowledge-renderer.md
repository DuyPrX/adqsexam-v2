# Change Report: Tree of Knowledge — Procedural Canvas Graphics Engine (Phase 7.2)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Ship the client-side rendering half of the "Cây Tri Thức" (Tree of
  Knowledge) feature: a dependency-free, isomorphic Canvas 2D engine that turns a
  `tree_sessions` row plus its `tree_submissions` into a deterministic, animated tree
  whose growth reflects participation `P = k / N` and whose vibrancy reflects vitality
  `V`.
- **Root Cause / Motivation:** Phase 7.1 shipped the backend (schema, similarity RPC,
  Realtime) but stored no geometry. Storing a rendered tree server-side would be
  wasteful and multi-tenant-hostile; instead every client must derive the *same* tree
  from `tree_seed` alone. That requires a strictly deterministic, seeded renderer that
  is shared verbatim between the student SPA (vanilla ES module) and future Next.js
  consumers, and that is testable headlessly so determinism and non-overlap can be
  proven in CI rather than eyeballed in a browser.

## 2. Technical Implementation Details
- **Architecture / Core Logic:** `student/tree-engine.js` is a pure ES module with a
  deliberate testability split:
  - `computeTreeState()` is **pure** (no clock, no `Math.random`, no DOM) and returns
    fruit anchors in **normalised [0,1]** coordinates.
  - `layoutFruitAnchors()` maps those to pixels with a **single uniform scale**
    (letterboxed), so separation measured in normalised space is preserved exactly in
    pixels — which is what makes "fruits do not overlap" provable headless.
  - `TreeRenderer` is the only DOM boundary (its constructor captures `canvas`).
  - **PRNG:** Mulberry32 exactly as specified, including `(seed >>> 0) || 123456` so a
    DB-default seed of `0` cannot degenerate; `ANCHOR_GAP = 0.012` gives a positive
    clearance instead of converging to tangent.
  - **Determinism discipline:** the asserted geometry uses only IEEE-754 basic ops and
    `Math.sqrt` — no `Math.hypot`, no trigonometry in the anchor path. Trig is confined
    to the branch-drawing path, which is not asserted (and thus free to change visually).
  - **Packing guarantee:** `placeAnchors()` first computes a `fitScale` from canopy area
    vs. summed cushioned fruit areas, so a large roster **shrinks fruit radii** rather
    than producing overlaps; relaxation then runs with a fixed pair order (`i < j`) and a
    fixed iteration count for bit-reproducible results.
  - **Palettes:** four archetypes selected by `seed % 4` (normalised for negative /
    non-finite seeds), each carrying trunk/leaf/fruit/glow/sky/soil stops.
- **Database Migrations:** None. The engine consumes the Phase 7.1 `tree_seed`,
  `max_similarity`, `time_limit_minutes`, `word_count` and `submitted_at` fields as
  already shipped; no schema change was required.
- **API Contracts:** None new. The engine is a pure client-side library; it performs no
  I/O. `submit_tree_answer` (Phase 7.1) remains the only write path.

## 3. Impacted Files
- `student/tree-engine.js`: **New.** The engine — `createPRNG`, `THEMES` /
  `themeForSeed`, `TREE_STAGES` / `MAX_BRANCH_DEPTH`, `computeVitality`,
  `computeTreeState`, `layoutFruitAnchors`, `hitTestFruits`, `TreeRenderer`
  (`resize`/`render`/`drawBranch`/`drawFruit`/`getFruitAt`/`setHighlight`/
  `startAnimation`/`stopAnimation`) and the `fruitAnchors` hitbox cache.
- `student/index.html`: Added the `#treeScreen` section hosting the
  `#tree-preview-canvas` preview container (4:3, laid out rather than `display:none`
  so the renderer can measure it).
- `student/styles.css`: Added the `.tree-screen` / `.tree-canvas` rules; the canvas box
  gets a definite size so `clientWidth/clientHeight` are non-zero.
- `student/app.js`: Imported the engine; added the tree-screen controller
  (`renderTree`, `showTree`, `pointerToCanvas`, pointer handlers) plus `treeRenderer` /
  `treeData` / `treeHighlightId` state and a `resize` re-measure listener in `boot()`.
- `tests/e2e_flow_verification.mjs`: Added Step 29 (31 assertions) importing the shipped
  module directly.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `node --check student/app.js` and `node --check student/tree-engine.js` — both exit 0.
  - `node tests/e2e_flow_verification.mjs` against the local Supabase stack.
- **Results:** `RESULT: 398 passed, 0 failed` (up from 367 at the end of Phase 7.1; +31
  Step 29 assertions). Step 29 covers:
  - **29a Determinism** — identical seed + submissions give a deeply equal state,
    byte-identical `[nx, ny, radius]` anchors and the same palette; a different seed gives
    different anchors; placement is independent of the input array's order; `createPRNG(0)`
    equals the 123456 stream.
  - **29b Growth boundaries** — `P = 0` → `seed` stage, `maxDepth = 0`; `P = 1.0` →
    `mature`, `maxDepth = MAX_BRANCH_DEPTH (7)`; interior boundaries → sprout(1) /
    sapling(3) / maturing(5); the ladder is monotonic; `N = 0` is floored to 1.
  - **29c Hitbox integrity** — across `k = 30/320×480`, `k = 40/360×640`,
    `k = 12/2000×1200` and `k = 1/300×300`: exactly one anchor per submission, all
    in-bounds (pixel and normalised), with strictly positive worst-case clearance.
  - **29d Vitality decay** — `k = 0` → `1.0`; 5 m of 45 m → `≥ 0.8`; exactly 45 m →
    `≤ 0.4`; 120 m clamps to the `0.2` floor; monotonically decreasing with latency.
  - **29e Palettes** — `seed % 4` cycles correctly including the negative-seed case, and
    the four archetypes carry distinct fruit colours.
  - **29f TreeRenderer** — driven through a stub 2D context: `resize()` fits the backing
    store; `render()` caches one hitbox per fruit; `getFruitAt()` resolves a fruit and
    returns `null` off-canvas; the seed stage exposes no hitboxes; and
    `startAnimation`/`stopAnimation` no-op safely where `requestAnimationFrame` is absent.
- **Rollback Strategy:** Revert `student/tree-engine.js`, the `#treeScreen` block in
  `student/index.html`, the `.tree-screen` rules in `student/styles.css`, the Phase 7.2
  block in `student/app.js`, and the Step 29 section of the e2e suite. No migration or
  data change is involved, so a rollback is purely a client-code revert.
