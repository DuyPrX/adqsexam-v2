# Change Report: Tree of Knowledge — Organic Graphics, Knowledge Dewdrops & Bloom (Phase 8.2)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Overhaul the procedural renderer so the Tree of Knowledge grows
  like a plant instead of assembling primitives, and pivot the submission token
  from a rigid "fruit" to a glowing "knowledge dewdrop" ("Giọt sương tri thức" /
  "Dưỡng chất"), with a whole-class flourish celebration at P = 1.0.
- **Root Cause / Motivation:** Phase 7.2 shipped a functional but schematic tree
  (straight branch segments, flat discs for leaves and fruits, a generic "mature"
  top stage). The activity is a visual focal point in the classroom, so the
  renderer needed organic curvature, volumetric foliage, luminous dewdrops and a
  reward state that makes a full-class finish feel like an event — all while
  preserving the determinism guarantee (identical session data → identical tree)
  and the student/projector engine parity that Steps 29/30 depend on.

## 2. Technical Implementation Details

### Engine redesign (`student/tree-engine.js`, mirrored byte-identically into `web/src/lib/tree-engine.js`)
- **Stage model.** `TREE_STAGES` is now a frozen **object of identifiers**
  (`SEED`/`SPROUT`/`SAPLING`/`MATURING`/`BLOOM`) rather than an array, and the
  ordered ladder moved to `STAGE_LADDER`. `stageForParticipation` short-circuits
  `P >= 1.0` onto `BLOOM`; every other ratio falls through the ladder. `SPROUT`
  now covers `0 < P <= 0.15`, `SAPLING` widens to `0.50`, `MATURING` covers
  `0.50 < P < 1.0`, and `BLOOM` (maxDepth 7) is the only flourish rung.
  `MAX_BRANCH_DEPTH` is unchanged (7).
- **`isFlourished`.** `computeTreeState` returns `isFlourished: participation >= 1.0`
  — the flag the UI keys the celebration banner off, and the only branch that
  triggers `_drawBloom`.
- **Organic branches.** `drawBranch` now strokes a `quadraticCurveTo` whose
  control point is bowed by a trigonometric breeze (`Math.sin(time + depth)`).
  The branch **end point is unchanged**, so leaf-tip (and therefore bloom)
  placement stays a pure function of the seed; an `ctx.quadraticCurveTo` guard
  degrades to `lineTo` on a minimal stub.
- **Foliage puffs.** A shared `_foliagePuff()` primitive draws a cluster of three
  overlapping translucent circles with `createRadialGradient`, alpha from 0.72
  to 0.55, scaled by vitality — used by both the sprout's cotyledons and the
  canopy terminals.
- **Seed / sprout artwork.** `_drawSeed` renders a dormant oval seed with a slow
  breathing glow and an inner seam; `_drawSprout` renders a curved stalk with two
  drooping cotyledon leaves and a central bud. The soil mound gained a nutrient
  ridge.
- **`drawDewdrop`.** Four layers: an outer ethereal glow ring (radius scales with
  vitality; 2.4× when highlighted), a translucent **Bézier teardrop** body
  (`globalAlpha 0.92`), an inner luminous core + white specular dot, and a
  pulsing golden halo for highlighted droplets. `drawFruit` is retained as an
  alias.
- **Radius formula.** `dewdropRadiusPx = baseRadius + clamp(wordCount / 12, 1.5, 6)`;
  `fruitRadiusPx` aliased.
- **Bloom.** `_drawBloom` paints five-petal pastel blossoms (`_drawFlower`) with
  a golden pistil on canopy tips plus drifting `#fde68a` sparkles.
- **Aliases + hitbox cache.** `layoutDewdropAnchors`/`hitTestDewdrops` are the
  canonical names (`layoutFruitAnchors`/`hitTestFruits` aliased);
  `renderer.dewdropAnchors` getter exposes the `fruitAnchors` hitbox cache;
  `getDewdropAt` aliases `getFruitAt`.
- **Determinism preserved.** Anchor placement (rejection sampling + relaxation,
  `Math.sqrt` only, no trig) is byte-for-byte unchanged, so the non-overlap proof
  and every existing geometry assertion still hold.

### Types
`web/src/lib/tree-engine.d.ts` declares `TreeStageIds`, `STAGE_LADDER`,
`isFlourished`, the new aliases and `dewdropAnchors`.

### UI copy
- `TreeProjector.tsx`: tooltip eyebrow + badge renamed to "Giọt sương tri thức" /
  "Giọt sương #N"; progress badge → "X/Y bạn đã góp dưỡng chất"; new pulsing
  amber banner at P = 1.0.
- `student/app.js`: tooltip → "Giọt sương tri thức của bạn (#N)"; success status
  → "🌱 Giọt sương tri thức của bạn đã hòa vào cây!…".

## 3. Impacted Files
- `student/tree-engine.js`: full organic rewrite (canonical engine).
- `web/src/lib/tree-engine.js`: byte-identical copy.
- `web/src/lib/tree-engine.d.ts`: updated type contract.
- `web/src/components/tree/TreeProjector.tsx`: renamed copy + bloom banner + `isFlourished`.
- `student/app.js`: renamed tooltip + success message.
- `tests/e2e_flow_verification.mjs`: Step 29 adapted to the new ladder; Step 33 added.

## 4. Verification & Testing
- **Syntax:** `node --check` on `student/tree-engine.js`,
  `web/src/lib/tree-engine.js`, `student/app.js`, `tests/e2e_flow_verification.mjs`
  — all exit 0.
- **Parity:** SHA-256 of the student and web engine copies are identical
  (`C75C4D77…ADC2CC`); Step 33a re-asserts byte equality at runtime.
- **e2e:** `node v2/tests/e2e_flow_verification.mjs` → **529 passed, 0 failed**
  (baseline 502; **+27**). Step 33 covers engine parity, the five-stage ladder +
  `isFlourished`, dewdrop anchor aliases + a 48-dewdrop overlap-free case, a
  five-stage draw pass over a curve-capable stub (asserting `quadraticCurveTo`
  and `bezierCurveTo` were used), the seed-vs-bloom hitbox counts, and the
  renamed projector/SPA copy with a stale-"Quả" guard.
- **Build:** `npm run build` in `v2/web` → exit 0; `/tree/[id]` registered.
- **Rollback Strategy:** `git revert` the phase commit. The engine has no data
  or schema dependency; the byte-identical web copy is regenerated from the
  student source. No migration was involved.
