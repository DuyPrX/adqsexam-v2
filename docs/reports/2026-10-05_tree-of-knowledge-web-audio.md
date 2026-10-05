# Change Report: Tree of Knowledge — Procedural Web Audio Effects (Phase 8.3)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Give the Tree of Knowledge a zero-dependency, procedural sound
  layer: a gentle water-drop chime when a knowledge dewdrop appears, and an
  ethereal wind-chime arpeggio when the whole class reaches 100% bloom (P = 1.0).
- **Root Cause / Motivation:** The activity was purely visual. In a classroom the
  projector is often turned away from the teacher (who is managing the room), so
  an audible cue that a submission landed — and a distinct celebration at
  completion — materially improves the shared experience without shipping any
  audio assets. Everything is synthesized at runtime, so there is nothing to
  download and no licensing surface.

## 2. Technical Implementation Details

### Audio engine
- `student/tree-audio.js` (canonical ES module) and `web/src/lib/tree-audio.ts`
  (TypeScript port for the Next.js app). The two live on opposite sides of a
  bundler boundary — the SPA loads a plain module over HTTP, the teacher app is
  compiled — so they are parallel copies with identical public surfaces.
- **Lazy AudioContext.** `getAudioContext()` returns null when `window`/`AudioContext`
  is absent, so importing the module under Node (SSR or the e2e harness) is safe.
- **Autoplay Policy.** `resumeAudioContext()` awaits `ctx.resume()` only while
  `state === 'suspended'`, and both play helpers bail unless `state === 'running'`,
  so a call from a background Realtime event can never throw or warn.
- **Mute persistence.** `adqs_tree_muted` in `localStorage`; the initial read is
  wrapped in try/catch because the key is read at module scope.
- **`playDewdropSound(vitality)`.** One sine oscillator: a frequency chirp
  (`×0.85 → ×1.8 → ×1.1`) with a snap attack and organic decay. Base pitch is
  `750 + clamp(vitality, 0.2, 1.0) × 250` (800–1000 Hz), so a lively class sounds
  brighter. All exponential targets are > 0 (an exponential ramp cannot reach 0).
- **`playBloomFanfare()`.** Six pentatonic sines (C5–E6) staggered 120 ms apart,
  each with a ~1.2 s bell envelope so the notes ring into a chord.

### Teacher projector (`TreeProjector.tsx`)
- `muted` state synced from `isAudioMuted()` after mount (avoids an SSR/hydration
  desync) plus a `🔊 / 🔇` toggle in the action bar; the click resumes the context
  and flips the persisted flag.
- A capture-phase `pointerdown` listener unlocks the AudioContext on the first
  click anywhere, then removes itself.
- Vitality is derived through the same pure `computeTreeState()` the canvas uses,
  so the chime always matches the tree on screen.
- **Edge-triggered sound:** a ref compares the previous submission count so a
  chime fires once per NEW row (an UPDATE echo or re-render cannot replay it);
  a second ref latches the single `false → true` flourish transition for the
  fanfare.

### Student SPA (`app.js`, `index.html`, `styles.css`)
- `submitTreeAnswer` awaits `resumeAudioContext()` (the click is the gesture)
  before the RPC, then plays `playDewdropSound(state.treeData.vitality)` on
  success — independent of the Realtime echo, so a weak connection still chimes.
- `renderTree` plays `playBloomFanfare()` when `isFlourished` first becomes true,
  latched via `state.treeFlourished` (reset whenever a session loads).
- New `#btnTreeAudioToggle` in a `tree-workspace__header` row, wired in
  `bindTreeControls`, with a first-tap gesture unlock for students who never
  touch the toggle. `syncTreeAudioToggle` reflects the persisted state.

## 3. Impacted Files
- `student/tree-audio.js`: procedural engine (new).
- `web/src/lib/tree-audio.ts`: typed port (new).
- `web/src/components/tree/TreeProjector.tsx`: mute toggle, gesture unlock,
  chime on new submission, fanfare on flourish transition, `computeTreeState` import.
- `student/app.js`: audio import, submit chime, realtime flourish latch, toggle wiring.
- `student/index.html`: `#btnTreeAudioToggle` in the workspace header.
- `student/styles.css`: `.tree-workspace__header` + `.btn-icon-muted`.
- `tests/e2e_flow_verification.mjs`: Step 34 added.

## 4. Verification & Testing
- **Syntax:** `node --check` on `student/tree-audio.js`, `student/app.js`,
  `tests/e2e_flow_verification.mjs` — all exit 0.
- **e2e:** `node v2/tests/e2e_flow_verification.mjs` → **553 passed, 0 failed**
  (baseline 529; **+24**). Step 34 covers the export surface, mute
  persistence/restore, dewdrop synthesis (1 osc + 1 gain, 2 exponential frequency
  ramps + 2 gain ramps, start/stop, zero NaN), vitality→pitch monotonicity, the
  six-note 120 ms-staggered fanfare, mute suppression, suspended-context refusal
  + gesture resume, the no-window no-op path, and the projector/SPA wiring.
- **Build:** `npm run build` in `v2/web` → exit 0; `/tree/[id]` registered.
- **Rollback Strategy:** `git revert` the phase commit. The audio engine has no
  data or schema dependency and is inert until a user gesture, so removing it
  degrades silently to the pre-8.3 silent experience.
