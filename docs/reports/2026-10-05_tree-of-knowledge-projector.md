# Change Report: Tree of Knowledge — Teacher Projector View & Realtime Stream (Phase 7.3)

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Build the teacher-facing half of "Cây Tri Thức": launch a session
  from a class, project it full-screen for the classroom, stream student answers live
  into a growing procedural tree, inspect individual fruits, and close/export the
  session.
- **Root Cause / Motivation:** Phase 7.1 shipped the schema/RPC/Realtime and Phase 7.2
  shipped the deterministic renderer, but the renderer had no caller and
  `tree_sessions` had no UI — the feature was unreachable end-to-end. Phase 7.3 supplies
  the missing orchestration layer: persistence helpers, a React host for the engine, and
  the projector route.

## 2. Technical Implementation Details
- **Architecture / Core Logic:**
  - `web/src/lib/tree.ts` centralises session persistence. `TREE_SESSION_COLUMNS` /
    `TREE_SUBMISSION_COLUMNS` are explicit (mirroring `EXAM_COLUMNS`) so a future column
    cannot silently arrive `undefined` while TypeScript still believes the old shape.
  - `getTreeSession()` fetches the class name **and** `class_members(count)` — the
    participation denominator `N` — in one round-trip via
    `classes!inner(name, class_members(count))`. `N` is floored at 1 because the engine
    divides by it.
  - `createTreeSession()` deliberately omits `tree_seed`, letting the column default
    mint it server-side: a client-generated seed could collide across two sessions
    created in the same millisecond and render identical trees.
  - `TreeCanvas.tsx` owns only the canvas element's lifetime. It computes
    `computeTreeState()` in a `useMemo` and re-points the running renderer at new data,
    so a Realtime update is just a new `submissions` prop — there is no incremental
    "grow one fruit" bookkeeping that could drift from a cold render.
  - `exportImage()` renders into a **detached** canvas at a fixed 2400×1800 rather than
    exporting the viewport-shaped one, so the memory picture does not vary with the
    teacher's window.
  - `TreeProjector.tsx` derives the countdown from `created_at + time_limit_minutes`,
    subscribes to `postgres_changes` filtered on `session_id=eq.${id}`, and merges rows
    by `id` (INSERT appends, UPDATE replaces).
  - The engine is copied to `web/src/lib/tree-engine.js` (byte-identical;
    hash-verified) with a hand-written `tree-engine.d.ts` for the typed contract. Step
    30f asserts the two copies stay identical so the projector and the students' phones
    cannot disagree about the tree.
- **Database Migrations:** None. Phase 7.3 is pure client/UI over the Phase 7.1 schema.
- **API Contracts:** No new endpoints. Two deliberate env/URL conventions:
  `NEXT_PUBLIC_STUDENT_APP_URL` builds the QR join URL (`/tree/join?session=<id>`),
  falling back to the current origin for local development; a QR library (`qrcode`
  + `@types/qrcode`) was added because none existed in the app.

## 3. Impacted Files
- `web/src/lib/types.ts`: Added `TreeSessionRow`, `TreeSubmissionRow`, `TreeSessionDetail`.
- `web/src/lib/tree.ts`: **New.** `createTreeSession`, `getTreeSession`,
  `getTreeSubmissions`, `endTreeSession`, column constants, defaults and similarity bounds.
- `web/src/lib/tree-engine.js`: **New.** Byte-identical copy of the Phase 7.2 engine so
  Next.js can bundle it under `@/lib`.
- `web/src/lib/tree-engine.d.ts`: **New.** Typed declaration of the engine's public surface.
- `web/src/components/tree/TreeCanvas.tsx`: **New.** React host; `exportImage()` via ref.
- `web/src/components/tree/TreeQrCode.tsx`: **New.** Data-URL QR with a graceful fallback.
- `web/src/components/tree/TreeProjector.tsx`: **New.** Sidebar (question, badges, timer,
  progress, QR), canvas stage, fruit tooltip, realtime subscription, action bar.
- `web/src/components/tree/CreateTreeSessionModal.tsx`: **New.** Session launcher.
- `web/src/app/tree/[id]/page.tsx`: **New.** Projector route (server-fetched session +
  submissions, `notFound()` on unknown id).
- `web/src/components/ClassRosterManager.tsx`: Added the `🌱 Bắt đầu Cây Tri Thức` button
  and modal host.
- `web/.env.example`, `web/package.json`, `web/package-lock.json`: student-app URL var,
  `qrcode` dependency, `@types/qrcode` devDependency.
- `tests/e2e_flow_verification.mjs`: Added Step 30 (28 assertions).

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npx tsc --noEmit` — clean.
  - `npm run build` — exits 0; `/tree/[id]` registered as a dynamic (ƒ) route alongside
    the existing routes.
  - `node tests/e2e_flow_verification.mjs` against the local Supabase stack.
- **Results:**
  - Build: `✓ Compiled successfully`, `Finished TypeScript`, 5/5 static pages generated.
  - e2e: `RESULT: 426 passed, 0 failed` (up from 398 at the end of Phase 7.2; **+28**
    Step 30 assertions). Step 30 covers:
    - **30a** class + 3 members created.
    - **30b** `createTreeSession` inserts; thresholds round-trip; new session is active
      with `ended_at = null`; `tree_seed` minted server-side as an integer; an
      out-of-range `max_similarity` is rejected with a teacher-readable message.
    - **30c** `getTreeSession` returns the class name and `total_students = 3`; an unknown
      id yields `null` rather than throwing.
    - **30d** two answers submit and round-trip in `fruit_index` order with identity +
      word count; another session's rows are excluded.
    - **30e** the fetched rows feed the engine **unchanged** and every one anchors;
      `k`/`n`/`P` = 2/3/0.667; vitality in `[0.2, 1]`; both column lists cover every field
      the renderer reads; the state is reproducible from the stored seed and a different
      seed moves the anchors.
    - **30f** the web engine copy is byte-identical to `student/tree-engine.js`.
    - **30g** `endTreeSession` sets `is_active = false` + `ended_at`, persists on reload,
      `submit_tree_answer` then returns `SESSION_INACTIVE`, and ending an unknown id reports
      a clear error.
    - **30h** cleanup: session deleted, class deleted.
- **Rollback Strategy:** Revert the Phase 7.3 additions — the `tree/` components and route,
  `tree.ts` / `tree-engine.{js,d.ts}` in `web/src/lib`, the two `types.ts` additions, the
  `ClassRosterManager` button, the Step 30 block, and `npm uninstall qrcode @types/qrcode`.
  No migration or data change is involved, so rollback is purely a client-code revert.
