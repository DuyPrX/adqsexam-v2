# Roadmap: Autonomous 3D Tree Procedural Engine R&D & Visual Polish (Phase 10.4)

- **Created:** 2026-10-09
- **Last Updated:** 2026-10-09 14:10 (UTC+7)
- **Overall Status:** `COMPLETED`

## 1. Objective
Overhaul the procedural 3D Tree Arena to deliver studio-grade botanical aesthetics inspired by *Genshin Impact*, *The Witness*, and *Monument Valley*. Implement 4 distinct botanical species archetypes (Autumn Oak, Ancient Banyan, Highland Pine, Weeping Sakura), true 4-stage biological metamorphosis (from slender green cotyledon sprout to triumphant golden champion), visible supporting wood architecture, root buttresses, celestial god rays, and celebratory visual effects while ensuring 100% test pass rate and zero console warnings.

---

## 2. Execution Phases

### Phase 1: Specifications & Botanical Archetype Design `[x]`
- [x] Design distinct architectural parameters for the 4 tree species (Oak, Banyan, Pine, Sakura).
- [x] Define mathematical growth stages (Sprout 0.0->0.20, Sapling 0.20->0.55, Canopy 0.55->0.95, Golden Latch >=1.0).
- [x] Refine color palettes in `tree3d.ts` for botanical vibrancy and lighting harmony.

### Phase 2: Core Procedural Engine & Metamorphosis (`ProceduralTree3D.tsx`) `[x]`
- [x] Implement cotyledon sprout mode (vitality < 0.20) with green stem and twin curved seedling leaves.
- [x] Implement species-specific trunk curvatures, root buttresses, and branch fork geometries.
- [x] Implement tiered cloud pads and cascading foliage per species archetype.
- [x] Implement Golden Latch celebration FX (celestial light beam, orbiting sparkles, glowing blossoms, runic ring pulse).

### Phase 3: Stage Atmosphere & Lighting Integration (`ArenaStage3D.tsx`) `[x]`
- [x] Verify stage lighting, shadow maps, and diorama platform compatibility.
- [x] Enhance atmosphere with team-specific particle hints and celebratory bloom.

### Phase 4: Verification, Audit & Quality Gates `[x]`
- [x] Run `npm run typecheck` and `npm run build` in `v2/web` (0 errors).
- [x] Verify Step 47 & 47e unit/contract assertions in `tests/e2e_flow_verification.mjs`.
- [x] Update `docs/modified_files.md` and generate comprehensive change report.

---

## 3. Chronological Progress Log
- **2026-10-09 14:10:** Roadmap initialized. Phase 1 specifications designed.
- **2026-10-09 14:12:** Phase 2 and Phase 3 completed. 4 distinct species archetypes, cotyledon sprout metamorphosis, and Golden Latch celebration FX implemented and verified in Next.js Turbopack build.
- **2026-10-09 14:14:** Phase 4 completed. All verification checks passed, ledger and technical report documented. Overall Status: COMPLETED.

## 4. Blockers & Architectural Decisions
- **Decision:** Use procedural math inside `ProceduralTree3D.tsx` to branch into 4 species archetypes based on `teamNumber` (1: Oak, 2: Banyan, 3: Pine, 4: Sakura), while sharing the common smooth growth lerp and wind physics loop.
- **Decision:** Keep cotyledon seedling phase clean and slender with green material (`#52b788`) so 0-20% vitality genuinely looks like a tender plant sprout emerging from the ground.
