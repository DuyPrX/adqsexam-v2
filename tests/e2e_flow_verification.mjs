/**
 * ============================================================================
 * ADQS Exam v2 — Phase 5 End-to-End Flow Verification
 * ----------------------------------------------------------------------------
 * Exercises the complete production path against the LOCAL Supabase stack:
 *
 *   1. Teacher signs in, creates an exam + 3 questions (exams, question_bank)
 *   2. Seeds a candidate into `students`
 *   3. Student calls verify_and_acquire_session
 *   4. Student calls get_student_exam_payload  -> asserts ZERO answer leaks
 *   5. Student sends 2x record_student_heartbeat with blur increments
 *   6. Student calls submit_exam_result
 *   7. Teacher client detects the submission and the score matches expected
 *   8. Student receives the teacher-facing Realtime event (D2)
 *   9. Post-submit guards (re-login blocked, tables unreadable)
 *  10. Certificate verification (Phase 5.1): a passing result verifies as
 *      valid, while a failing result and an unknown UUID verify as invalid.
 *  11. Self-practice authorization (Phase 5.2): verify_student_practice accepts
 *      a rostered (student_code, class_name) pair and rejects everything else.
 *  12. Scheduling window (Phase 5.4): verify_and_acquire_session rejects before
 *      starts_at / after ends_at / when is_active = false, and accepts inside.
 *  13. Safe question CRUD (Phase 5.4): update_exam_questions_safe rewrites the
 *      bank freely before any submission, then locks structure afterwards.
 *  14. Multi-variant sub-sampling (Phase 5.4): generateExamVariants draws K of N
 *      with contiguous 1..K positions, unique codes, and synced answer keys.
 *  15. Timezone helpers (Phase 5.5): the local <-> UTC converters round-trip the
 *      exact same instant and match the platform's own offset.
 *  16. Hard delete (Phase 5.5): an exam with 0 submissions is wiped from every
 *      dependent table.
 *  17. Soft delete / Trash (Phase 5.5): an exam with submissions is soft-deleted,
 *      becomes unreachable to students, and can be restored.
 *  18. Re-grading (Phase 5.5): editing an answer key + recalculate_exam_scores
 *      updates the stored score to match.
 *  19. Rule-engine DOCX parsing (Phase 5.6): sample/test4.docx yields 22 MCQ +
 *      2 TRUE_FALSE with uppercase A-D Part II sub-items and trailing ĐÁP ÁN
 *      keys, no answer-block leakage, in well under the CPU budget.
 *  20. Smart AI fallback (Phase 5.6): a structurally mismatched document in
 *      `auto` mode trips the anomaly linter and hands over to Engine 2.
 *  21. pg_cron log retention (Phase 5.7): purge_expired_exams() prunes stale
 *      cron.job_run_details rows and stays idempotent.
 *  22. Worker keep-alive (Phase 5.7): the scheduled handler pings PostgREST and
 *      never rejects on a failed/unbound ping.
 *  23. Practice-enabled exams (Phase 5.8): allow_practice gates the key-bearing
 *      get_practice_exam_payload; order + keys are preserved; practice persists
 *      nothing; a shuffled official submission grades correctly via re-mapping.
 *  24. Practice shuffle toggle (Phase 5.9): the student's toggle reorders the
 *      questions while every key/explanation travels with its question, and the
 *      OFF branch enforces the original `position ASC` order.
 *  25. Class rosters + flexible PIN auth (Phase 6.1): import_class_to_exam
 *      populates the exam whitelist, and NONE / GLOBAL / INDIVIDUAL are enforced
 *      by verify_and_acquire_session (custom PIN > DOB DDMM fallback).
 *  26. Teacher web roster + PIN config (Phase 6.2): EXAM_COLUMNS carries the PIN
 *      columns, the CSV template ships a UTF-8 BOM + the exact headers and
 *      round-trips through parseStudentRosterFile, class CRUD works through the
 *      client SDK, and the saved PIN actually gates admission.
 *  27. Student roster picker (Phase 6.3): get_exam_roster serves a sanitised
 *      candidate list (NEVER pin/dob) for an OPEN exam and refuses trashed /
 *      closed / not-yet-open / ended / unknown ones, and the identity picked from
 *      that roster plus the typed PIN passes verify_and_acquire_session — including
 *      the reload path, which must resend the PIN.
 *  28. Tree of Knowledge (Phase 7.1): submit_tree_answer enforces the minimum word
 *      count and the trigram similarity ceiling, assigns sequential fruit indices,
 *      and updates in place on resubmission; anon can read the tree through the
 *      SECURITY DEFINER RLS predicate but not tree_sessions itself; the class FK
 *      is RESTRICT; and tree_submissions is in the realtime publication.
 *  29. Tree of Knowledge renderer (Phase 7.2): the procedural engine is strictly
 *      deterministic on `tree_seed` (identical inputs -> byte-identical anchors and
 *      palette, a different seed -> different anchors), maps participation onto the
 *      five growth stages (P=0 -> seed, P=1.0 -> maximum recursion depth), places one
 *      non-overlapping in-bounds fruit anchor per submission on any canvas, and
 *      derives vitality from the mean submission latency (fast -> bright, at the
 *      limit -> dull).
 *  30. Tree of Knowledge projector (Phase 7.3): the teacher-web data layer creates a
 *      session with a server-minted `tree_seed`, loads it with the class size `N` the
 *      participation ratio divides by, round-trips its submissions, and closes it via
 *      `endTreeSession`; the web copy of the engine is byte-identical to the student
 *      copy, and the columns the web layer selects cover every field the renderer
 *      reads.
 *  31. Tree of Knowledge student participation (Phase 7.4): `get_public_tree_session`
 *      serves the check-in payload (question, min words, seed, class size, sanitised
 *      candidates) to anon without ever leaking `pin`/`dob`, refuses an unknown or
 *      closed session, and the SPA's word counter matches the RPC's counting rule
 *      exactly (whitespace-collapsed, empty = 0); an end-to-end run then loads the
 *      session, picks a candidate, is refused for similarity, and succeeds on a
 *      rewrite with the fruit visible on the tree.
 *  32. Exam candidates + flexible identity (Phase 8.1): the three re-signatured RPCs
 *      exist as a SINGLE non-overloaded signature each and are anon-callable;
 *      `get_exam_roster(p_for_practice := true)` returns the roster of a
 *      practice-enabled exam that is CLOSED for the official sitting (while the
 *      official call still refuses it, a trashed exam stays invisible, and `pin`/`dob`
 *      never leak); `get_practice_exam_payload` authorises by `(full_name,
 *      class_name)` with no `student_code`; `verify_student_practice` does the same
 *      for the personal-.docx path; the teacher-web candidate CRUD helpers round-trip
 *      (auto-generated code, friendly duplicate error, explicit-null clears, refused
 *      delete once a result exists); and the shipped SPA exposes no visible
 *      student-code input while declaring both top-level views.
 *  33. Organic redesign (Phase 8.2): the web engine copy is still byte-identical to the
 *      student copy; `computeTreeState` maps P = 0 / 0.10 / 0.30 / 0.70 / 1.0 onto
 *      SEED / SPROUT / SAPLING / MATURING / BLOOM with `isFlourished` true only at
 *      P = 1.0; the renamed `layoutDewdropAnchors` / `hitTestDewdrops` behave
 *      identically to their fruit aliases and keep a dense 48-dewdrop canopy
 *      overlap-free; `TreeRenderer` draws all five stages (curved branches +
 *      Bézier teardrops) on a curve-capable stub and caches one hitbox per
 *      submission at bloom; and the projector/SPA copy has been renamed from
 *      "Quả" to "Giọt sương tri thức" / "dưỡng chất".
 *  34. Procedural Web Audio (Phase 8.3): `tree-audio.js` exports the full surface and
 *      defaults to unmuted; the mute flag round-trips through `localStorage` and is
 *      restored on a fresh import; a mock `AudioContext` proves the dewdrop renders
 *      one oscillator + gain with exponential frequency/gain ramps and no NaN, that
 *      vitality raises the pitch, and that the fanfare renders six notes staggered
 *      120ms apart; mute silences everything and a suspended context refuses to play
 *      until `resumeAudioContext()`; the engine no-ops with no `window`; and the
 *      projector + SPA are wired to it (mute toggle, submit chime, bloom fanfare).
 *  39. Configuration externalization (Phase 9): `web/.env.example` documents every
 *      variable (and never prefixes a secret with `NEXT_PUBLIC_`); `student/
 *      config.example.js` defines only `window.__APP_CONFIG__` and carries no live
 *      endpoint; the SPA's config is untracked and loaded before its module; the SPA
 *      resolvers strip trailing slashes, accept the legacy anon-key alias, report an
 *      unconfigured deployment, and build a practice endpoint with no doubled
 *      separator; the web resolvers prefer the modern Supabase key names while still
 *      honouring the legacy ones, treat a blank value as absent, and throw an
 *      actionable error when unconfigured; the AI picker derives its default label and
 *      provider-gated shortlist from the environment; and the Worker resolves both its
 *      model (`AI_MODEL_NAME`, legacy aliases still honoured) and its CORS origins
 *      (`ALLOWED_ORIGINS`) from bindings — proven by driving the real Hono app.
 *  40. Top-first exam code entry & flexible candidate lookup (Phase 8.8): the exam
 *      code physically precedes every identity field in both the official form and
 *      the practice panel; the exam banner and its explicit verify trigger exist;
 *      `readIdentity` no longer hard-blocks on a missing roster; `normalizeText`
 *      (executed) trims, collapses whitespace and unifies NFC; the SQL normalizes
 *      both the caller's input and the stored row, keeps `student_code` as a fast
 *      path with `(class_name, full_name)` as the fallback, and retains all five
 *      security guards; and a live round-trip authenticates a candidate from a
 *      NULL code despite case/whitespace differences while refusing a wrong name,
 *      a wrong class and an unknown identity.
 *
 * Usage:
 *   node v2/tests/e2e_flow_verification.mjs
 *
 * Env overrides:
 *   SB_URL          default http://127.0.0.1:54321
 *   SB_PUBLISHABLE  default local publishable key
 *   SB_SECRET       default local service_role key (admin only, for seeding)
 *
 * Exit code 0 = every assertion passed.
 * ============================================================================
 */

const SB_URL = process.env.SB_URL || 'http://127.0.0.1:54321';
const SB_PUBLISHABLE =
  process.env.SB_PUBLISHABLE || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
// Local-only service_role key: used solely to create the teacher auth user.
const SB_SECRET =
  process.env.SB_SECRET ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
// Local Supabase database container, used only by Step 21 (cron.* is not
// reachable through PostgREST, so its rows are probed over psql).
const SB_DB_CONTAINER = process.env.SB_DB_CONTAINER || 'supabase_db_v2';

// supabase-js lives in the teacher app's node_modules; resolve it by URL so the
// script works regardless of the current working directory.
const { createClient } = await import(
  new URL('../web/node_modules/@supabase/supabase-js/dist/index.mjs', import.meta.url).href
);

// Phase 5.4 Step 14 exercises the web app's TypeScript shuffle module directly,
// and Phase 5.6 Steps 19-20 load the Worker's parser + Hono app. Node strips
// types natively but cannot handle every TS construct the sources use
// (parameter properties, decorators, enums), nor does it resolve the
// extensionless `./utils` imports or the Worker's own node_modules. A single
// module hook covers all three: it retries bare specifiers against the Worker
// package, appends `.ts` for extensionless relatives, and transpiles any `.ts`
// file with the Worker's own esbuild.
const { register } = await import('node:module');
const WORKER_NODE_MODULES = new URL('../worker/node_modules/', import.meta.url).href;
const WORKER_PACKAGE = new URL('../worker/package.json', import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const WORKER_NODE_MODULES = ${JSON.stringify(WORKER_NODE_MODULES)};
const WORKER_PACKAGE = ${JSON.stringify(WORKER_PACKAGE)};
const { transform } = await import(new URL('esbuild/lib/main.js', WORKER_NODE_MODULES).href);

function isBare(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (isBare(specifier)) {
      return nextResolve(specifier, { ...context, parentURL: WORKER_PACKAGE });
    }
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`)}`,
);
const { generateExamVariants, shufflePartitioned } = await import(
  new URL('../web/src/lib/shuffle.ts', import.meta.url).href
);

// Phase 5.9 Step 24 — the practice ordering helpers are dependency-free, so the
// suite exercises the SAME module the student SPA imports (not a copy).
const {
  shuffledOrder, partitionAndShuffleOrder, partitionAndShuffleQuestions, readShuffleToggle,
} = await import(
  new URL('../student/practice-order.js', import.meta.url).href
);

// Phase 8.5 Step 36 — the exam navigation + theme/font logic is likewise
// dependency-free and DOM-free, so the auto-advance policy, the index clamping,
// the theme/font cycles and the palette cell model are all executed for real.
const {
  THEME_CYCLE, FONT_CYCLE, FONT_LABELS, AUTO_ADVANCE_MS, AUTO_ADVANCE_KEY,
  normalizeTheme, nextTheme, nextFontStep, clampQuestionIndex,
  shouldAutoAdvance, readAutoAdvancePreference, writeAutoAdvancePreference,
  buildPaletteCells, getUnansweredQuestions,
} = await import(new URL('../student/exam-nav.js', import.meta.url).href);

// Phase 7.2 Step 29 — the Tree of Knowledge engine. `computeTreeState()` and the
// pixel-layout/hit-test helpers are pure and DOM-free, so the suite exercises the
// SAME module the student SPA ships. `TreeRenderer` is additionally driven through
// a stub 2D context to prove `resize()` / `render()` / `getFruitAt()` work headless.
const {
  computeTreeState, createPRNG, layoutFruitAnchors, hitTestFruits,
  layoutDewdropAnchors, hitTestDewdrops,
  themeForSeed, themeIndexForSeed, MAX_BRANCH_DEPTH, TREE_STAGES, STAGE_LADDER,
  TEAM_NUMBERS, getTeamSeed, clampTeamNumber,
} = await import(new URL('../student/tree-engine.js', import.meta.url).href);

// Phase 5.5 Step 15 exercises the timezone helpers. `date.ts` has no imports of
// its own, so it loads directly through the same extension-resolving hook.
const { toLocalDatetimeString, toUtcIsoString, daysUntil } = await import(
  new URL('../web/src/lib/date.ts', import.meta.url).href
);

// Phase 5.6 Steps 19-20 — the Worker parser and the full Hono app.
const { preprocessDocx } = await import(
  new URL('../worker/src/parser/xml-preprocessor.ts', import.meta.url).href
);
const { extractWithRules } = await import(
  new URL('../worker/src/parser/rule-engine.ts', import.meta.url).href
);
const { detectParsingAnomalies } = await import(
  new URL('../worker/src/parser/anomaly-linter.ts', import.meta.url).href
);
const { zipSync, strToU8 } = await import(
  new URL('../worker/node_modules/fflate/esm/index.mjs', import.meta.url).href
);
const { default: workerApp } = await import(
  new URL('../worker/src/index.ts', import.meta.url).href
);
const { existsSync, readFileSync } = await import('node:fs');
// Step 21 seeds/inspects cron.job_run_details, which is not API-exposed.
const { execFileSync } = await import('node:child_process');

// Phase 6.2 Step 26 — the teacher-web persistence + template modules. These are
// dependency-free (or, for excel.ts, borrow the web app's own SheetJS), so the
// suite asserts against the SAME code the browser ships rather than a copy.
const { EXAM_COLUMNS, updateExamMetadata, saveExam, PersistenceError } = await import(
  new URL('../web/src/lib/exams.ts', import.meta.url).href
);
const { STUDENT_TEMPLATE_HEADERS, buildStudentCsvTemplate, studentTemplateFilename } =
  await import(new URL('../web/src/lib/studentTemplate.ts', import.meta.url).href);
const { importClassToExam, saveClassMembers, listClasses } = await import(
  new URL('../web/src/lib/classes.ts', import.meta.url).href
);
const { parseStudentRosterFile } = await import(
  new URL('../web/src/lib/excel.ts', import.meta.url).href
);

// Phase 7.3 Step 30 — the teacher-web Tree of Knowledge data layer.
const {
  createTreeSession, getTreeSession, getTreeSubmissions, endTreeSession, startTreeSession,
  TREE_SESSION_COLUMNS, TREE_SUBMISSION_COLUMNS, TREE_SESSION_DEFAULTS,
  // Phase 9.2 Step 45 — the pure pre-flight planning helpers.
  buildInitialAssignments, balanceTeamAssignments, countActiveMembersPerTeam,
  brainstormTargetScore, computeTeamProgress,
} = await import(new URL('../web/src/lib/tree.ts', import.meta.url).href);

// Phase 7.4 Step 31 — the student SPA's answer normalisation, imported from the
// shipped module so the suite asserts the code the browser runs (not a copy).
const { countTreeWords, normalizeAnswerText, treeWordCounterLabel } = await import(
  new URL('../student/tree-words.js', import.meta.url).href
);

// Phase 8.1 Step 32 — the teacher-web candidate CRUD (per-exam whitelist).
const {
  listExamCandidates, addExamCandidate, updateExamCandidate, deleteExamCandidate,
} = await import(new URL('../web/src/lib/candidates.ts', import.meta.url).href);

// Phase 9 Step 39 — the student SPA's config resolution + the teacher web's env
// resolvers. Both are dependency-free and DOM-free, so the suite executes the
// SAME code each app ships rather than asserting against a copy. `student/
// app-config.js` is a relative `.js` module, hence the explicit extension.
const { stripTrailingSlashes, resolveSupabaseConfig, resolveWorkerBaseUrl } = await import(
  new URL('../student/app-config.js', import.meta.url).href
);
const {
  getSupabaseUrl, getSupabasePublishableKey, getSupabaseSecretKey,
  getAiModelName, getAiProvider, resolveStudentAppBaseUrl,
  getExtractorEndpoint, getExtractorInternalSecret,
} = await import(new URL('../web/src/lib/env.ts', import.meta.url).href);
const { buildModelOptions, CUSTOM_MODEL } = await import(
  new URL('../web/src/lib/ai.ts', import.meta.url).href
);

const TEACHER = { email: 'e2e.teacher@adqsexam.local', password: 'e2e-password-123' };
const EXAM = {
  code: 'E2E' + String(Math.floor(100 + Math.random() * 900)), // 6 chars
  title: 'E2E Phase 5 Verification',
  duration: 45,
};
const STUDENT = {
  code: 'E2EHS01',
  fullName: 'Nguyễn Văn E2E',
  className: '12E2E',
};
const FAILING_STUDENT = {
  code: 'E2EHS02',
  fullName: 'Trần Thị E2E',
  className: '12E2E',
};
// Phase 5.4 — dedicated actors so the scheduling / CRUD steps stay isolated.
const SCHED_EXAM = {
  code: 'SCH' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Scheduling Window',
  duration: 30,
};
const SCHED_STUDENT = {
  code: 'E2ESCH01',
  fullName: 'Lê Văn Lịch',
  className: '12SCH',
};
const EDIT_EXAM = {
  code: 'EDT' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Question CRUD',
  duration: 30,
};
const EXPECTED_SCORE = 2.5; // MCQ 1.0 + TRUE_FALSE 3/4 = 0.5 + SHORT_ANSWER 1.0
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Phase 5.5 — dedicated exams for the deletion / re-grading steps.
const HARD_DEL_EXAM = {
  code: 'HDL' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Hard Delete',
  duration: 30,
};
const SOFT_DEL_EXAM = {
  code: 'SDL' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Soft Delete',
  duration: 30,
};
const SOFT_DEL_STUDENT = {
  code: 'E2ESDL01',
  fullName: 'Phạm Thị Rác',
  className: '12SDL',
};
// Phase 5.8 — practice-enabled exam + three isolated candidates: one for the
// practice-by-code flow, one for the shuffled official submission (with remap),
// and one control that skips the remap to prove the mapping is load-bearing.
const PRACTICE_EXAM = {
  code: 'PRC' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Practice Enabled',
  duration: 30,
};
const PRACTICE_STUDENT = { code: 'E2EPRC01', fullName: 'Vũ Thị Luyện', className: '12PRC' };
const SHUFFLE_STUDENT = { code: 'E2EPRC02', fullName: 'Đỗ Văn Trộn', className: '12PRC' };
const SHUFFLE_CONTROL_STUDENT = { code: 'E2EPRC03', fullName: 'Hoàng Văn Lỗi', className: '12PRC' };
// Questions for PRACTICE_EXAM, in the `position` order the RPC must preserve.
const PRACTICE_QUESTIONS = [
  {
    question_text: 'Thủ đô của nước Pháp là gì?',
    question_type: 'MULTIPLE_CHOICE',
    options: ['Paris', 'Lyon', 'Nice', 'Marseille'],
    correct_answer: 1,
    explanation: 'Paris là thủ đô của Pháp.',
  },
  {
    question_text: 'Xét tính đúng sai:',
    question_type: 'TRUE_FALSE',
    options: ['a) 1 + 1 = 2', 'b) 2 > 3', 'c) Trái Đất quay', 'd) 5 = 5'],
    correct_answer: ['Đ', 'S', 'Đ', 'Đ'],
    explanation: null,
  },
  {
    question_text: 'Tính 2 + 3 = ?',
    question_type: 'SHORT_ANSWER',
    options: [],
    correct_answer: '5',
    explanation: 'Phép cộng cơ bản.',
  },
];
// Fully-correct answers keyed by the ORIGINAL 0-based position.
const PRACTICE_CORRECT_ANSWERS = [
  { selectedIndex: 1 },
  { selectedAnswers: ['Đ', 'S', 'Đ', 'Đ'] },
  { selectedAnswerText: '5' },
];
const PRACTICE_FULL_SCORE = 3; // 1.0 + 1.0 + 1.0
// A deliberately NON-identity permutation: display slot -> original position.
// If the client failed to re-map, every answer would land on the wrong question.
const SHUFFLE_ORDER = [2, 0, 1];

// Phase 6.1 — class roster management + flexible PIN authentication.
// One class, three members covering every INDIVIDUAL sub-case:
//   E2EPIN01 -> custom PIN (must win over any DOB)
//   E2EPIN02 -> no PIN, DOB 2008-09-05 -> '0509' fallback
//   E2EPIN03 -> neither -> no PIN required (the legacy-row compatibility case)
const PIN_EXAM = {
  code: 'PIN' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E PIN Auth',
  duration: 30,
};
const PIN_CLASS = {
  name: 'E2E-PIN-' + String(Math.floor(1000 + Math.random() * 9000)),
  academicYear: '2026-2027',
};
const PIN_MEMBER_CUSTOM = { code: 'E2EPIN01', fullName: 'Ngô Có Pin', dob: '2007-01-02', pin: 'CUSTOM9' };
const PIN_MEMBER_DOB    = { code: 'E2EPIN02', fullName: 'Lý Ngày Sinh', dob: '2008-09-05', pin: null };
const PIN_MEMBER_PLAIN  = { code: 'E2EPIN03', fullName: 'Trần Không Pin', dob: null, pin: null };
const PIN_GLOBAL_VALUE  = 'SHARED1';
// The DOB fallback is DDMM, so 2008-09-05 -> '0509'.
const PIN_DOB_EXPECTED  = '0509';

// Phase 6.2 — teacher-web class roster + PIN configuration.
// A dedicated exam so the client-SDK assertions never collide with the
// Step 25 PIN matrix, which leaves PIN_EXAM on INDIVIDUAL.
const CLASS_EXAM = {
  code: 'WEB' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Teacher Web Roster',
  duration: 30,
  globalPin: 'ROOM1',
};
const CLASS_PICK = {
  name: 'E2E-WEB-' + String(Math.floor(1000 + Math.random() * 9000)),
  academicYear: '2026-2027',
};
const CLASS_PICK_MEMBERS = [
  { code: 'E2EWEB01', fullName: 'Bùi Văn Web', dob: '2009-01-02', pin: null, team: 1 },
  { code: 'E2EWEB02', fullName: 'Đinh Thị Lớp', dob: null, pin: 'X9', team: 2 },
];

// Phase 6.3 — get_exam_roster powering the student SPA's roster picker.
// Two classes so the picker's class -> student cascade has something to group
// by, plus a member carrying BOTH a custom pin and a dob: if either key ever
// leaked into the payload, that row is where it would show.
const ROSTER_EXAM = {
  code: 'ROS' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Roster Picker',
  duration: 30,
  globalPin: 'ROSTER1',
};
const ROSTER_CLASS_A = 'E2E-ROSA-' + String(Math.floor(1000 + Math.random() * 9000));
const ROSTER_CLASS_B = 'E2E-ROSB-' + String(Math.floor(1000 + Math.random() * 9000));
const ROSTER_MEMBERS = [
  { code: 'E2EROS01', fullName: 'A Văn Nhất', className: ROSTER_CLASS_A, dob: '2008-09-05', pin: 'SECRET1' },
  { code: 'E2EROS02', fullName: 'B Thị Hai',  className: ROSTER_CLASS_A, dob: null,         pin: null },
  { code: 'E2EROS03', fullName: 'C Văn Ba',   className: ROSTER_CLASS_B, dob: '2009-01-02', pin: null },
];
// A trashed exam and a closed exam, to prove the roster is not an oracle for
// exams the student must not see.
const ROSTER_TRASH_EXAM = {
  code: 'ROT' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Roster Trashed',
  duration: 30,
};
const ROSTER_CLOSED_EXAM = {
  code: 'ROC' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Roster Closed',
  duration: 30,
};
const ROSTER_NOT_STARTED_EXAM = {
  code: 'RON' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Roster Not Started',
  duration: 30,
};
const ROSTER_ENDED_EXAM = {
  code: 'ROE' + String(Math.floor(100 + Math.random() * 900)),
  title: 'E2E Roster Ended',
  duration: 30,
};

// Phase 7.1 — Tree of Knowledge. A class with 5 members, plus a session whose
// numbers make each branch of submit_tree_answer reachable:
//   min_words = 10      -> a 3-word answer must be rejected
//   max_similarity=.50  -> an identical/paraphrased answer rejected, a genuinely
//                          different one accepted (measured 0.20 locally)
const TREE_CLASS = 'E2E-TREE-' + String(Math.floor(1000 + Math.random() * 9000));
const TREE_MEMBERS = [
  { code: 'E2ETREE01', name: 'Trần Văn Một', team: 1 },
  { code: 'E2ETREE02', name: 'Lê Thị Hai', team: 1 },
  { code: 'E2ETREE03', name: 'Phạm Văn Ba', team: 2 },
  { code: 'E2ETREE04', name: 'Hoàng Thị Bốn', team: 2 },
  { code: 'E2ETREE05', name: 'Ngô Văn Năm', team: 3 },
];
const TREE_SESSION = {
  title: 'E2E Cây tri thức',
  question: 'Theo em, tri thức là gì và nó được hình thành như thế nào?',
  minWords: 10,
  timeLimitMinutes: 45,
  maxSimilarity: 0.50,
};
// Measured with pg_trgm (extension schema-qualified):
//   original vs different      = 0.202  (< 0.50 -> accepted)
//   near_dup vs different      = 0.222  (< 0.50 -> accepted)
//   near_dup vs original       = 0.946  (> 0.50 -> rejected)
// Word counts: short = 4, original = 15, different = 16, near_dup = 16, all >= 10.
const TREE_ANSWER_ORIGINAL =
  'Tri thuc la ket qua cua qua trinh hoc tap va trai nghiem khong ngung';
const TREE_ANSWER_NEAR_DUPLICATE =
  'Tri thuc la ket qua cua qua trinh hoc tap va trai nghiem khong ngung nhe';
const TREE_ANSWER_DIFFERENT =
  'Moi nguoi deu co the hoc hoi tu sach vo ban be va nhung sai lam';
const TREE_SHORT_ANSWER = 'Tri thuc la gi';
// A distinct text for the resubmission edit. Reusing TREE_ANSWER_DIFFERENT would
// collide with member[1]'s accepted answer (0.202 is fine) but reusing the
// ORIGINAL would be a 100% self-comparison — the RPC excludes the caller's own
// row, yet the edited text must still clear the ceiling against the OTHER
// student's answer, which this variant does (measured 0.222).
const TREE_ANSWER_EDITED =
  'Kien thuc den tu sach vo, thay co va ca nhung trai nghiem thuc te';

/* ---------------------------------------------------------------- harness */

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail !== undefined ? `  -> ${detail}` : ''}`);
  }
}

function step(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `predicate()` is true or the timeout elapses. */
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/* ------------------------------------------------------------ admin setup */

async function ensureTeacher() {
  const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SB_SECRET,
      Authorization: `Bearer ${SB_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: TEACHER.email,
      password: TEACHER.password,
      email_confirm: true,
    }),
  });
  // 422 => already registered, which is fine (idempotent re-runs).
  if (res.ok || res.status === 422) return;
  throw new Error(`Cannot create teacher: ${res.status} ${await res.text()}`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log('='.repeat(74));
  console.log('Phase 5 — End-to-End Flow Verification');
  console.log(`Target: ${SB_URL}   Exam: ${EXAM.code}`);
  console.log('='.repeat(74));

  /* --- 1. Teacher session + exam authoring ------------------------------ */
  step(1, 'Teacher signs in and creates an exam with 3 questions');

  await ensureTeacher();

  const teacher = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await teacher.auth.signInWithPassword({
    email: TEACHER.email,
    password: TEACHER.password,
  });
  check('teacher signed in', !signIn.error && !!signIn.data.user, signIn.error?.message);
  const teacherId = signIn.data?.user?.id;

  // Clean up any previous run of this same exam code.
  await teacher.from('exams').delete().eq('code', EXAM.code);

  const examInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: EXAM.code,
      title: EXAM.title,
      duration_minutes: EXAM.duration,
    })
    .select('id, code, title')
    .single();
  check('exam row created', !examInsert.error && !!examInsert.data, examInsert.error?.message);
  const examId = examInsert.data?.id;

  const questions = [
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Thủ đô của Việt Nam là gì?',
      question_type: 'MULTIPLE_CHOICE',
      options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
      correct_answer: 0,
      explanation: 'Hà Nội là thủ đô.',
      position: 1,
    },
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Xét tính đúng sai của các mệnh đề:',
      question_type: 'TRUE_FALSE',
      options: ['a) 2 + 2 = 4', 'b) 3 > 5', 'c) Trái Đất hình cầu', 'd) 1 = 2'],
      // 3 of 4 correct -> 0.5 per the F3 scale.
      correct_answer: ['Đ', 'S', 'Đ', 'S'],
      explanation: null,
      position: 2,
    },
    {
      user_id: teacherId,
      exam_id: examId,
      question_text: 'Tính 1,5 + 1,5 = ?',
      question_type: 'SHORT_ANSWER',
      options: [],
      correct_answer: '3',
      explanation: null,
      position: 3,
    },
  ];

  const qInsert = await teacher.from('question_bank').insert(questions).select('id');
  check(
    '3 questions created',
    !qInsert.error && qInsert.data?.length === 3,
    qInsert.error?.message ?? `got ${qInsert.data?.length}`,
  );

  /* --- 2. Roster -------------------------------------------------------- */
  step(2, 'Seeds the candidate into the whitelist');

  const rosterInsert = await teacher.from('students').insert({
    student_code: STUDENT.code,
    full_name: STUDENT.fullName,
    class_name: STUDENT.className,
    exam_code: EXAM.code,
  });
  check('student whitelisted', !rosterInsert.error, rosterInsert.error?.message);

  // Phase 8.9 — the .docx self-practice gate reads `classes` + `class_members`,
  // not `students` (the whitelist above), so the same identity must also exist
  // on a class roster. Step 11 exercises the gate on exactly this pair.
  // `(user_id, name)` is unique, and the name is a constant — clear any row left
  // by an earlier aborted run so this insert is idempotent.
  await teacher.from('classes').delete().eq('name', STUDENT.className);
  const practiceClassInsert = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: STUDENT.className, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('practice class created', !practiceClassInsert.error, practiceClassInsert.error?.message);
  const practiceClassId = practiceClassInsert.data?.id;

  const practiceMemberInsert = await teacher.from('class_members').insert({
    class_id: practiceClassId,
    student_code: STUDENT.code,
    full_name: STUDENT.fullName,
    team_number: 1,
  });
  check('practice class member created', !practiceMemberInsert.error,
    practiceMemberInsert.error?.message);

  /* --- Realtime subscription (teacher side, before any student action) --- */
  step('3', 'Teacher subscribes to Realtime channels (D2)');

  const realtimeEvents = {
    activeSessions: [],
    examResults: [],
  };
  let channelStatus = 'PENDING';

  const channel = teacher
    .channel(`e2e:${EXAM.code}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'active_sessions', filter: `exam_code=eq.${EXAM.code}` },
      (payload) => realtimeEvents.activeSessions.push(payload),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'exam_results', filter: `exam_code=eq.${EXAM.code}` },
      (payload) => realtimeEvents.examResults.push(payload),
    )
    .subscribe((status) => {
      channelStatus = status;
    });

  const subscribed = await waitFor(() => channelStatus === 'SUBSCRIBED', 10_000);
  check('realtime channel SUBSCRIBED', subscribed, channelStatus);

  if (!subscribed) {
    console.log(
      '\n  Realtime is not reachable. Ensure `npx supabase start` is running and the\n' +
        '  tables are in the supabase_realtime publication (schema.sql SECTION D.2).',
    );
  }
  await sleep(500);

  /* --- 4/5/6. Student lifecycle (anon role, publishable key) ------------ */
  const student = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  step(4, 'Student signs in via verify_and_acquire_session');
  const acquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_full_name: STUDENT.fullName,
    p_class_name: STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('session acquired', acquire.data?.success === true, JSON.stringify(acquire.data ?? acquire.error));
  const token = acquire.data?.session_token;
  check('session token returned', typeof token === 'string' && token.length === 36, String(token));

  step(5, 'Student loads the payload — asserting zero answer leaks');
  const payloadRes = await student.rpc('get_student_exam_payload', {
    p_exam_code: EXAM.code,
    p_session_token: token,
  });
  const payload = payloadRes.data;
  check('payload returned', payload?.success === true, JSON.stringify(payloadRes.error ?? payload));
  check('3 questions delivered', payload?.questions?.length === 3, String(payload?.questions?.length));

  const rawPayload = JSON.stringify(payload ?? {});
  for (const leak of ['correct_answer', 'correctIndex', 'correctAnswers', 'explanation', 'isCorrect']) {
    check(`payload does not contain "${leak}"`, !rawPayload.includes(leak));
  }
  check('answer text not leaked', !rawPayload.includes('Hà Nội là thủ đô'));

  step(6, 'Student sends 2 heartbeats with blur/fullscreen increments');

  const hb1 = await student.rpc('record_student_heartbeat', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_current_q: 0,
    p_answered_count: 0,
    p_blur_count: 1,
    p_fs_exit_count: 0,
  });
  check('heartbeat 1 accepted', hb1.data?.success === true, JSON.stringify(hb1.data ?? hb1.error));

  const hb2 = await student.rpc('record_student_heartbeat', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_current_q: 1,
    p_answered_count: 1,
    p_blur_count: 3,
    p_fs_exit_count: 2,
  });
  check('heartbeat 2 accepted', hb2.data?.success === true, JSON.stringify(hb2.data ?? hb2.error));

  // Give Realtime a moment to deliver the two INSERT/UPDATE events.
  await waitFor(() => realtimeEvents.activeSessions.length >= 1, 5_000);

  const sessionRow = await teacher
    .from('active_sessions')
    .select('*')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('proctor row reflects telemetry', !sessionRow.error && sessionRow.data?.blur_count === 3,
    sessionRow.error?.message ?? JSON.stringify(sessionRow.data));
  check('fullscreen exits recorded', sessionRow.data?.fullscreen_exit_count === 2,
    String(sessionRow.data?.fullscreen_exit_count));
  check('current question tracked', sessionRow.data?.current_question === 1,
    String(sessionRow.data?.current_question));

  step(7, 'Student submits; server computes the authoritative score');

  const submit = await student.rpc('submit_exam_result', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_session_token: token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 0 },                          // MCQ correct  -> 1.00
      { questionIndex: 1, selectedAnswers: ['Đ', 'S', 'Đ', 'Đ'] },      // T/F 3/4     -> 0.50
      { questionIndex: 2, selectedAnswerText: ' 3 ' },                 // SHORT trim  -> 1.00
    ],
    p_metrics: { blurCount: 3, fullscreenExitCount: 2, elapsedSeconds: 900 },
  });
  check('submission accepted', submit.data?.success === true, JSON.stringify(submit.data ?? submit.error));
  check(
    `server score = ${EXPECTED_SCORE}`,
    Number(submit.data?.score) === EXPECTED_SCORE,
    String(submit.data?.score),
  );
  check('total_questions = 3', Number(submit.data?.total_questions) === 3, String(submit.data?.total_questions));

  const passingResultId = submit.data?.result_id;
  check('submission returns result_id (UUID)', UUID_RE.test(String(passingResultId)), String(passingResultId));

  step(8, 'Teacher side detects the submission (query + Realtime)');

  const resultRow = await teacher
    .from('exam_results')
    .select('*')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();

  check('teacher query sees the result', !resultRow.error && !!resultRow.data, resultRow.error?.message);
  check('persisted score matches', Number(resultRow.data?.score) === EXPECTED_SCORE,
    String(resultRow.data?.score));
  check('blur count persisted', resultRow.data?.blur_count === 3, String(resultRow.data?.blur_count));
  check('fullscreen exits persisted', resultRow.data?.fullscreen_exit_count === 2,
    String(resultRow.data?.fullscreen_exit_count));

  const gotResultEvent = await waitFor(
    () => realtimeEvents.examResults.some((e) => e.eventType === 'INSERT'),
    8_000,
  );
  check('realtime INSERT received on exam_results', gotResultEvent,
    `events=${JSON.stringify(realtimeEvents.examResults.map((e) => e.eventType))}`);
  check('realtime INSERT carries the score',
    realtimeEvents.examResults.some((e) => Number(e.new?.score) === EXPECTED_SCORE),
    JSON.stringify(realtimeEvents.examResults.map((e) => e.new?.score)));

  check(
    'active_sessions realtime events delivered',
    realtimeEvents.activeSessions.length > 0,
    `count=${realtimeEvents.activeSessions.length}`,
  );
  check('session row removed on submit (DELETE event)',
    realtimeEvents.activeSessions.some((e) => e.eventType === 'DELETE'),
    JSON.stringify(realtimeEvents.activeSessions.map((e) => e.eventType)));

  /* --- 9. Post-submit guards ------------------------------------------- */
  step(9, 'Post-submission guards');

  const reAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: STUDENT.code,
    p_full_name: STUDENT.fullName,
    p_class_name: STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('re-login blocked with ALREADY_SUBMITTED',
    reAcquire.data?.message === 'ALREADY_SUBMITTED', JSON.stringify(reAcquire.data));

  const anonTable = await fetch(`${SB_URL}/rest/v1/question_bank?select=correct_answer`, {
    headers: { apikey: SB_PUBLISHABLE },
  });
  check('student cannot read question_bank directly',
    anonTable.status === 401 || anonTable.status === 403 || anonTable.status === 404,
    `status=${anonTable.status}`);

  /* --- 10. Certificate verification (Phase 5.1) ------------------------ */
  step(10, 'Public certificate verification via get_certificate_verification');

  // The anon client is the same one a visitor scanning the QR code would use.
  const passingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: passingResultId,
  });
  check('RPC reachable by anon', !passingVerify.error,
    JSON.stringify(passingVerify.error));
  check('passing result verifies as valid', passingVerify.data?.valid === true,
    JSON.stringify(passingVerify.data));
  check('verification exposes student name',
    passingVerify.data?.student_name === STUDENT.fullName,
    String(passingVerify.data?.student_name));
  check('verification exposes class name',
    passingVerify.data?.class_name === STUDENT.className,
    String(passingVerify.data?.class_name));
  check('verification exposes exam title',
    passingVerify.data?.exam_title === EXAM.title,
    String(passingVerify.data?.exam_title));
  check('verification exposes the score',
    Number(passingVerify.data?.score) === EXPECTED_SCORE,
    String(passingVerify.data?.score));
  check('verification exposes a completion timestamp',
    typeof passingVerify.data?.submitted_at === 'string',
    String(passingVerify.data?.submitted_at));

  const rawVerify = JSON.stringify(passingVerify.data ?? {});
  for (const leak of ['correct_answer', 'correctAnswer', 'explanation', 'session_token']) {
    check(`verification does not leak "${leak}"`, !rawVerify.includes(leak));
  }

  // A UUID that does not exist must never verify.
  const missingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: '00000000-0000-0000-0000-000000000000',
  });
  check('unknown UUID verifies as invalid', missingVerify.data?.valid === false,
    JSON.stringify(missingVerify.data));

  // A real-but-failing result must not verify either.
  await teacher.from('students').insert({
    student_code: FAILING_STUDENT.code,
    full_name: FAILING_STUDENT.fullName,
    class_name: FAILING_STUDENT.className,
    exam_code: EXAM.code,
  });

  const failingAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EXAM.code,
    p_student_code: FAILING_STUDENT.code,
    p_full_name: FAILING_STUDENT.fullName,
    p_class_name: FAILING_STUDENT.className,
    p_device_info: 'e2e-script/1.0',
    p_existing_token: null,
  });
  check('failing candidate acquired a session',
    failingAcquire.data?.success === true, JSON.stringify(failingAcquire.data ?? failingAcquire.error));

  const failingSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: EXAM.code,
    p_student_code: FAILING_STUDENT.code,
    p_session_token: failingAcquire.data?.session_token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 1 },                          // MCQ wrong
      { questionIndex: 1, selectedAnswers: ['S', 'S', 'S', 'S'] },      // T/F 1/4 -> 0.10
      { questionIndex: 2, selectedAnswerText: 'sai' },                 // SHORT wrong
    ],
    p_metrics: {},
  });
  check('failing submission accepted', failingSubmit.data?.success === true,
    JSON.stringify(failingSubmit.data ?? failingSubmit.error));
  check('failing score is below 80%',
    Number(failingSubmit.data?.score) / Number(failingSubmit.data?.total_questions) < 0.8,
    `${failingSubmit.data?.score}/${failingSubmit.data?.total_questions}`);

  const failingVerify = await student.rpc('get_certificate_verification', {
    p_result_id: failingSubmit.data?.result_id,
  });
  check('failing result verifies as invalid', failingVerify.data?.valid === false,
    JSON.stringify(failingVerify.data));
  check('failing result reports NOT_PASSED',
    failingVerify.data?.message === 'NOT_PASSED', String(failingVerify.data?.message));

  /* --- 11. Authorized self-practice gate (Phase 5.2 / 8.1 / 8.9) -------- */
  // Phase 8.1 widened the signature to (p_class_name, p_full_name,
  // p_student_code DEFAULT NULL) so the personal-.docx path can authorise
  // without a student code.
  //
  // Phase 8.9 RE-POINTED the gate: it no longer consults `public.students` (the
  // exam whitelist) but the teacher's `classes` + `class_members` roster, and
  // additionally honours `classes.allow_practice`. The contract is now
  // success/code/message instead of authorized/student_name. Step 2 seeds the
  // matching class row for exactly this identity; Step 41 covers the code paths
  // (disabled class, unknown class, non-member).
  step(11, 'Self-practice authorization via verify_student_practice');

  const practiceOk = await student.rpc('verify_student_practice', {
    p_class_name: STUDENT.className,
    p_full_name: STUDENT.fullName,
  });
  check('practice RPC reachable by anon', !practiceOk.error, JSON.stringify(practiceOk.error));
  check('rostered member is authorized', practiceOk.data?.success === true,
    JSON.stringify(practiceOk.data));
  check('authorized response returns the canonical name',
    practiceOk.data?.full_name === STUDENT.fullName, String(practiceOk.data?.full_name));
  check('authorized response returns the class name',
    practiceOk.data?.class_name === STUDENT.className, String(practiceOk.data?.class_name));

  // The same identity, resolved by student_code instead of the name.
  const practiceByCode = await student.rpc('verify_student_practice', {
    p_class_name: STUDENT.className,
    p_full_name: 'Không Khớp Tên',
    p_student_code: STUDENT.code,
  });
  check('authorising by student_code still works', practiceByCode.data?.success === true,
    JSON.stringify(practiceByCode.data));

  // Case- and whitespace-insensitive, mirroring the SQL-side normalization.
  const practiceLoose = await student.rpc('verify_student_practice', {
    p_class_name: ` ${STUDENT.className.toLowerCase()}  `,
    p_full_name: `  ${STUDENT.fullName.toUpperCase()} `,
  });
  check('match is case/whitespace-insensitive', practiceLoose.data?.success === true,
    JSON.stringify(practiceLoose.data));

  // Unknown class -> CLASS_NOT_FOUND (Phase 8.9 changed this from a silent
  // "not on any roster" rejection into an explicit, actionable code).
  const practiceBad = await student.rpc('verify_student_practice', {
    p_class_name: '99ZZ',
    p_full_name: 'Không Có Thật',
  });
  check('unknown class is rejected', practiceBad.data?.success === false,
    JSON.stringify(practiceBad.data));
  check('unknown class reports CLASS_NOT_FOUND',
    practiceBad.data?.code === 'CLASS_NOT_FOUND', String(practiceBad.data?.code));
  check('rejection carries a Vietnamese message',
    typeof practiceBad.data?.message === 'string' && practiceBad.data.message.length > 0,
    String(practiceBad.data?.message));

  // Right class, but a name that is not on its roster.
  const practiceWrongName = await student.rpc('verify_student_practice', {
    p_class_name: STUDENT.className,
    p_full_name: 'Trần Không Thuộc Lớp',
  });
  check('non-member is rejected', practiceWrongName.data?.success === false,
    JSON.stringify(practiceWrongName.data));
  check('non-member reports STUDENT_NOT_FOUND',
    practiceWrongName.data?.code === 'STUDENT_NOT_FOUND', String(practiceWrongName.data?.code));

  // Empty input is rejected without touching the table.
  const practiceEmpty = await student.rpc('verify_student_practice', {
    p_class_name: '',
    p_full_name: '',
  });
  check('empty credentials are rejected', practiceEmpty.data?.success === false,
    JSON.stringify(practiceEmpty.data));

  /* --- 12. Scheduling window (Phase 5.4) -------------------------------- */
  step(12, 'Scheduling window enforced by verify_and_acquire_session');

  const acquireOn = async (suffix) => {
    // A fresh candidate per probe: `active_sessions` has a SELECT-only teacher
    // policy, so a leftover session cannot be deleted from here and would
    // otherwise surface SESSION_ACTIVE_ELSEWHERE instead of the window verdict.
    const code = `E2ESCH-${suffix}`.toUpperCase();
    await teacher.from('students').upsert(
      {
        student_code: code,
        full_name: SCHED_STUDENT.fullName,
        class_name: SCHED_STUDENT.className,
        exam_code: SCHED_EXAM.code,
      },
      { onConflict: 'student_code,exam_code' },
    );
    const res = await student.rpc('verify_and_acquire_session', {
      p_exam_code: SCHED_EXAM.code,
      p_student_code: code,
      p_full_name: SCHED_STUDENT.fullName,
      p_class_name: SCHED_STUDENT.className,
      p_device_info: `e2e-sched/${suffix}`,
      p_existing_token: null,
    });
    return res.data;
  };

  // Re-create the scheduling exam fresh (idempotent re-runs).
  await teacher.from('exams').delete().eq('code', SCHED_EXAM.code);
  const schedInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: SCHED_EXAM.code,
      title: SCHED_EXAM.title,
      duration_minutes: SCHED_EXAM.duration,
      is_active: true,
      starts_at: null,
      ends_at: null,
    })
    .select('id')
    .single();
  check('scheduling exam created', !schedInsert.error, schedInsert.error?.message);

  // Sanity: with no window and is_active, login is allowed.
  const schedBaseline = await acquireOn('baseline');
  check('open exam with no window accepts login',
    schedBaseline?.success === true, JSON.stringify(schedBaseline));

  // Not started: starts_at in the future.
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await teacher.from('exams').update({ starts_at: future }).eq('code', SCHED_EXAM.code);
  const beforeStart = await acquireOn('before');
  check('login before starts_at is rejected',
    beforeStart?.success === false && beforeStart?.message === 'EXAM_NOT_STARTED',
    JSON.stringify(beforeStart));

  // Expired: ends_at in the past.
  await teacher
    .from('exams')
    .update({ starts_at: null, ends_at: new Date(Date.now() - 3_600_000).toISOString() })
    .eq('code', SCHED_EXAM.code);
  const afterEnd = await acquireOn('after');
  check('login after ends_at is rejected',
    afterEnd?.success === false && afterEnd?.message === 'EXAM_EXPIRED',
    JSON.stringify(afterEnd));

  // Inside the window: past start, future end.
  await teacher
    .from('exams')
    .update({
      starts_at: new Date(Date.now() - 3_600_000).toISOString(),
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
    .eq('code', SCHED_EXAM.code);
  const inWindow = await acquireOn('inside');
  check('login inside the window is accepted',
    inWindow?.success === true, JSON.stringify(inWindow));

  // Teacher closed the exam regardless of the window.
  await teacher.from('exams').update({ is_active: false }).eq('code', SCHED_EXAM.code);
  const inactive = await acquireOn('inactive');
  check('login with is_active = false is rejected as EXAM_INACTIVE',
    inactive?.success === false && inactive?.message === 'EXAM_INACTIVE',
    JSON.stringify(inactive));

  /* --- 13. Safe question CRUD (Phase 5.4) ------------------------------- */
  step(13, 'update_exam_questions_safe before and after a submission');

  await teacher.from('exams').delete().eq('code', EDIT_EXAM.code);
  const editInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: EDIT_EXAM.code,
      title: EDIT_EXAM.title,
      duration_minutes: EDIT_EXAM.duration,
    })
    .select('id')
    .single();
  check('edit exam created', !editInsert.error, editInsert.error?.message);
  const editExamId = editInsert.data?.id;

  const seedBank = async (count) => {
    await teacher.from('question_bank').delete().eq('exam_id', editExamId);
    const rows = Array.from({ length: count }, (_, i) => ({
      user_id: teacherId,
      exam_id: editExamId,
      question_text: `Câu gốc ${i + 1}`,
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      explanation: null,
      position: i + 1,
    }));
    return teacher.from('question_bank').insert(rows);
  };

  await seedBank(5);

  // (a) No submissions: a full rewrite is allowed — drop to 3 questions.
  const beforeSubmit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: Array.from({ length: 3 }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sửa ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 1,
      explanation: null,
    })),
  });
  check('pre-submission rewrite of 5 -> 3 is allowed',
    beforeSubmit.data?.success === true, JSON.stringify(beforeSubmit.data ?? beforeSubmit.error));
  check('pre-submission rewrite reports REPLACED',
    beforeSubmit.data?.message === 'REPLACED', String(beforeSubmit.data?.message));

  const afterRewrite = await teacher
    .from('question_bank')
    .select('position, question_text, correct_answer')
    .eq('exam_id', editExamId)
    .order('position', { ascending: true });
  check('rewrite leaves exactly 3 rows', afterRewrite.data?.length === 3,
    String(afterRewrite.data?.length));
  check('rewrite renumbers positions 1..3',
    JSON.stringify(afterRewrite.data?.map((r) => r.position)) === '[1,2,3]',
    JSON.stringify(afterRewrite.data?.map((r) => r.position)));
  check('rewrite applied the new content',
    afterRewrite.data?.[0]?.question_text === 'Câu sửa 1',
    String(afterRewrite.data?.[0]?.question_text));

  // A JSON null key must land as SQL NULL, not the JSONB literal 'null'
  // (which `#>> '{}'` would render as the string "null" and corrupt scoring).
  const nullKeyRewrite = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: Array.from({ length: 3 }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sửa ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: null,
      explanation: null,
    })),
  });
  check('rewrite with a null key is accepted',
    nullKeyRewrite.data?.success === true, JSON.stringify(nullKeyRewrite.data));
  const nullKeyRow = await teacher
    .from('question_bank')
    .select('correct_answer')
    .eq('exam_id', editExamId)
    .limit(1)
    .maybeSingle();
  check('JSON null key is stored as SQL NULL (not JSONB "null")',
    nullKeyRow.data?.correct_answer === null, JSON.stringify(nullKeyRow.data?.correct_answer));

  // Restore a real key for the post-submission phase.
  await seedBank(3);

  // (b) Now create a submission so the structure freezes.
  await teacher.from('students').insert({
    student_code: SCHED_STUDENT.code,
    full_name: SCHED_STUDENT.fullName,
    class_name: SCHED_STUDENT.className,
    exam_code: EDIT_EXAM.code,
  });
  const editAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: EDIT_EXAM.code,
    p_student_code: SCHED_STUDENT.code,
    p_full_name: SCHED_STUDENT.fullName,
    p_class_name: SCHED_STUDENT.className,
    p_device_info: 'e2e-edit/1.0',
    p_existing_token: null,
  });
  check('edit-exam candidate acquired a session',
    editAcquire.data?.success === true, JSON.stringify(editAcquire.data ?? editAcquire.error));
  const editSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: EDIT_EXAM.code,
    p_student_code: SCHED_STUDENT.code,
    p_session_token: editAcquire.data?.session_token,
    p_answers: [
      { questionIndex: 0, selectedIndex: 1 },
      { questionIndex: 1, selectedIndex: 1 },
      { questionIndex: 2, selectedIndex: 1 },
    ],
    p_metrics: {},
  });
  check('edit-exam submission accepted', editSubmit.data?.success === true,
    JSON.stringify(editSubmit.data ?? editSubmit.error));

  const questionPayload = (count) =>
    Array.from({ length: count }, (_, i) => ({
      position: i + 1,
      question_type: 'MULTIPLE_CHOICE',
      question_text: `Câu sau nộp ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 2,
      explanation: 'giải thích mới',
    }));

  // (c) Deletion (a count change) must be rejected.
  const deleteBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(2),
  });
  check('deletion after submission is blocked',
    deleteBlocked.data?.success === false
      && deleteBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(deleteBlocked.data));
  check('block carries a Vietnamese detail message',
    typeof deleteBlocked.data?.detail === 'string' && deleteBlocked.data.detail.length > 0,
    String(deleteBlocked.data?.detail));

  // (d) Addition (count change) must also be rejected.
  const addBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(4),
  });
  check('addition after submission is blocked',
    addBlocked.data?.success === false
      && addBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(addBlocked.data));

  // (e) In-place content edit of the same count/type is allowed.
  const contentEdit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(3),
  });
  check('in-place content edit after submission is allowed',
    contentEdit.data?.success === true, JSON.stringify(contentEdit.data ?? contentEdit.error));
  check('content edit reports CONTENT_UPDATED',
    contentEdit.data?.message === 'CONTENT_UPDATED', String(contentEdit.data?.message));

  const afterEdit = await teacher
    .from('question_bank')
    .select('position, question_text, correct_answer')
    .eq('exam_id', editExamId)
    .order('position', { ascending: true });
  check('content edit applied without changing the count',
    afterEdit.data?.length === 3, String(afterEdit.data?.length));
  check('content edit updated the text',
    afterEdit.data?.[0]?.question_text === 'Câu sau nộp 1',
    String(afterEdit.data?.[0]?.question_text));

  // (f) A type change at the same count is structural.
  const typeChanged = questionPayload(3);
  typeChanged[1].question_type = 'SHORT_ANSWER';
  const typeBlocked = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: typeChanged,
  });
  check('type change after submission is blocked',
    typeBlocked.data?.success === false
      && typeBlocked.data?.message === 'STRUCTURAL_CHANGE_BLOCKED',
    JSON.stringify(typeBlocked.data));

  // (g) Ownership: an anonymous caller must never be able to edit.
  const anonEdit = await student.rpc('update_exam_questions_safe', {
    p_exam_code: EDIT_EXAM.code,
    p_questions: questionPayload(3),
  });
  check('anon cannot call update_exam_questions_safe',
    !!anonEdit.error || anonEdit.data?.success === false,
    JSON.stringify(anonEdit.error ?? anonEdit.data));

  /* --- 14. Multi-variant sub-sampling (Phase 5.4) ----------------------- */
  step(14, 'generateExamVariants subsamples K of N with contiguous positions');

  const pool = Array.from({ length: 5 }, (_, i) => ({
    position: i + 1,
    question_type: 'MULTIPLE_CHOICE',
    question_text: `Pool ${i + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correct_answer: 0,
    explanation: null,
  }));

  const variants = generateExamVariants(pool, {
    variantCount: 4,
    questionCountPerExam: 3,
    shuffleDistractors: true,
  });

  check('generates the requested number of variants', variants.length === 4, String(variants.length));
  check('every variant draws exactly K questions',
    variants.every((v) => v.questions.length === 3),
    JSON.stringify(variants.map((v) => v.questions.length)));
  check('positions are strictly contiguous 1..K',
    variants.every((v) => JSON.stringify(v.questions.map((q) => q.position)) === '[1,2,3]'),
    JSON.stringify(variants.map((v) => v.questions.map((q) => q.position))));
  check('questions within a variant are unique',
    variants.every((v) => new Set(v.questions.map((q) => q.question_text)).size === 3),
    JSON.stringify(variants.map((v) => v.questions.map((q) => q.question_text))));
  check('every variant has a 6-char code',
    variants.every((v) => typeof v.code === 'string' && v.code.length === 6),
    JSON.stringify(variants.map((v) => v.code)));
  check('variant codes are unique',
    new Set(variants.map((v) => v.code)).size === variants.length,
    JSON.stringify(variants.map((v) => v.code)));

  // Distractor shuffle must keep correct_answer pointing at the marked content.
  // Every pool question marks 'A' (index 0), so after a shuffle the key must
  // still resolve to the option whose text is 'A'.
  check('distractor shuffle keeps the answer key in sync',
    variants.every((v) => v.questions.every((q) => q.options[q.correct_answer] === 'A')),
    JSON.stringify(variants[0]?.questions.map((q) => ({ opts: q.options, key: q.correct_answer }))));

  // The same pool can be sampled without replacement, so K <= N is enforced.
  const capped = generateExamVariants(pool, { variantCount: 1, questionCountPerExam: 99 });
  check('K is capped at the pool size N', capped[0]?.questions.length === 5,
    String(capped[0]?.questions.length));

  /* --- 15. Timezone helpers (Phase 5.5) --------------------------------- */
  step(15, 'Timezone helpers round-trip the exact same instant');

  const sampleIso = '2026-10-02T01:30:00.000Z';
  const localValue = toLocalDatetimeString(sampleIso);
  check('UTC ISO converts to a datetime-local string',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue), localValue);

  // The local wall clock must reflect the platform's real UTC offset for that
  // instant — parsed back on its own it is a LOCAL date, so re-deriving the UTC
  // instant from it must land on the original timestamp.
  const [datePart, timePart] = localValue.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const localReconstructed = new Date(y, mo - 1, d, h, mi, 0, 0);
  check('local string reflects the platform UTC offset',
    localReconstructed.getTime() === new Date(sampleIso).getTime(),
    `${localReconstructed.toISOString()} vs ${sampleIso}`);

  // Round-trip: local -> UTC must reproduce the same instant (minute precision).
  const roundTripped = toUtcIsoString(localValue);
  check('local string converts back to the same UTC instant',
    roundTripped === sampleIso, `${roundTripped} vs ${sampleIso}`);
  check('round-trip preserves the exact epoch millisecond',
    new Date(roundTripped).getTime() === new Date(sampleIso).getTime(),
    String(new Date(roundTripped).getTime()));

  // An offset with a non-zero minute component (e.g. UTC+05:45) must survive the
  // round-trip rather than being truncated to a whole hour. This assertion holds
  // in ANY host timezone, since both directions use the same local calendar.
  const minuteOffsetIso = '2026-01-15T06:15:00.000Z';
  check('minute-level offsets survive the round-trip',
    toUtcIsoString(toLocalDatetimeString(minuteOffsetIso)) === minuteOffsetIso,
    String(toUtcIsoString(toLocalDatetimeString(minuteOffsetIso))));

  // Null / invalid inputs must degrade to "no bound" rather than throw.
  check('null ISO yields an empty input value', toLocalDatetimeString(null) === '');
  check('null local yields a null bound', toUtcIsoString(null) === null);
  check('empty local yields a null bound', toUtcIsoString('   ') === null);
  check('invalid local yields a null bound', toUtcIsoString('not-a-date') === null);

  // daysUntil drives the Trash "time remaining" label.
  const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString();
  check('daysUntil reports 7 days for a fresh 7-day window', daysUntil(inSevenDays) === 7,
    String(daysUntil(inSevenDays)));
  check('daysUntil reports 0 once the deadline has passed',
    daysUntil(new Date(Date.now() - 1000).toISOString()) === 0,
    String(daysUntil(new Date(Date.now() - 1000).toISOString())));

  /* --- 16. Hard delete (Phase 5.5) -------------------------------------- */
  step(16, 'delete_exam hard-deletes an exam with zero submissions');

  await teacher.from('exams').delete().eq('code', HARD_DEL_EXAM.code);
  const hardInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: HARD_DEL_EXAM.code,
      title: HARD_DEL_EXAM.title,
      duration_minutes: HARD_DEL_EXAM.duration,
    })
    .select('id')
    .single();
  check('hard-delete exam created', !hardInsert.error, hardInsert.error?.message);
  const hardExamId = hardInsert.data?.id;

  const hardRoster = await teacher.from('students').insert({
    student_code: SOFT_DEL_STUDENT.code,
    full_name: SOFT_DEL_STUDENT.fullName,
    class_name: SOFT_DEL_STUDENT.className,
    exam_code: HARD_DEL_EXAM.code,
  });
  check('hard-delete roster seeded', !hardRoster.error, hardRoster.error?.message);

  const hardQuestions = await teacher.from('question_bank').insert([
    {
      user_id: teacherId,
      exam_id: hardExamId,
      question_text: 'Câu sẽ bị xóa',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      position: 1,
    },
  ]);
  check('hard-delete questions seeded', !hardQuestions.error, hardQuestions.error?.message);

  const hardDelete = await teacher.rpc('delete_exam', { p_exam_code: HARD_DEL_EXAM.code });
  check('hard delete reported success', hardDelete.data?.success === true,
    JSON.stringify(hardDelete.data ?? hardDelete.error));
  check('hard delete reports action = hard_deleted',
    hardDelete.data?.action === 'hard_deleted', String(hardDelete.data?.action));

  const hardGoneExam = await teacher
    .from('exams')
    .select('id')
    .eq('code', HARD_DEL_EXAM.code);
  check('exam row is gone after hard delete', hardGoneExam.data?.length === 0,
    String(hardGoneExam.data?.length));

  const hardGoneQuestions = await teacher
    .from('question_bank')
    .select('id')
    .eq('exam_id', hardExamId);
  check('question_bank rows are gone after hard delete', hardGoneQuestions.data?.length === 0,
    String(hardGoneQuestions.data?.length));

  const hardGoneRoster = await teacher
    .from('students')
    .select('id')
    .eq('exam_code', HARD_DEL_EXAM.code);
  check('roster rows are gone after hard delete', hardGoneRoster.data?.length === 0,
    String(hardGoneRoster.data?.length));

  // Deleting an already-deleted (or unknown) exam must not raise.
  const hardDeleteAgain = await teacher.rpc('delete_exam', { p_exam_code: HARD_DEL_EXAM.code });
  check('re-deleting a vanished exam is rejected cleanly',
    hardDeleteAgain.data?.success === false && hardDeleteAgain.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(hardDeleteAgain.data));

  /* --- 17. Soft delete & Trash (Phase 5.5) ------------------------------ */
  step(17, 'delete_exam soft-deletes an exam that has submissions');

  await teacher.from('exams').delete().eq('code', SOFT_DEL_EXAM.code);
  const softInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: SOFT_DEL_EXAM.code,
      title: SOFT_DEL_EXAM.title,
      duration_minutes: SOFT_DEL_EXAM.duration,
    })
    .select('id')
    .single();
  check('soft-delete exam created', !softInsert.error, softInsert.error?.message);
  const softExamId = softInsert.data?.id;

  await teacher.from('students').insert({
    student_code: SOFT_DEL_STUDENT.code,
    full_name: SOFT_DEL_STUDENT.fullName,
    class_name: SOFT_DEL_STUDENT.className,
    exam_code: SOFT_DEL_EXAM.code,
  });

  const softBank = await teacher.from('question_bank').insert([
    {
      user_id: teacherId,
      exam_id: softExamId,
      question_text: 'Câu hỏi gốc',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 0,
      position: 1,
    },
    {
      user_id: teacherId,
      exam_id: softExamId,
      question_text: 'Câu hỏi phụ',
      question_type: 'MULTIPLE_CHOICE',
      options: ['A', 'B', 'C', 'D'],
      correct_answer: 1,
      position: 2,
    },
  ]);
  check('soft-delete questions seeded', !softBank.error, softBank.error?.message);

  // Produce one real submission so the exam becomes soft-delete eligible.
  const softAcquire = await student.rpc('verify_and_acquire_session', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_full_name: SOFT_DEL_STUDENT.fullName,
    p_class_name: SOFT_DEL_STUDENT.className,
    p_device_info: 'e2e-softdel/1.0',
    p_existing_token: null,
  });
  check('soft-delete candidate acquired a session',
    softAcquire.data?.success === true, JSON.stringify(softAcquire.data ?? softAcquire.error));

  const softSubmit = await student.rpc('submit_exam_result', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_session_token: softAcquire.data?.session_token,
    // Answer Q1 correctly (A=0), Q2 wrongly (marked 1, submitted 0) => 1.0 / 2.
    p_answers: [
      { questionIndex: 0, selectedIndex: 0 },
      { questionIndex: 1, selectedIndex: 0 },
    ],
    p_metrics: {},
  });
  check('soft-delete submission accepted', softSubmit.data?.success === true,
    JSON.stringify(softSubmit.data ?? softSubmit.error));
  check('initial score is 1 of 2', Number(softSubmit.data?.score) === 1,
    String(softSubmit.data?.score));

  const softDelete = await teacher.rpc('delete_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('soft delete reported success', softDelete.data?.success === true,
    JSON.stringify(softDelete.data ?? softDelete.error));
  check('soft delete reports action = soft_deleted',
    softDelete.data?.action === 'soft_deleted', String(softDelete.data?.action));
  check('soft delete returns a purge_at 7 days out',
    !!softDelete.data?.purge_at
      && Math.abs(
        new Date(softDelete.data.purge_at).getTime() - (Date.now() + 7 * 86_400_000),
      ) < 60_000,
    String(softDelete.data?.purge_at));

  const softRow = await teacher
    .from('exams')
    .select('deleted_at, is_active')
    .eq('code', SOFT_DEL_EXAM.code)
    .maybeSingle();
  check('deleted_at is stamped', !!softRow.data?.deleted_at, JSON.stringify(softRow.data));
  check('soft-deleted exam is forced inactive', softRow.data?.is_active === false,
    String(softRow.data?.is_active));

  // A trashed exam must be unreachable to students.
  const softLoginAfterDelete = await student.rpc('verify_and_acquire_session', {
    p_exam_code: SOFT_DEL_EXAM.code,
    p_student_code: SOFT_DEL_STUDENT.code,
    p_full_name: SOFT_DEL_STUDENT.fullName,
    p_class_name: SOFT_DEL_STUDENT.className,
    p_device_info: 'e2e-softdel/2.0',
    p_existing_token: null,
  });
  check('student login into a trashed exam is rejected as EXAM_NOT_FOUND',
    softLoginAfterDelete.data?.success === false
      && softLoginAfterDelete.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(softLoginAfterDelete.data));

  // ...and it must not appear as a live exam.
  const liveAfterDelete = await teacher
    .from('exams')
    .select('code')
    .is('deleted_at', null)
    .eq('code', SOFT_DEL_EXAM.code);
  check('trashed exam is excluded from the live list', liveAfterDelete.data?.length === 0,
    String(liveAfterDelete.data?.length));

  const trashAfterDelete = await teacher
    .from('exams')
    .select('code')
    .not('deleted_at', 'is', null)
    .eq('code', SOFT_DEL_EXAM.code);
  check('trashed exam appears in the Trash list', trashAfterDelete.data?.length === 1,
    String(trashAfterDelete.data?.length));

  // Restore clears the marker but leaves the exam closed.
  const restored = await teacher.rpc('restore_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('restore reported success', restored.data?.success === true,
    JSON.stringify(restored.data ?? restored.error));

  const restoredRow = await teacher
    .from('exams')
    .select('deleted_at, is_active')
    .eq('code', SOFT_DEL_EXAM.code)
    .maybeSingle();
  check('restore clears deleted_at', restoredRow.data?.deleted_at === null,
    JSON.stringify(restoredRow.data));
  check('restore deliberately leaves the exam closed', restoredRow.data?.is_active === false,
    String(restoredRow.data?.is_active));

  // purge_expired_exams must NOT touch a freshly-restored (live) exam.
  const purgeSweep = await teacher.rpc('purge_expired_exams');
  check('purge sweep runs', purgeSweep.data?.success === true,
    JSON.stringify(purgeSweep.data ?? purgeSweep.error));
  const survivesPurge = await teacher
    .from('exams')
    .select('code')
    .eq('code', SOFT_DEL_EXAM.code);
  check('a live exam survives the purge sweep', survivesPurge.data?.length === 1,
    String(survivesPurge.data?.length));

  // Ownership: an anonymous caller must never delete or restore.
  const anonDelete = await student.rpc('delete_exam', { p_exam_code: SOFT_DEL_EXAM.code });
  check('anon cannot call delete_exam',
    !!anonDelete.error || anonDelete.data?.success === false,
    JSON.stringify(anonDelete.error ?? anonDelete.data));

  /* --- 18. Re-grading (Phase 5.5) --------------------------------------- */
  step(18, 'recalculate_exam_scores re-grades against the latest keys');

  // The verification exam (EXAM.code) has STUDENT's submission at EXPECTED_SCORE.
  // Flip Q3's SHORT_ANSWER key from "3" to "5" so the candidate's stored "3"
  // becomes wrong: 2.5 - 1.0 = 1.5.
  const keyEdit = await teacher.rpc('update_exam_questions_safe', {
    p_exam_code: EXAM.code,
    p_questions: [
      {
        position: 1,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Thủ đô của Việt Nam là gì?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
        correct_answer: 0,
        explanation: 'Hà Nội là thủ đô.',
      },
      {
        position: 2,
        question_type: 'TRUE_FALSE',
        question_text: 'Xét tính đúng sai của các mệnh đề:',
        options: ['a) 2 + 2 = 4', 'b) 3 > 5', 'c) Trái Đất hình cầu', 'd) 1 = 2'],
        correct_answer: ['Đ', 'S', 'Đ', 'S'],
        explanation: null,
      },
      {
        position: 3,
        question_type: 'SHORT_ANSWER',
        question_text: 'Tính 1,5 + 1,5 = ?',
        options: [],
        correct_answer: '5',
        explanation: null,
      },
    ],
  });
  check('answer key edit accepted after submission',
    keyEdit.data?.success === true, JSON.stringify(keyEdit.data ?? keyEdit.error));

  const beforeRegrade = await teacher
    .from('exam_results')
    .select('score')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('stored score is still the stale value before re-grading',
    Number(beforeRegrade.data?.score) === EXPECTED_SCORE, String(beforeRegrade.data?.score));

  const regrade = await teacher.rpc('recalculate_exam_scores', { p_exam_code: EXAM.code });
  check('re-grade reported success', regrade.data?.success === true,
    JSON.stringify(regrade.data ?? regrade.error));
  // Two candidates submitted to EXAM.code (the passing student and the failing one).
  check('re-grade updated every submission (2)',
    regrade.data?.updated_count === 2, String(regrade.data?.updated_count));
  check('re-grade returns the Vietnamese confirmation',
    regrade.data?.message === 'Đã chấm lại toàn bộ bài thi theo đáp án mới nhất.',
    String(regrade.data?.message));

  const afterRegrade = await teacher
    .from('exam_results')
    .select('score, answers_json')
    .eq('exam_code', EXAM.code)
    .eq('student_code', STUDENT.code)
    .maybeSingle();
  check('re-graded score drops by the rekeyed question (2.5 -> 1.5)',
    Number(afterRegrade.data?.score) === 1.5, String(afterRegrade.data?.score));

  const correctedQ3 = (afterRegrade.data?.answers_json ?? []).find((a) => a.questionIndex === 2);
  check('re-graded answers_json marks Q3 incorrect',
    correctedQ3?.isCorrect === false, JSON.stringify(correctedQ3));
  check('re-graded answers_json carries the NEW correct answer',
    correctedQ3?.correctAnswer === '5', JSON.stringify(correctedQ3));

  // Ownership: re-grading someone else's exam must be refused.
  const anonRegrade = await student.rpc('recalculate_exam_scores', { p_exam_code: EXAM.code });
  check('anon cannot call recalculate_exam_scores',
    !!anonRegrade.error || anonRegrade.data?.success === false,
    JSON.stringify(anonRegrade.error ?? anonRegrade.data));

  /* --- 19. Rule-engine DOCX parsing (Phase 5.6) ------------------------- */
  step(19, 'Rule engine parses the Ministry-format test4.docx in < 15ms');

  const test4Bytes = new Uint8Array(
    readFileSync(new URL('../../sample/test4.docx', import.meta.url)),
  );
  const test4Pre = preprocessDocx(test4Bytes);
  const parseStarted = performance.now();
  const test4 = extractWithRules(test4Pre.text);
  const parseElapsed = performance.now() - parseStarted;

  check('test4 extracts exactly 24 questions', test4.question_count === 24,
    String(test4.question_count));

  const test4Mcq = test4.data.filter((q) => q.question_type === 'MULTIPLE_CHOICE');
  const test4Tf = test4.data.filter((q) => q.question_type === 'TRUE_FALSE');
  check('test4 yields 22 MCQ (Part I)', test4Mcq.length === 22, String(test4Mcq.length));
  check('test4 yields 2 TRUE_FALSE (Part II)', test4Tf.length === 2, String(test4Tf.length));

  // Part II questions are the last two positions (23, 24) — Part I is 1..22.
  check('Part II questions occupy positions 23 and 24',
    test4Tf.length === 2
      && test4Tf[0]?.position === 23
      && test4Tf[1]?.position === 24,
    JSON.stringify(test4Tf.map((q) => q.position)));

  check('Part II Câu 1 carries 4 statement options',
    test4Tf[0]?.options.length === 4, String(test4Tf[0]?.options.length));
  check('Part II Câu 2 carries 4 statement options',
    test4Tf[1]?.options.length === 4, String(test4Tf[1]?.options.length));

  // Keys come from the trailing "ĐÁP ÁN: A. Đúng B. Sai C. Đúng D. Đúng" block.
  check('Part II Câu 1 key is ["Đ","S","Đ","Đ"]',
    JSON.stringify(test4Tf[0]?.correct_answer) === JSON.stringify(['Đ', 'S', 'Đ', 'Đ']),
    JSON.stringify(test4Tf[0]?.correct_answer));
  check('Part II Câu 2 key is ["Đ","S","S","Đ"]',
    JSON.stringify(test4Tf[1]?.correct_answer) === JSON.stringify(['Đ', 'S', 'S', 'Đ']),
    JSON.stringify(test4Tf[1]?.correct_answer));

  // The key block must never reach the student-visible strings.
  const leaked = test4.data.some(
    (q) =>
      q.question_text.includes('ĐÁP ÁN') ||
      q.options.some((option) => option.includes('ĐÁP ÁN')),
  );
  check('no question text or option contains "ĐÁP ÁN"', leaked === false, String(leaked));
  check('Part II stems do not retain the answer-block marker',
    test4Tf.every((q) => !/đáp\s*án/i.test(q.question_text)),
    JSON.stringify(test4Tf.map((q) => q.question_text.slice(-40))));

  check('rule-engine parsing stays under the 15ms bar',
    parseElapsed < 15, `${parseElapsed.toFixed(2)}ms`);
  console.log(`  · parse time: ${parseElapsed.toFixed(2)} ms`);

  // The clean document must NOT trip the linter — otherwise every auto upload
  // would burn an AI call.
  check('clean test4 triggers no anomaly',
    detectParsingAnomalies(test4Pre.text, { questions: test4.data }).shouldFallback === false,
    JSON.stringify(detectParsingAnomalies(test4Pre.text, { questions: test4.data })));

  /* --- 20. Smart AI fallback (Phase 5.6) -------------------------------- */
  step(20, 'Anomaly linter hands a mismatched document to Engine 2 in auto mode');

  // Build a DOCX with the Ministry shells but a Part II whose four statements
  // all sit on ONE line. No line-anchored a-d/A-D delimiter exists there, so the
  // rule engine silently swallows Part II as MCQ: precisely the corruption the
  // old `question_count === 0 || !has_answers` check never noticed.
  const buildDocx = (paragraphs) => {
    const escape = (value) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = paragraphs
      .map((entry) => {
        const [text, bold] = Array.isArray(entry) ? entry : [entry, false];
        const rpr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
        return `<w:p><w:r>${rpr}<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
      })
      .join('');
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body}</w:body></w:document>`;
    return new Uint8Array(zipSync({ 'word/document.xml': strToU8(xml) }));
  };

  const mismatched = buildDocx([
    'PHẦN I. Câu hỏi trắc nghiệm nhiều phương án lựa chọn.',
    'Câu 1. Thủ đô của Việt Nam là gì?',
    ['A. Hà Nội', true],
    'B. Huế',
    'C. Đà Nẵng',
    'D. TP.HCM',
    'Câu 2. Quốc gia nào có diện tích lớn nhất?',
    'A. Việt Nam',
    ['B. Nga', true],
    'C. Pháp',
    'D. Nhật Bản',
    'Câu 3. 2 + 2 bằng mấy?',
    'A. 3',
    'B. 5',
    ['C. 4', true],
    'D. 6',
    'PHẦN II. Câu trắc nghiệm đúng sai.',
    'Câu 4. Xét các mệnh đề: A. 2 + 2 = 4 B. 3 > 5 C. Trái Đất hình cầu D. 1 = 2',
  ]);

  const mismatchedPre = preprocessDocx(mismatched);
  const mismatchedRule = extractWithRules(mismatchedPre.text);
  check('the mismatched document parses as 0 TRUE_FALSE under the rule engine',
    mismatchedRule.data.every((q) => q.question_type !== 'TRUE_FALSE'),
    JSON.stringify(mismatchedRule.data.map((q) => q.question_type)));

  const verdict = detectParsingAnomalies(mismatchedPre.text, { questions: mismatchedRule.data });
  check('the linter flags MISSED_TRUE_FALSE_SECTION',
    verdict.shouldFallback === true && verdict.reason === 'MISSED_TRUE_FALSE_SECTION',
    JSON.stringify(verdict));

  // Drive the real Worker route in-process, stubbing the Gemini HTTP call so the
  // test stays offline. Engine 2 is made to return a correct 4-question set.
  const aiPayload = {
    questions: [
      {
        position: 1,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Thủ đô của Việt Nam là gì?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'],
        correct_answer: '"0"',
        explanation: '',
      },
      {
        position: 2,
        question_type: 'MULTIPLE_CHOICE',
        question_text: 'Quốc gia nào có diện tích lớn nhất?',
        options: ['Việt Nam', 'Nga', 'Pháp', 'Nhật Bản'],
        correct_answer: '"1"',
        explanation: '',
      },
      {
        position: 3,
        question_type: 'MULTIPLE_CHOICE',
        question_text: '2 + 2 bằng mấy?',
        options: ['3', '5', '4', '6'],
        correct_answer: '"2"',
        explanation: '',
      },
      {
        position: 4,
        question_type: 'TRUE_FALSE',
        question_text: 'Xét các mệnh đề:',
        options: ['2 + 2 = 4', '3 > 5', 'Trái Đất hình cầu', '1 = 2'],
        correct_answer: '["Đ","S","Đ","S"]',
        explanation: '',
      },
    ],
  };

  const realFetch = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(aiPayload) }], role: 'model' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  };

  /**
   * POSTs a DOCX to a Worker route with the given mode.
   *
   * Phase 5.7: the Worker's default export is now the module-worker handler
   * object ({ fetch, scheduled }) rather than the bare Hono app, so the request
   * goes through `handler.fetch(Request, env)` — the same entrypoint Cloudflare
   * invokes in production.
   */
  const callExtract = async (bytes, filename, mode) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    const response = await workerApp.fetch(
      new Request(`http://localhost/api/v1/extract?mode=${mode}`, { method: 'POST', body: form }),
      { GEMINI_API_KEY: 'e2e-stub-key' },
    );
    return response.json();
  };

  try {
    const autoCorrupt = await callExtract(mismatched, 'mismatched.docx', 'auto');
    check('auto mode reports engine_used = ai_fallback',
      autoCorrupt.engine_used === 'ai_fallback', String(autoCorrupt.engine_used));
    check('auto mode reports the anomaly as fallback_reason',
      autoCorrupt.meta?.fallback_reason === 'MISSED_TRUE_FALSE_SECTION',
      String(autoCorrupt.meta?.fallback_reason));
    check('auto mode returns the AI payload, not the corrupt rule payload',
      autoCorrupt.count === 4
        && autoCorrupt.data.some((q) => q.question_type === 'TRUE_FALSE'),
      JSON.stringify(autoCorrupt.data.map((q) => q.question_type)));
    check('exactly one Engine 2 call was made', geminiCalls === 1, String(geminiCalls));

    // mode=rule must NOT call the AI, and must flag the miss instead.
    const ruleCorrupt = await callExtract(mismatched, 'mismatched.docx', 'rule');
    check('rule mode never triggers the AI fallback',
      ruleCorrupt.engine_used === 'rule' && geminiCalls === 1, String(geminiCalls));
    check('rule mode still reports missed_true_false to the UI',
      ruleCorrupt.meta?.missed_true_false === true,
      JSON.stringify(ruleCorrupt.meta?.missed_true_false));

    // The clean document must stay on Engine 1 in auto mode (zero AI cost).
    const autoClean = await callExtract(test4Bytes, 'test4.docx', 'auto');
    check('a clean document stays on the rule engine in auto mode',
      autoClean.engine_used === 'rule' && autoClean.count === 24,
      `${autoClean.engine_used}/${autoClean.count}`);
    check('a clean document performs no Engine 2 call', geminiCalls === 1, String(geminiCalls));

    // Regression: test2.docx must still parse with full answer coverage.
    const test2Bytes = new Uint8Array(
      readFileSync(new URL('../../sample/test2.docx', import.meta.url)),
    );
    const test2 = extractWithRules(preprocessDocx(test2Bytes).text);
    check('test2.docx regression: still 98 questions', test2.question_count === 98,
      String(test2.question_count));
    check('test2.docx regression: every question is MCQ with a resolved key',
      test2.data.every((q) => q.question_type === 'MULTIPLE_CHOICE')
        && test2.data.filter((q) => q.correct_answer !== null).length >= 96,
      `${test2.data.filter((q) => q.correct_answer !== null).length}/${test2.question_count}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  /* --- 21. pg_cron log retention (Phase 5.7) ---------------------------- */
  step(21, 'purge_expired_exams() prunes stale cron.job_run_details rows');

  // The `cron` schema is not exposed through the PostgREST API, and
  // cron.job_run_details is RLS-guarded (`username = CURRENT_USER`), so the
  // probe rows are seeded and inspected over a direct SQL connection.
  const sql = (statement) => {
    const output = execFileSync(
      'docker',
      ['exec', SB_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
      { encoding: 'utf8' },
    );
    return output.trim();
  };

  const sqlJson = (statement) => JSON.parse(sql(statement));

  try {
    // Seed one stale (35-day-old) row and one fresh row. runid uses a high
    // sentinel range so the cleanup below cannot touch real cron history.
    sql(
      `insert into cron.job_run_details
         (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       values
         (-1, 990001, 0, 'postgres', 'postgres', 'e2e stale probe', 'succeeded', 'x',
          now() - interval '35 days', now() - interval '35 days'),
         (-1, 990002, 0, 'postgres', 'postgres', 'e2e fresh probe', 'succeeded', 'x', now(), now());`,
    );

    check('stale + fresh probe rows were seeded',
      sql("select count(*) from cron.job_run_details where runid in (990001, 990002);") === '2');

    const pruneResult = sqlJson('select public.purge_expired_exams();');
    check('purge reports the pruned log count', pruneResult.pruned_logs >= 1,
      JSON.stringify(pruneResult));
    check('purge still reports exam purging unchanged', pruneResult.success === true
      && typeof pruneResult.purged_count === 'number', JSON.stringify(pruneResult));

    check('the 35-day-old log row is gone',
      sql('select count(*) from cron.job_run_details where runid = 990001;') === '0');
    check('the fresh log row survives the prune',
      sql('select count(*) from cron.job_run_details where runid = 990002;') === '1');
    check('no log rows older than 30 days remain',
      sql("select count(*) from cron.job_run_details where start_time < now() - interval '30 days';") === '0');

    // Idempotency + blank-state safety: a second sweep must be a clean no-op.
    const secondPrune = sqlJson('select public.purge_expired_exams();');
    check('a second sweep prunes nothing and stays successful',
      secondPrune.success === true && secondPrune.pruned_logs === 0,
      JSON.stringify(secondPrune));

    // The daily pg_cron job must still point at the same function.
    check('the daily purge job is still scheduled',
      sql("select count(*) from cron.job where jobname = 'purge-expired-exams-daily' and active;") === '1');
  } finally {
    sql('delete from cron.job_run_details where runid in (990001, 990002);');
  }

  /* --- 22. Worker keep-alive scheduled handler (Phase 5.7) --------------- */
  step(22, 'Worker scheduled handler pings Supabase PostgREST');

  // Capture the outgoing ping without touching the network.
  const pinged = [];
  const keepAliveFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('supabase.co')) {
      pinged.push({ url, method: init?.method, headers: init?.headers });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return keepAliveFetch(input, init);
  };

  /** Drives the cron entrypoint the way Cloudflare does, tracking waitUntil. */
  const runScheduled = async (env) => {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} };
    await workerApp.scheduled({ cron: '0 0 */3 * *', scheduledTime: Date.now() }, env, ctx);
    await Promise.all(pending);
    return pending.length;
  };

  try {
    const scheduledCount = await runScheduled({
      SUPABASE_URL: 'https://example-project.supabase.co/',
      SUPABASE_ANON_KEY: 'anon-key-under-test',
    });

    check('the scheduled handler registered exactly one waitUntil task', scheduledCount === 1,
      String(scheduledCount));
    check('exactly one Supabase ping was issued', pinged.length === 1, String(pinged.length));
    check('the ping targets the PostgREST root',
      pinged[0]?.url === 'https://example-project.supabase.co/rest/v1/',
      String(pinged[0]?.url));
    check('the ping carries the anon key as apikey + bearer',
      pinged[0]?.headers?.apikey === 'anon-key-under-test'
        && pinged[0]?.headers?.Authorization === 'Bearer anon-key-under-test',
      JSON.stringify(pinged[0]?.headers));

    // Missing bindings must be a silent skip, not a crash or a request.
    pinged.length = 0;
    const skippedCount = await runScheduled({});
    check('an unbound keep-alive is skipped without pinging',
      skippedCount === 1 && pinged.length === 0, `${skippedCount}/${pinged.length}`);

    // A throwing fetch must be swallowed — the cron runtime has no catch point.
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('supabase.co')) throw new Error('simulated network failure');
      return keepAliveFetch(input);
    };
    let survived = true;
    try {
      await runScheduled({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' });
    } catch {
      survived = false;
    }
    check('a failed ping is swallowed, never rejecting the cron handler', survived === true);
  } finally {
    globalThis.fetch = keepAliveFetch;
  }

  /* --- 23. Practice-enabled exams & practice-by-code (Phase 5.8) -------- */
  step(23, 'allow_practice gates get_practice_exam_payload; keys + original order');

  // Clean up any previous run of this exam code (cascades to its questions).
  await teacher.from('exams').delete().eq('code', PRACTICE_EXAM.code);

  // Created with the DEFAULT allow_practice = false, exactly as the teacher UI
  // does before the toggle is touched.
  const practiceExamInsert = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: PRACTICE_EXAM.code,
      title: PRACTICE_EXAM.title,
      duration_minutes: PRACTICE_EXAM.duration,
    })
    .select('id, allow_practice')
    .single();
  check('practice exam created', !practiceExamInsert.error && !!practiceExamInsert.data,
    practiceExamInsert.error?.message);
  check('allow_practice defaults to false', practiceExamInsert.data?.allow_practice === false,
    String(practiceExamInsert.data?.allow_practice));
  const practiceExamId = practiceExamInsert.data?.id;

  const practiceQuestionRows = PRACTICE_QUESTIONS.map((question, index) => ({
    user_id: teacherId,
    exam_id: practiceExamId,
    ...question,
    // Written 1-based, the Phase 2 contract.
    position: index + 1,
  }));
  const practiceQuestionsInsert = await teacher.from('question_bank').insert(practiceQuestionRows);
  check('practice questions seeded', !practiceQuestionsInsert.error,
    practiceQuestionsInsert.error?.message);

  const practiceRoster = await teacher.from('students').insert([
    { student_code: PRACTICE_STUDENT.code, full_name: PRACTICE_STUDENT.fullName, class_name: PRACTICE_STUDENT.className, exam_code: PRACTICE_EXAM.code },
    { student_code: SHUFFLE_STUDENT.code, full_name: SHUFFLE_STUDENT.fullName, class_name: SHUFFLE_STUDENT.className, exam_code: PRACTICE_EXAM.code },
    { student_code: SHUFFLE_CONTROL_STUDENT.code, full_name: SHUFFLE_CONTROL_STUDENT.fullName, class_name: SHUFFLE_CONTROL_STUDENT.className, exam_code: PRACTICE_EXAM.code },
  ]);
  check('practice roster seeded', !practiceRoster.error, practiceRoster.error?.message);

  // The student runtime is anon and holds no table privileges.
  const practiceClient = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* --- 23a. allow_practice = false must refuse the key ------------------ */
  const denied = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: PRACTICE_STUDENT.code,
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('closed practice returns success = false', denied.data?.success === false,
    JSON.stringify(denied.data ?? denied.error));
  check('closed practice reports PRACTICE_NOT_ALLOWED',
    denied.data?.message === 'PRACTICE_NOT_ALLOWED', String(denied.data?.message));
  check('closed practice leaks no questions', denied.data?.questions === undefined,
    JSON.stringify(denied.data));

  // A stranger cannot harvest keys even once practice is enabled.
  const strangerDenied = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: 'NOT-ON-ROSTER',
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('an off-roster caller is rejected while practice is closed',
    strangerDenied.data?.success === false, JSON.stringify(strangerDenied.data));

  /* --- 23b. allow_practice = true unlocks order + keys ------------------ */
  const enablePractice = await teacher
    .from('exams')
    .update({ allow_practice: true })
    .eq('code', PRACTICE_EXAM.code)
    .select('allow_practice')
    .maybeSingle();
  check('teacher enabled allow_practice', enablePractice.data?.allow_practice === true,
    enablePractice.error?.message ?? String(enablePractice.data?.allow_practice));

  const allowed = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: PRACTICE_STUDENT.code,
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('enabled practice succeeds', allowed.data?.success === true,
    JSON.stringify(allowed.data ?? allowed.error));
  check('enabled practice returns all 3 questions',
    allowed.data?.questions?.length === 3, String(allowed.data?.questions?.length));

  // Original `position ASC` order — practice must NEVER shuffle.
  check('questions are returned in original position order',
    JSON.stringify(allowed.data?.questions?.map((q) => q.index)) === '[0,1,2]',
    JSON.stringify(allowed.data?.questions?.map((q) => q.index)));
  check('question texts match the stored order',
    allowed.data?.questions?.[0]?.question_text === PRACTICE_QUESTIONS[0].question_text
      && allowed.data?.questions?.[2]?.question_text === PRACTICE_QUESTIONS[2].question_text,
    JSON.stringify(allowed.data?.questions?.map((q) => q.question_text)));

  // The whole point of the RPC: keys + explanations reach the student runtime.
  check('MCQ answer key is included',
    allowed.data?.questions?.[0]?.correct_answer === 1,
    JSON.stringify(allowed.data?.questions?.[0]?.correct_answer));
  check('TRUE_FALSE answer key is included',
    JSON.stringify(allowed.data?.questions?.[1]?.correct_answer) === JSON.stringify(['Đ', 'S', 'Đ', 'Đ']),
    JSON.stringify(allowed.data?.questions?.[1]?.correct_answer));
  check('SHORT_ANSWER key is included',
    allowed.data?.questions?.[2]?.correct_answer === '5',
    JSON.stringify(allowed.data?.questions?.[2]?.correct_answer));
  check('explanations are included',
    allowed.data?.questions?.[0]?.explanation === 'Paris là thủ đô của Pháp.',
    JSON.stringify(allowed.data?.questions?.[0]?.explanation));

  // The roster check stays load-bearing even with practice enabled.
  const strangerAllowed = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: 'NOT-ON-ROSTER',
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('an off-roster caller is still rejected when practice is enabled',
    strangerAllowed.data?.success === false
      && strangerAllowed.data?.message === 'STUDENT_NOT_WHITELISTED',
    JSON.stringify(strangerAllowed.data));

  const missingExam = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: 'NOEX01',
    p_student_code: PRACTICE_STUDENT.code,
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('an unknown exam reports EXAM_NOT_FOUND',
    missingExam.data?.success === false && missingExam.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(missingExam.data));

  /* --- 23c. a trashed practice exam is invisible to students ------------ */
  await teacher.from('exams').update({ deleted_at: new Date().toISOString() })
    .eq('code', PRACTICE_EXAM.code);
  const trashedProbe = await practiceClient.rpc('get_practice_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: PRACTICE_STUDENT.code,
    p_class_name: PRACTICE_STUDENT.className,
  });
  check('a trashed exam is reported as EXAM_NOT_FOUND',
    trashedProbe.data?.success === false && trashedProbe.data?.message === 'EXAM_NOT_FOUND',
    JSON.stringify(trashedProbe.data));
  await teacher.from('exams').update({ deleted_at: null }).eq('code', PRACTICE_EXAM.code);

  /* --- 23d. practice is graded locally: nothing is persisted ------------ */
  // The student SPA grades in RAM for practice, so no result row, no session
  // row and — critically — no certificate can ever be produced.
  const practiceResults = await teacher
    .from('exam_results')
    .select('id')
    .eq('exam_code', PRACTICE_EXAM.code);
  check('a practice run writes no exam_results row',
    !practiceResults.error && (practiceResults.data ?? []).length === 0,
    JSON.stringify(practiceResults.data));

  const practiceSessions = await teacher
    .from('active_sessions')
    .select('student_code')
    .eq('exam_code', PRACTICE_EXAM.code);
  check('a practice run writes no active_sessions row',
    !practiceSessions.error && (practiceSessions.data ?? []).length === 0,
    JSON.stringify(practiceSessions.data));

  // Even a PERFECT practice score cannot yield a verifiable certificate: the
  // server mints one only from a persisted passing result, and practice has no
  // result at all. This mirrors the client's `checkAndShowCertificateOption`
  // guard, which returns early in practice mode (state.isPractice).
  const practicePayloadJson = JSON.stringify(allowed.data ?? {});
  check('the practice payload carries no result_id to certify',
    !practicePayloadJson.includes('result_id') && !practicePayloadJson.includes('resultId'));

  /* --- 23e. shuffled official submission still grades correctly --------- */
  // Mirrors the SPA: questions are shown in a per-student shuffled order, but
  // answers are re-mapped through displayOrder back to the ORIGINAL 0-based
  // position before submit_exam_result (which grades `position ASC`).
  const shuffledStudent = SHUFFLE_STUDENT; // the dedicated shuffle candidate

  const acquireShuffle = await practiceClient.rpc('verify_and_acquire_session', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: shuffledStudent.code,
    p_full_name: shuffledStudent.fullName,
    p_class_name: shuffledStudent.className,
    p_device_info: 'e2e-shuffle/1.0',
    p_existing_token: null,
  });
  check('shuffle candidate acquired a session', acquireShuffle.data?.success === true,
    JSON.stringify(acquireShuffle.data ?? acquireShuffle.error));
  const shuffleToken = acquireShuffle.data?.session_token;
  const shufflePayload = await practiceClient.rpc('get_student_exam_payload', {
    p_exam_code: PRACTICE_EXAM.code,
    p_session_token: shuffleToken,
  });
  check('official payload omits the keys (F1/F3), unlike practice',
    shufflePayload.data?.success === true
      && !JSON.stringify(shufflePayload.data).includes('correct_answer'),
    JSON.stringify(shufflePayload.data).slice(0, 160));
  check('official payload delivered 3 questions',
    shufflePayload.data?.questions?.length === 3, String(shufflePayload.data?.questions?.length));

  // Build the answer array exactly as the SPA would for SHUFFLE_ORDER:
  // display slot i shows the question at original position SHUFFLE_ORDER[i].
  const shuffledAnswers = SHUFFLE_ORDER.map((originalIndex) => ({
    questionIndex: originalIndex,
    ...PRACTICE_CORRECT_ANSWERS[originalIndex],
  }));
  check('the shuffled answer array is not in display order',
    shuffledAnswers.map((a) => a.questionIndex).join(',') === '2,0,1',
    shuffledAnswers.map((a) => a.questionIndex).join(','));

  const shuffledSubmit = await practiceClient.rpc('submit_exam_result', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: shuffledStudent.code,
    p_session_token: shuffleToken,
    p_answers: shuffledAnswers,
    p_metrics: { blurCount: 0, fullscreenExitCount: 0, elapsedSeconds: 120 },
  });
  check('shuffled submission accepted', shuffledSubmit.data?.success === true,
    JSON.stringify(shuffledSubmit.data ?? shuffledSubmit.error));
  check('the re-mapped answers earn the full score',
    Number(shuffledSubmit.data?.score) === PRACTICE_FULL_SCORE,
    String(shuffledSubmit.data?.score));

  /* --- 23f. control: WITHOUT the remap the score collapses -------------- */
  // Emulates the buggy client: the candidate answers correctly on screen, but
  // the payload uses the DISPLAY slot as `questionIndex` instead of the original
  // position. Each on-screen choice is the right one for original question
  // SHUFFLE_ORDER[displayIndex], so submitting it at `questionIndex = displayIndex`
  // lands every answer on the wrong question. This proves the remap in 23e is
  // what makes it pass, rather than the questions happening to align.
  const controlAcquire = await practiceClient.rpc('verify_and_acquire_session', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: SHUFFLE_CONTROL_STUDENT.code,
    p_full_name: SHUFFLE_CONTROL_STUDENT.fullName,
    p_class_name: SHUFFLE_CONTROL_STUDENT.className,
    p_device_info: 'e2e-shuffle-control/1.0',
    p_existing_token: null,
  });
  const controlToken = controlAcquire.data?.session_token;
  const controlAnswers = SHUFFLE_ORDER.map((originalIndex, displayIndex) => ({
    questionIndex: displayIndex, // BUG: display slot used as the original position
    ...PRACTICE_CORRECT_ANSWERS[originalIndex],
  }));
  const controlSubmit = await practiceClient.rpc('submit_exam_result', {
    p_exam_code: PRACTICE_EXAM.code,
    p_student_code: SHUFFLE_CONTROL_STUDENT.code,
    p_session_token: controlToken,
    p_answers: controlAnswers,
    p_metrics: { blurCount: 0, fullscreenExitCount: 0, elapsedSeconds: 120 },
  });
  check('an un-remapped (display-order) submission does NOT score full marks',
    controlSubmit.data?.success === true && Number(controlSubmit.data?.score) < PRACTICE_FULL_SCORE,
    String(controlSubmit.data?.score));

  /* --- 24. Practice question shuffle toggle (Phase 5.9) ----------------- */
  step(24, 'practice shuffle toggle reorders questions but keeps every key');

  // A 6-question fixture with a distinct key per question, so any mis-ordering
  // is detectable (a duplicate key would hide a permutation bug).
  const practiceFixture = Array.from({ length: 6 }, (_, i) => ({
    position: i + 1,
    type: 'MCQ',
    content: `Câu ${i + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correctAnswer: i, // key encodes the question's identity
    explanation: `Giải thích ${i + 1}`,
  }));

  // --- 24a. toggle OFF => strict original `position ASC` order ------------
  const ordered = partitionAndShuffleQuestions(practiceFixture, false);
  check('shuffle OFF keeps the original source order',
    JSON.stringify(ordered.map((q) => q.content)) === JSON.stringify(practiceFixture.map((q) => q.content)),
    JSON.stringify(ordered.map((q) => q.content)));
  check('shuffle OFF returns a new array (input not mutated)',
    ordered !== practiceFixture
      && JSON.stringify(practiceFixture.map((q) => q.position)) === '[1,2,3,4,5,6]');

  // A caller that hands over a scrambled list must still get `position ASC`.
  const scrambled = [practiceFixture[3], practiceFixture[0], practiceFixture[5], practiceFixture[1], practiceFixture[4], practiceFixture[2]];
  const resorted = partitionAndShuffleQuestions(scrambled, false);
  check('shuffle OFF re-sorts a scrambled input by position',
    JSON.stringify(resorted.map((q) => q.position)) === '[1,2,3,4,5,6]',
    JSON.stringify(resorted.map((q) => q.position)));

  // --- 24b. toggle ON => order differs, content preserved ----------------
  const shuffled = partitionAndShuffleQuestions(practiceFixture, true);
  check('shuffle ON preserves the question count',
    shuffled.length === practiceFixture.length, String(shuffled.length));
  check('shuffle ON preserves every question exactly once',
    JSON.stringify([...shuffled].map((q) => q.content).sort())
      === JSON.stringify(practiceFixture.map((q) => q.content).sort()),
    JSON.stringify(shuffled.map((q) => q.content)));
  check('shuffle ON preserves every answer key with its question',
    [...shuffled].every((q) => q.correctAnswer === practiceFixture.find((s) => s.content === q.content).correctAnswer),
    JSON.stringify(shuffled.map((q) => [q.content, q.correctAnswer])));
  check('shuffle ON preserves every explanation',
    [...shuffled].every((q) => q.explanation === `Giải thích ${q.position}`),
    JSON.stringify(shuffled.map((q) => q.explanation)));
  check('shuffle ON does not mutate the source array',
    JSON.stringify(practiceFixture.map((q) => q.position)) === '[1,2,3,4,5,6]');

  // Randomness: over many runs a non-identity order must appear. (A 6! space
  // makes a stuck identity astronomically unlikely if the shuffle truly runs.)
  const seenOrders = new Set();
  for (let i = 0; i < 60; i += 1) {
    seenOrders.add(partitionAndShuffleQuestions(practiceFixture, true).map((q) => q.content).join('|'));
  }
  check('shuffle ON produces more than one distinct order across runs',
    seenOrders.size > 1, String(seenOrders.size));
  check('shuffle ON can produce an order different from the original',
    [...seenOrders].some((order) => order !== practiceFixture.map((q) => q.content).join('|')));

  // --- 24c. the permutation primitive is sound ---------------------------
  for (const n of [1, 2, 5, 25]) {
    const perm = shuffledOrder(n);
    check(`shuffledOrder(${n}) is a permutation of 0..n-1`,
      perm.length === n && [...perm].sort((a, b) => a - b).every((v, i) => v === i),
      JSON.stringify(perm));
  }
  check('shuffledOrder(0) is empty', shuffledOrder(0).length === 0);
  check('shuffledOrder(1) is the identity', JSON.stringify(shuffledOrder(1)) === '[0]');

  // --- 24d. the toggle reader defaults to "no shuffle" ------------------
  const fakeDoc = (checked) => ({ getElementById: () => (checked === null ? null : { checked }) });
  check('toggle unchecked => shuffle disabled', readShuffleToggle(fakeDoc(false)) === false);
  check('toggle checked => shuffle enabled', readShuffleToggle(fakeDoc(true)) === true);
  check('missing toggle node => shuffle disabled', readShuffleToggle(fakeDoc(null)) === false);
  check('absent document => shuffle disabled', readShuffleToggle(undefined) === false);

  // --- 24e. empty / degenerate inputs are safe --------------------------
  check('empty list stays empty (shuffle ON)', partitionAndShuffleQuestions([], true).length === 0);
  check('empty list stays empty (shuffle OFF)', partitionAndShuffleQuestions([], false).length === 0);
  check('a non-array is treated as empty', partitionAndShuffleQuestions(null, true).length === 0);
  check('a single question survives the shuffle',
    partitionAndShuffleQuestions([practiceFixture[0]], true)[0].correctAnswer === 0);

  /* --- 25. Class rosters + flexible PIN auth (Phase 6.1) ---------------- */
  step(25, 'class roster import and NONE / GLOBAL / INDIVIDUAL PIN enforcement');

  await teacher.from('exams').delete().eq('code', PIN_EXAM.code);

  // --- 25a. class + member CRUD (teacher owns both) ----------------------
  const classInsert = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: PIN_CLASS.name, academic_year: PIN_CLASS.academicYear })
    .select('id, name, academic_year')
    .single();
  check('class created', !classInsert.error && !!classInsert.data, classInsert.error?.message);
  const classId = classInsert.data?.id;

  const memberRows = [
    { class_id: classId, student_code: PIN_MEMBER_CUSTOM.code, full_name: PIN_MEMBER_CUSTOM.fullName, dob: PIN_MEMBER_CUSTOM.dob, pin: PIN_MEMBER_CUSTOM.pin },
    { class_id: classId, student_code: PIN_MEMBER_DOB.code,    full_name: PIN_MEMBER_DOB.fullName,    dob: PIN_MEMBER_DOB.dob,    pin: PIN_MEMBER_DOB.pin },
    { class_id: classId, student_code: PIN_MEMBER_PLAIN.code,  full_name: PIN_MEMBER_PLAIN.fullName,  dob: PIN_MEMBER_PLAIN.dob,  pin: PIN_MEMBER_PLAIN.pin },
  ];
  const membersInsert = await teacher.from('class_members').insert(memberRows).select('id, student_code, dob, pin');
  check('3 class members created', !membersInsert.error && membersInsert.data?.length === 3,
    membersInsert.error?.message ?? String(membersInsert.data?.length));
  check('a member stores its custom PIN',
    membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_CUSTOM.code)?.pin === PIN_MEMBER_CUSTOM.pin,
    JSON.stringify(membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_CUSTOM.code)));
  check('a member stores its DOB as a date',
    membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_DOB.code)?.dob === PIN_MEMBER_DOB.dob,
    JSON.stringify(membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_DOB.code)?.dob));
  check('a member may have neither PIN nor DOB',
    membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_PLAIN.code)?.pin === null
      && membersInsert.data?.find((m) => m.student_code === PIN_MEMBER_PLAIN.code)?.dob === null);

  // The unique constraint must stop a duplicate roster row.
  const dupMember = await teacher.from('class_members').insert({
    class_id: classId, student_code: PIN_MEMBER_CUSTOM.code,
    full_name: PIN_MEMBER_CUSTOM.fullName,
  });
  check('duplicate (class_id, student_code) is rejected', !!dupMember.error,
    dupMember.error?.code);

  // --- 25b. import_class_to_exam populates the exam whitelist ------------
  const examInsert25 = await teacher
    .from('exams')
    .insert({ user_id: teacherId, code: PIN_EXAM.code, title: PIN_EXAM.title, duration_minutes: PIN_EXAM.duration })
    .select('id, pin_mode')
    .single();
  check('PIN exam created', !examInsert25.error && !!examInsert25.data, examInsert25.error?.message);
  check('pin_mode defaults to INDIVIDUAL', examInsert25.data?.pin_mode === 'INDIVIDUAL',
    String(examInsert25.data?.pin_mode));

  const importResult = await teacher.rpc('import_class_to_exam', {
    p_exam_code: PIN_EXAM.code,
    p_class_ids: [classId],
  });
  check('import_class_to_exam succeeded', !importResult.error, importResult.error?.message);
  check('import reported 3 rows', Number(importResult.data) === 3, String(importResult.data));

  const importedStudents = await teacher
    .from('students')
    .select('student_code, full_name, class_name, dob, pin')
    .eq('exam_code', PIN_EXAM.code)
    .order('student_code');
  check('3 students landed on the exam roster', importedStudents.data?.length === 3,
    String(importedStudents.data?.length));
  check('imported rows carry the class name',
    importedStudents.data?.every((s) => s.class_name === PIN_CLASS.name),
    JSON.stringify(importedStudents.data?.map((s) => s.class_name)));
  check('imported rows carry dob + pin',
    importedStudents.data?.find((s) => s.student_code === PIN_MEMBER_CUSTOM.code)?.pin === PIN_MEMBER_CUSTOM.pin
      && importedStudents.data?.find((s) => s.student_code === PIN_MEMBER_DOB.code)?.dob === PIN_MEMBER_DOB.dob,
    JSON.stringify(importedStudents.data));

  // Re-import must REFRESH, not duplicate or fail.
  const reImport = await teacher.rpc('import_class_to_exam', {
    p_exam_code: PIN_EXAM.code,
    p_class_ids: [classId],
  });
  check('re-import is idempotent (3 rows still)', !reImport.error && Number(reImport.data) === 3,
    reImport.error?.message ?? String(reImport.data));
  const afterReImport = await teacher
    .from('students').select('student_code').eq('exam_code', PIN_EXAM.code);
  check('re-import did not duplicate roster rows', afterReImport.data?.length === 3,
    String(afterReImport.data?.length));

  // Import must refuse an exam the caller does not own.
  await teacher.from('exams').update({ deleted_at: new Date().toISOString() }).eq('code', PIN_EXAM.code);
  const importTrashed = await teacher.rpc('import_class_to_exam', {
    p_exam_code: PIN_EXAM.code, p_class_ids: [classId],
  });
  check('import refuses a trashed exam', !!importTrashed.error
    && String(importTrashed.error.message).includes('UNAUTHORIZED_OR_EXAM_NOT_FOUND'),
    importTrashed.error?.message);
  await teacher.from('exams').update({ deleted_at: null }).eq('code', PIN_EXAM.code);

  const importUnknown = await teacher.rpc('import_class_to_exam', {
    p_exam_code: 'NOPE99', p_class_ids: [classId],
  });
  check('import refuses an unknown exam', !!importUnknown.error
    && String(importUnknown.error.message).includes('UNAUTHORIZED_OR_EXAM_NOT_FOUND'),
    importUnknown.error?.message);

  // --- 25c. PIN matrix ---------------------------------------------------
  // The single-device lock (60s) would otherwise make a second attempt for the
  // SAME student return SESSION_ACTIVE_ELSEWHERE and mask the PIN result, so
  // each attempt starts from a clean session row. The lock itself is already
  // covered by Steps 4/9; here we isolate the PIN gate.
  const adminClient = createClient(SB_URL, SB_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tryLogin = async (student, pin, extra = {}) => {
    await adminClient.from('active_sessions').delete()
      .eq('exam_code', PIN_EXAM.code).eq('student_code', student.code);
    return createClient(SB_URL, SB_PUBLISHABLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).rpc('verify_and_acquire_session', {
      p_exam_code: PIN_EXAM.code,
      p_student_code: student.code,
      p_full_name: student.fullName,
      p_class_name: PIN_CLASS.name,
      p_device_info: 'e2e-pin/1.0',
      p_existing_token: null,
      p_pin: pin,
      ...extra,
    });
  };

  // INDIVIDUAL + custom PIN.
  const wrongPin = await tryLogin(PIN_MEMBER_CUSTOM, 'WRONG');
  check('INDIVIDUAL: a wrong custom PIN is refused', wrongPin.data?.success === false,
    JSON.stringify(wrongPin.data));
  check('INDIVIDUAL: a wrong custom PIN reports code INVALID_PIN',
    wrongPin.data?.code === 'INVALID_PIN', String(wrongPin.data?.code));
  check('INDIVIDUAL: the refusal message is the Vietnamese PIN copy',
    String(wrongPin.data?.message).includes('Mã PIN'), String(wrongPin.data?.message));

  const rightPin = await tryLogin(PIN_MEMBER_CUSTOM, PIN_MEMBER_CUSTOM.pin);
  check('INDIVIDUAL: the correct custom PIN is accepted', rightPin.data?.success === true,
    JSON.stringify(rightPin.data));
  check('INDIVIDUAL: the correct PIN issues a session token', !!rightPin.data?.session_token);

  // INDIVIDUAL + DOB fallback (no PIN set).
  const wrongDob = await tryLogin(PIN_MEMBER_DOB, '9999');
  check('INDIVIDUAL/DOB: a wrong DDMM is refused', wrongDob.data?.success === false
    && wrongDob.data?.code === 'INVALID_PIN', JSON.stringify(wrongDob.data));
  const rightDob = await tryLogin(PIN_MEMBER_DOB, PIN_DOB_EXPECTED);
  check('INDIVIDUAL/DOB: the DDMM fallback (0509) is accepted', rightDob.data?.success === true,
    JSON.stringify(rightDob.data));
  // A custom PIN must WIN over DOB: the member's DOB digits are NOT accepted.
  const dobInsteadOfPin = await tryLogin(PIN_MEMBER_CUSTOM, '0201');
  check('INDIVIDUAL: DOB is rejected when a custom PIN exists',
    dobInsteadOfPin.data?.success === false && dobInsteadOfPin.data?.code === 'INVALID_PIN',
    JSON.stringify(dobInsteadOfPin.data));

  // INDIVIDUAL + neither secret -> no PIN required (legacy compatibility).
  const noSecret = await tryLogin(PIN_MEMBER_PLAIN, '');
  check('INDIVIDUAL: no pin/dob means no PIN is required', noSecret.data?.success === true,
    JSON.stringify(noSecret.data));

  // GLOBAL.
  await teacher.from('exams').update({ pin_mode: 'GLOBAL', global_pin: PIN_GLOBAL_VALUE }).eq('code', PIN_EXAM.code);
  const globalWrong = await tryLogin(PIN_MEMBER_PLAIN, 'NOPE');
  check('GLOBAL: a wrong shared PIN is refused', globalWrong.data?.success === false
    && globalWrong.data?.code === 'INVALID_PIN', JSON.stringify(globalWrong.data));
  // The member's own custom PIN must NOT work in GLOBAL mode — only the shared one.
  const globalMemberPin = await tryLogin(PIN_MEMBER_CUSTOM, PIN_MEMBER_CUSTOM.pin);
  check('GLOBAL: an individual PIN does not satisfy the shared policy',
    globalMemberPin.data?.success === false, JSON.stringify(globalMemberPin.data));
  const globalRight = await tryLogin(PIN_MEMBER_PLAIN, PIN_GLOBAL_VALUE);
  check('GLOBAL: the shared PIN is accepted', globalRight.data?.success === true,
    JSON.stringify(globalRight.data));

  // GLOBAL with an unset global_pin must FAIL CLOSED (the null-safe comparison).
  await teacher.from('exams').update({ global_pin: null }).eq('code', PIN_EXAM.code);
  const globalUnset = await tryLogin(PIN_MEMBER_PLAIN, '');
  check('GLOBAL: an unset shared PIN fails closed (no silent admission)',
    globalUnset.data?.success === false && globalUnset.data?.code === 'INVALID_PIN',
    JSON.stringify(globalUnset.data));

  // NONE.
  await teacher.from('exams').update({ pin_mode: 'NONE' }).eq('code', PIN_EXAM.code);
  const noneEmpty = await tryLogin(PIN_MEMBER_CUSTOM, '');
  check('NONE: an empty PIN is accepted', noneEmpty.data?.success === true, JSON.stringify(noneEmpty.data));
  const noneGarbage = await tryLogin(PIN_MEMBER_DOB, 'literally-anything');
  check('NONE: any PIN value is accepted (verification skipped)',
    noneGarbage.data?.success === true, JSON.stringify(noneGarbage.data));

  // The CHECK constraint must reject an invalid mode.
  const badMode = await teacher.from('exams').update({ pin_mode: 'BOGUS' }).eq('code', PIN_EXAM.code);
  check('an invalid pin_mode is rejected by chk_pin_mode', !!badMode.error,
    badMode.error?.message ?? 'no error raised');

  // --- 25d. the old 6-arg signature must be GONE (PIN-bypass regression) --
  // If `create or replace` had left the PIN-less overload in place, a caller
  // could simply omit p_pin and bypass the policy entirely.
  await teacher.from('exams').update({ pin_mode: 'INDIVIDUAL', global_pin: null }).eq('code', PIN_EXAM.code);
  const legacyCall = await tryLogin(PIN_MEMBER_CUSTOM, null);
  // PostgREST resolves the 7-arg function via its defaults, so p_pin is NULL ->
  // the INDIVIDUAL policy must still refuse (the member has a custom PIN).
  check('omitting p_pin does NOT bypass the INDIVIDUAL policy',
    legacyCall.data?.success === false && legacyCall.data?.code === 'INVALID_PIN',
    JSON.stringify(legacyCall.data));

  /* --- 26. Teacher web: roster mgmt + CSV template + PIN config (6.2) --- */
  step(26, 'teacher web class roster, CSV template download, and exam PIN config');

  // --- 26a. EXAM_COLUMNS carries the Phase 6.1 PIN columns --------------
  // The dashboard/edit loaders select an explicit column list; omitting the PIN
  // columns would leave `pin_mode` undefined at runtime while TypeScript still
  // believes it is a valid PinMode. Assert on the real constant, not a copy.
  const columns = EXAM_COLUMNS.split(',').map((c) => c.trim());
  check('EXAM_COLUMNS includes pin_mode', columns.includes('pin_mode'), EXAM_COLUMNS);
  check('EXAM_COLUMNS includes global_pin', columns.includes('global_pin'), EXAM_COLUMNS);

  // --- 26b. CSV template: BOM, headers, filename ------------------------
  const template = buildStudentCsvTemplate();
  check('template starts with a UTF-8 BOM', template.charCodeAt(0) === 0xfeff,
    String(template.charCodeAt(0)));
  check('template BOM survives as the U+FEFF code point', template[0] === '\uFEFF',
    JSON.stringify(template[0]));

  const templateHeaderLine = template.slice(1).split(/\r?\n/)[0];
  check('template header line is exact',
    templateHeaderLine === 'STT,Ho_va_ten,Ngay_sinh,Ma_hoc_sinh,Ma_PIN,To_nhom,Nhom', templateHeaderLine);
  check('template header constant matches the emitted line',
    STUDENT_TEMPLATE_HEADERS.join(',') === templateHeaderLine,
    STUDENT_TEMPLATE_HEADERS.join(','));

  const templateRows = template.slice(1).split(/\r?\n/).filter(Boolean);
  check('template ships a header + 3 sample rows', templateRows.length === 4,
    String(templateRows.length));
  check('sample row 1 = name + DOB only (auto code + DDMM PIN + round-robin team)',
    templateRows[1] === '1,Nguyễn Văn An,05/09/2008,,,,', templateRows[1]);
  check('sample row 2 = custom code + custom PIN + explicit team 2 + group 2',
    templateRows[2] === '2,Trần Thị Bình,12/03/2008,HS001,123456,2,2', templateRows[2]);
  check('sample row 3 = name only + explicit team 3 + group 3',
    templateRows[3] === '3,Lê Văn Cường,,,,3,3', templateRows[3]);
  check('template filename falls back to "Lop"',
    studentTemplateFilename() === 'Mau_Danh_Sach_Hoc_Sinh_Lop.csv', studentTemplateFilename());
  check('template filename embeds the class name',
    studentTemplateFilename('12A1') === 'Mau_Danh_Sach_Hoc_Sinh_12A1.csv',
    studentTemplateFilename('12A1'));

  // The Vietnamese sample must survive the round-trip as real diacritics; a
  // mis-encoded file is exactly the corruption the BOM exists to prevent.
  check('template keeps Vietnamese diacritics intact',
    template.includes('Nguyễn Văn An'), JSON.stringify(template.slice(0, 60)));

  // --- 26c. parseStudentRosterFile re-imports the template --------------
  // The suite feeds the app's OWN template back through the app's OWN parser:
  // that is the teacher's real flow (download -> fill -> upload).
  const templateFile = new File([template], 'Mau_Danh_Sach_Hoc_Sinh_12A1.csv', {
    type: 'text/csv',
  });
  const parsed = await parseStudentRosterFile(templateFile, '12A1');
  check('parser reads all 3 template rows', parsed.length === 3, String(parsed.length));

  const parsedAn = parsed.find((m) => m.full_name === 'Nguyễn Văn An');
  check('row 1 auto-generates a class-prefixed code', parsedAn?.student_code === '12A1_01',
    JSON.stringify(parsedAn));
  // 05/09/2008 must be read as DD/MM (5 September), not US MM/DD (9 May).
  check('row 1 normalises DD/MM/YYYY to ISO', parsedAn?.dob === '2008-09-05',
    JSON.stringify(parsedAn?.dob));
  check('row 1 derives the DDMM PIN from DOB', parsedAn?.pin === '0509',
    JSON.stringify(parsedAn?.pin));

  const parsedBinh = parsed.find((m) => m.full_name === 'Trần Thị Bình');
  check('row 2 keeps its explicit student code', parsedBinh?.student_code === 'HS001',
    JSON.stringify(parsedBinh?.student_code));
  check('row 2 keeps its explicit PIN', parsedBinh?.pin === '123456',
    JSON.stringify(parsedBinh?.pin));

  const parsedCuong = parsed.find((m) => m.full_name === 'Lê Văn Cường');
  check('row 3 auto-generates the next ordinal', parsedCuong?.student_code === '12A1_03',
    JSON.stringify(parsedCuong?.student_code));
  check('row 3 has neither DOB nor PIN', parsedCuong?.dob === null && parsedCuong?.pin === null,
    JSON.stringify(parsedCuong));

  // Phase 8.4 — team assignment. Row 1 omits `To_nhom`, so the parser assigns it
  // round-robin from the row's 0-based index: ((index % 4) + 1).
  check('row 1 with a blank To_nhom is assigned team 1 round-robin',
    parsedAn?.team_number === 1, JSON.stringify(parsedAn?.team_number));
  check('row 2 keeps its explicit To_nhom = 2',
    parsedBinh?.team_number === 2, JSON.stringify(parsedBinh?.team_number));
  check('row 3 keeps its explicit To_nhom = 3',
    parsedCuong?.team_number === 3, JSON.stringify(parsedCuong?.team_number));
  check('every parsed member carries a team_number in 1..4',
    parsed.every((m) => Number.isInteger(m.team_number) && m.team_number >= 1 && m.team_number <= 4),
    JSON.stringify(parsed.map((m) => m.team_number)));

  // Phase 8.11 — the `Nhom` column. Unlike `To_nhom` there is NO round-robin
  // fallback: a blank cell leaves the field UNDEFINED so the DB default (or the
  // member's existing group) survives a re-import.
  check('row 1 with a blank Nhom leaves group_number undefined',
    parsedAn?.group_number === undefined, JSON.stringify(parsedAn?.group_number));
  check('row 2 keeps its explicit Nhom = 2', parsedBinh?.group_number === 2,
    JSON.stringify(parsedBinh?.group_number));
  check('row 3 keeps its explicit Nhom = 3', parsedCuong?.group_number === 3,
    JSON.stringify(parsedCuong?.group_number));
  check('a parsed group_number, when present, is in 1..8',
    parsed.every((m) => m.group_number === undefined
      || (Number.isInteger(m.group_number) && m.group_number >= 1 && m.group_number <= 8)),
    JSON.stringify(parsed.map((m) => m.group_number)));

  // --- 26d. class roster CRUD through the client SDK --------------------
  await teacher.from('exams').delete().eq('code', CLASS_EXAM.code);

  const webClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: CLASS_PICK.name, academic_year: CLASS_PICK.academicYear })
    .select('id, name, academic_year')
    .single();
  check('26d: class created via client SDK', !webClass.error && !!webClass.data,
    webClass.error?.message);
  const webClassId = webClass.data?.id;

  // saveClassMembers is the exact function the "📄 Nhập từ file" button calls.
  const savedMembers = await saveClassMembers(teacher, webClassId, CLASS_PICK_MEMBERS.map((m) => ({
    student_code: m.code,
    full_name: m.fullName,
    dob: m.dob,
    pin: m.pin,
    team_number: m.team,
  })));
  check('26d: saveClassMembers persisted both rows', savedMembers.saved === 2,
    String(savedMembers.saved));

  // listClasses folds the nested `class_members(count)` aggregate into
  // member_count, so the roster badge is correct without an N+1 query.
  const classes = await listClasses(teacher);
  const listedClass = classes.find((c) => c.id === webClassId);
  check('26d: listClasses exposes the class', !!listedClass, String(classes.length));
  check('26d: listClasses reports member_count = 2', listedClass?.member_count === 2,
    String(listedClass?.member_count));

  // Re-importing the same rows must upsert, not duplicate.
  await saveClassMembers(teacher, webClassId, CLASS_PICK_MEMBERS.map((m) => ({
    student_code: m.code,
    full_name: m.fullName,
    dob: m.dob,
    pin: m.pin,
    team_number: m.team,
  })));
  const afterUpsert = await teacher.from('class_members').select('id').eq('class_id', webClassId);
  check('26d: re-import upserts instead of duplicating', afterUpsert.data?.length === 2,
    String(afterUpsert.data?.length));

  // --- 26e. importClassToExam through the client SDK --------------------
  const webExam = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: CLASS_EXAM.code,
      title: CLASS_EXAM.title,
      duration_minutes: CLASS_EXAM.duration,
    })
    .select('id, code')
    .single();
  check('26e: exam created via client SDK', !webExam.error && !!webExam.data,
    webExam.error?.message);

  const importedCount = await importClassToExam(teacher, CLASS_EXAM.code, [webClassId]);
  check('26e: importClassToExam returned the row count', importedCount === 2,
    String(importedCount));

  const webRoster = await teacher
    .from('students')
    .select('student_code, full_name, class_name, dob, pin')
    .eq('exam_code', CLASS_EXAM.code)
    .order('student_code');
  check('26e: both members landed on the exam roster', webRoster.data?.length === 2,
    String(webRoster.data?.length));
  check('26e: imported rows carry the class name',
    webRoster.data?.every((s) => s.class_name === CLASS_PICK.name),
    JSON.stringify(webRoster.data?.map((s) => s.class_name)));
  check('26e: the DDMM PIN is preserved end-to-end',
    webRoster.data?.find((s) => s.student_code === 'E2EWEB01')?.pin === null
      && webRoster.data?.find((s) => s.student_code === 'E2EWEB01')?.dob === '2009-01-02',
    JSON.stringify(webRoster.data?.find((s) => s.student_code === 'E2EWEB01')));

  // An unknown exam must surface as the translated PersistenceError, which is
  // what the UI renders (the raw RPC message is an unreadable SQL string).
  let importRejected = false;
  try {
    await importClassToExam(teacher, 'NOPE99', [webClassId]);
  } catch (err) {
    importRejected = err instanceof PersistenceError && err.message.includes('quyền truy cập');
  }
  check('26e: an unknown exam raises the translated PersistenceError', importRejected);

  // --- 26f. PIN config through updateExamMetadata -----------------------
  await updateExamMetadata(teacher, CLASS_EXAM.code, { pinMode: 'GLOBAL', globalPin: CLASS_EXAM.globalPin });
  const afterPin = await teacher
    .from('exams').select('pin_mode, global_pin').eq('code', CLASS_EXAM.code).single();
  check('26f: pin_mode persisted as GLOBAL', afterPin.data?.pin_mode === 'GLOBAL',
    String(afterPin.data?.pin_mode));
  check('26f: global_pin persisted', afterPin.data?.global_pin === CLASS_EXAM.globalPin,
    String(afterPin.data?.global_pin));

  // Switching to GLOBAL without supplying a PIN must fail loudly: Phase 6.1's
  // RPC fails CLOSED on a NULL shared PIN, so a silent write would lock out the
  // entire room with no diagnosable cause.
  let blankGlobalRejected = false;
  try {
    await updateExamMetadata(teacher, CLASS_EXAM.code, { pinMode: 'GLOBAL', globalPin: '   ' });
  } catch (err) {
    blankGlobalRejected = err instanceof PersistenceError;
  }
  check('26f: GLOBAL with a blank PIN is rejected client-side', blankGlobalRejected);

  // A partial patch (mode only) must not clobber the stored PIN.
  await updateExamMetadata(teacher, CLASS_EXAM.code, { pinMode: 'NONE' });
  const afterNone = await teacher
    .from('exams').select('pin_mode, global_pin').eq('code', CLASS_EXAM.code).single();
  check('26f: pin_mode NONE persisted', afterNone.data?.pin_mode === 'NONE',
    String(afterNone.data?.pin_mode));
  // The stored PIN is intentionally retained so the editor can resend it.
  check('26f: global_pin is retained when leaving GLOBAL (so it can be restored)',
    afterNone.data?.global_pin === CLASS_EXAM.globalPin, String(afterNone.data?.global_pin));

  // Switching TO GLOBAL without supplying a PIN is refused even though a value
  // is stored: the write path cannot know whether a concurrent change cleared
  // it, and a NULL shared PIN locks out the whole room (Phase 6.1 fails CLOSED).
  let modeOnlyRejected = false;
  try {
    await updateExamMetadata(teacher, CLASS_EXAM.code, { pinMode: 'GLOBAL' });
  } catch (err) {
    modeOnlyRejected = err instanceof PersistenceError;
  }
  check('26f: switching to GLOBAL without a PIN is refused (fail-closed)', modeOnlyRejected);

  // The editor resends the retained value, which is the path that succeeds.
  await updateExamMetadata(teacher, CLASS_EXAM.code, {
    pinMode: 'GLOBAL',
    globalPin: CLASS_EXAM.globalPin,
  });
  const afterRestore = await teacher
    .from('exams').select('pin_mode, global_pin').eq('code', CLASS_EXAM.code).single();
  check('26f: re-sending the retained PIN restores GLOBAL',
    afterRestore.data?.pin_mode === 'GLOBAL'
      && afterRestore.data?.global_pin === CLASS_EXAM.globalPin,
    JSON.stringify(afterRestore.data));

  // --- 26g. the saved PIN actually gates admission ----------------------
  // Proves the teacher-web configuration is wired to the Phase 6.1 auth gate
  // end-to-end, not merely persisted.
  const webAdmin = createClient(SB_URL, SB_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tryWebLogin = async (student, pin) => {
    await webAdmin.from('active_sessions').delete()
      .eq('exam_code', CLASS_EXAM.code).eq('student_code', student.code);
    return createClient(SB_URL, SB_PUBLISHABLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).rpc('verify_and_acquire_session', {
      p_exam_code: CLASS_EXAM.code,
      p_student_code: student.code,
      p_full_name: student.fullName,
      p_class_name: CLASS_PICK.name,
      p_device_info: 'e2e-web/1.0',
      p_existing_token: null,
      p_pin: pin,
    });
  };

  const webWrong = await tryWebLogin(CLASS_PICK_MEMBERS[0], 'NOPE');
  check('26g: the web-configured GLOBAL PIN refuses a wrong value',
    webWrong.data?.success === false && webWrong.data?.code === 'INVALID_PIN',
    JSON.stringify(webWrong.data));
  const webRight = await tryWebLogin(CLASS_PICK_MEMBERS[0], CLASS_EXAM.globalPin);
  check('26g: the web-configured GLOBAL PIN admits the correct value',
    webRight.data?.success === true, JSON.stringify(webRight.data));

  /* --- 27. Student roster picker: get_exam_roster (6.3) ---------------- */
  step(27, 'student URL prefill, roster picker, and PIN auth flow');

  // --- 27a. fixtures ----------------------------------------------------
  await teacher.from('exams').delete().in('code', [
    ROSTER_EXAM.code,
    ROSTER_TRASH_EXAM.code,
    ROSTER_CLOSED_EXAM.code,
    ROSTER_NOT_STARTED_EXAM.code,
    ROSTER_ENDED_EXAM.code,
  ]);

  // NOTE: PostgREST sends a multi-row INSERT as ONE statement, so any column
  // omitted from a row is filled with NULL rather than the column DEFAULT. Every
  // row therefore states `pin_mode` explicitly instead of relying on the default.
  const rosterExamsInsert = await teacher.from('exams').insert([
    {
      user_id: teacherId,
      code: ROSTER_EXAM.code,
      title: ROSTER_EXAM.title,
      duration_minutes: ROSTER_EXAM.duration,
      is_active: true,
      pin_mode: 'GLOBAL',
      global_pin: ROSTER_EXAM.globalPin,
    },
    {
      user_id: teacherId,
      code: ROSTER_TRASH_EXAM.code,
      title: ROSTER_TRASH_EXAM.title,
      duration_minutes: ROSTER_TRASH_EXAM.duration,
      is_active: true,
      pin_mode: 'INDIVIDUAL',
    },
    {
      user_id: teacherId,
      code: ROSTER_CLOSED_EXAM.code,
      title: ROSTER_CLOSED_EXAM.title,
      duration_minutes: ROSTER_CLOSED_EXAM.duration,
      is_active: false,
      pin_mode: 'INDIVIDUAL',
    },
    {
      user_id: teacherId,
      code: ROSTER_NOT_STARTED_EXAM.code,
      title: ROSTER_NOT_STARTED_EXAM.title,
      duration_minutes: ROSTER_NOT_STARTED_EXAM.duration,
      is_active: true,
      pin_mode: 'INDIVIDUAL',
      starts_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      user_id: teacherId,
      code: ROSTER_ENDED_EXAM.code,
      title: ROSTER_ENDED_EXAM.title,
      duration_minutes: ROSTER_ENDED_EXAM.duration,
      is_active: true,
      pin_mode: 'INDIVIDUAL',
      ends_at: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ]);
  check('27a: roster exams created', !rosterExamsInsert.error, rosterExamsInsert.error?.message);

  // Trash the trash fixture: EXAMS is only soft-deleted, so `deleted_at` is what
  // get_exam_roster must treat as invisible.
  await teacher.from('exams')
    .update({ deleted_at: new Date().toISOString() })
    .eq('code', ROSTER_TRASH_EXAM.code);

  await teacher.from('students').insert(
    ROSTER_MEMBERS.map((member) => ({
      exam_code: ROSTER_EXAM.code,
      student_code: member.code,
      full_name: member.fullName,
      class_name: member.className,
      dob: member.dob,
      pin: member.pin,
    })),
  );

  // Anon client — the roster RPC is the student-facing entry point.
  const rosterAnon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const callRoster = (code) => rosterAnon.rpc('get_exam_roster', { p_exam_code: code });

  // --- 27b. happy path + shape ------------------------------------------
  const rosterOk = await callRoster(ROSTER_EXAM.code);
  check('27b: get_exam_roster succeeds for an open exam',
    rosterOk.data?.success === true, JSON.stringify(rosterOk.data));
  check('27b: it echoes the exam code',
    rosterOk.data?.exam_code === ROSTER_EXAM.code, String(rosterOk.data?.exam_code));
  check('27b: it echoes the exam title',
    rosterOk.data?.title === ROSTER_EXAM.title, String(rosterOk.data?.title));
  // The SPA decides whether to render the PIN field from this value.
  check('27b: it reports pin_mode so the SPA can show the PIN field',
    rosterOk.data?.pin_mode === 'GLOBAL', String(rosterOk.data?.pin_mode));

  const rosterCandidates = Array.isArray(rosterOk.data?.candidates) ? rosterOk.data.candidates : [];
  check('27b: all three candidates are returned', rosterCandidates.length === 3,
    String(rosterCandidates.length));
  check('27b: each candidate carries exactly student_code/full_name/class_name',
    rosterCandidates.every((c) => {
      const keys = Object.keys(c).sort();
      return keys.length === 3
        && keys[0] === 'class_name' && keys[1] === 'full_name' && keys[2] === 'student_code';
    }),
    JSON.stringify(rosterCandidates.map((c) => Object.keys(c).sort())));
  check('27b: ordered by class_name then student_code',
    rosterCandidates[0]?.student_code === 'E2EROS01' && rosterCandidates[1]?.student_code === 'E2EROS02'
      && rosterCandidates[2]?.student_code === 'E2EROS03',
    JSON.stringify(rosterCandidates.map((c) => c.student_code)));

  // --- 27c. THE credential-leak assertions ------------------------------
  // Asserting on the serialised payload (not field-by-field) is deliberate: it
  // catches the key appearing anywhere, including nested, if the projection is
  // ever widened to `s.*`.
  const rosterJson = JSON.stringify(rosterOk.data);
  check('27c: the payload NEVER contains a "pin" key',
    !Object.prototype.hasOwnProperty.call(rosterCandidates[0] ?? {}, 'pin')
      && !rosterJson.includes('"pin"'),
    rosterJson.slice(0, 200));
  check('27c: the payload NEVER contains a "dob" key',
    !Object.prototype.hasOwnProperty.call(rosterCandidates[0] ?? {}, 'dob')
      && !rosterJson.includes('"dob"'),
    rosterJson.slice(0, 200));
  // Belt-and-braces: the actual SECRET VALUES must not appear either, so a
  // future re-shaping (e.g. `student_pin`) cannot slip through a key-name check.
  check('27c: the custom PIN value never appears in the payload',
    !rosterJson.includes('SECRET1'), rosterJson.slice(0, 200));
  check('27c: a DOB value never appears in the payload',
    !rosterJson.includes('2008-09-05') && !rosterJson.includes('2009-01-02'),
    rosterJson.slice(0, 200));

  // --- 27d. rejection matrix --------------------------------------------
  const trashRes = await callRoster(ROSTER_TRASH_EXAM.code);
  check('27d: a trashed exam reports EXAM_NOT_FOUND (Trash stays invisible)',
    trashRes.data?.success === false && trashRes.data?.code === 'EXAM_NOT_FOUND',
    JSON.stringify(trashRes.data));

  const closedRes = await callRoster(ROSTER_CLOSED_EXAM.code);
  check('27d: an inactive exam reports EXAM_INACTIVE',
    closedRes.data?.success === false && closedRes.data?.code === 'EXAM_INACTIVE',
    JSON.stringify(closedRes.data));

  const notStartedRes = await callRoster(ROSTER_NOT_STARTED_EXAM.code);
  check('27d: an exam before starts_at reports EXAM_NOT_STARTED',
    notStartedRes.data?.success === false && notStartedRes.data?.code === 'EXAM_NOT_STARTED',
    JSON.stringify(notStartedRes.data));

  const endedRes = await callRoster(ROSTER_ENDED_EXAM.code);
  check('27d: an exam past ends_at reports EXAM_EXPIRED',
    endedRes.data?.success === false && endedRes.data?.code === 'EXAM_EXPIRED',
    JSON.stringify(endedRes.data));

  const missingRes = await callRoster('ZZZ999');
  check('27d: an unknown code reports EXAM_NOT_FOUND',
    missingRes.data?.success === false && missingRes.data?.code === 'EXAM_NOT_FOUND',
    JSON.stringify(missingRes.data));

  const blankRes = await callRoster('   ');
  check('27d: a blank code is refused, not scanned',
    blankRes.data?.success === false && blankRes.data?.code === 'EXAM_NOT_FOUND',
    JSON.stringify(blankRes.data));

  // Lowercase + surrounding whitespace must resolve, because the SPA uppercases
  // only after trimming and a paste can easily carry either.
  const looseRes = await callRoster(`  ${ROSTER_EXAM.code.toLowerCase()}  `);
  check('27d: a lowercase/whitespace-padded code still resolves',
    looseRes.data?.success === true, JSON.stringify(looseRes.data));

  // An empty roster is a SUCCESS with an empty array — not an error. The SPA
  // relies on this to fall back to manual entry rather than showing a refusal.
  const rosterEmptyExam = await teacher.from('exams').insert({
    user_id: teacherId,
    code: 'ROZ' + String(Math.floor(100 + Math.random() * 900)),
    title: 'E2E Roster Empty',
    duration_minutes: 30,
    is_active: true,
    pin_mode: 'INDIVIDUAL',
  }).select('code').single();
  const rosterEmptyRes = await callRoster(rosterEmptyExam.data?.code);
  check('27d: an empty roster is success:true with candidates:[]',
    rosterEmptyRes.data?.success === true && Array.isArray(rosterEmptyRes.data?.candidates)
      && rosterEmptyRes.data.candidates.length === 0,
    JSON.stringify(rosterEmptyRes.data));

  // --- 27e. the SPA's PIN flow against the roster it just rendered ------
  // End-to-end: pick a candidate exactly as the picker would (code + class from
  // the RPC payload), then submit that identity + PIN.
  const rosterAdmin = createClient(SB_URL, SB_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tryRosterLogin = async (candidate, pin) => {
    await rosterAdmin.from('active_sessions').delete()
      .eq('exam_code', ROSTER_EXAM.code).eq('student_code', candidate.student_code);
    return rosterAnon.rpc('verify_and_acquire_session', {
      p_exam_code: ROSTER_EXAM.code,
      p_student_code: candidate.student_code,
      p_full_name: candidate.full_name,
      p_class_name: candidate.class_name,
      p_device_info: 'e2e-roster/1.0',
      p_existing_token: null,
      p_pin: pin,
    });
  };

  const rosterPicked = rosterCandidates.find((c) => c.student_code === 'E2EROS01');
  const rosterWrongPin = await tryRosterLogin(rosterPicked, 'WRONG');
  check('27e: the PIN typed by the student is enforced (wrong value refused)',
    rosterWrongPin.data?.success === false && rosterWrongPin.data?.code === 'INVALID_PIN',
    JSON.stringify(rosterWrongPin.data));

  const omittedPin = await tryRosterLogin(rosterPicked, null);
  check('27e: an omitted PIN is refused for a GLOBAL exam (fail-closed)',
    omittedPin.data?.success === false && omittedPin.data?.code === 'INVALID_PIN',
    JSON.stringify(omittedPin.data));

  const rosterRightPin = await tryRosterLogin(rosterPicked, ROSTER_EXAM.globalPin);
  check('27e: the identity picked from the roster + correct PIN is admitted',
    rosterRightPin.data?.success === true, JSON.stringify(rosterRightPin.data));

  // --- 27f. the reload path must resend the PIN -------------------------
  // The Phase 6.1 PIN gate runs BEFORE the session lock, so a resume without the
  // PIN fails as INVALID_PIN — and the NEXT attempt would then hit the live
  // session row. Reproducing it here pins the reason the SPA persists the PIN.
  const resumeWithoutPin = await rosterAnon.rpc('verify_and_acquire_session', {
    p_exam_code: ROSTER_EXAM.code,
    p_student_code: rosterPicked.student_code,
    p_full_name: rosterPicked.full_name,
    p_class_name: rosterPicked.class_name,
    p_device_info: 'e2e-roster/1.0',
    p_existing_token: rosterRightPin.data?.session_token,
    p_pin: null,
  });
  check('27f: a PIN-less resume is refused (hence the SPA must resend it)',
    resumeWithoutPin.data?.success === false
      && resumeWithoutPin.data?.code === 'INVALID_PIN',
    JSON.stringify(resumeWithoutPin.data));

  const resumeWithPin = await rosterAnon.rpc('verify_and_acquire_session', {
    p_exam_code: ROSTER_EXAM.code,
    p_student_code: rosterPicked.student_code,
    p_full_name: rosterPicked.full_name,
    p_class_name: rosterPicked.class_name,
    p_device_info: 'e2e-roster/1.0',
    p_existing_token: rosterRightPin.data?.session_token,
    p_pin: ROSTER_EXAM.globalPin,
  });
  check('27f: resending the stored PIN resumes the same session',
    resumeWithPin.data?.success === true
      && resumeWithPin.data?.message === 'SESSION_RESUMED'
      && resumeWithPin.data?.session_token === rosterRightPin.data?.session_token,
    JSON.stringify(resumeWithPin.data));

  /* --- 28. Tree of Knowledge: schema, similarity & realtime (7.1) ------- */
  step(28, 'tree of knowledge schema, similarity RPC, and realtime');

  // --- 28a. fixtures: a 5-member class + an active session --------------
  const treeClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: TREE_CLASS, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('28a: tree class created', !treeClass.error && !!treeClass.data,
    treeClass.error?.message);
  const treeClassId = treeClass.data?.id;

  const treeMembers = await saveClassMembers(
    teacher,
    treeClassId,
    TREE_MEMBERS.map((m) => ({ student_code: m.code, full_name: m.name, dob: null, pin: null, team_number: m.team })),
  );
  check('28a: the class has 5 members', treeMembers.saved === 5, String(treeMembers.saved));

  const treeSession = await teacher
    .from('tree_sessions')
    .insert({
      user_id: teacherId,
      class_id: treeClassId,
      title: TREE_SESSION.title,
      question_text: TREE_SESSION.question,
      min_words: TREE_SESSION.minWords,
      time_limit_minutes: TREE_SESSION.timeLimitMinutes,
      max_similarity: TREE_SESSION.maxSimilarity,
      // Phase 9.1 — a session is created in LOBBY and only accepts answers once
      // started. These fixtures exercise the Phase 7 semantics, so they open the
      // bout directly (the lobby gate itself is Step 44's subject).
      status: 'ACTIVE',
      is_active: true,
    })
    .select('id, min_words, max_similarity, tree_seed, is_active')
    .single();
  check('28a: tree session created', !treeSession.error && !!treeSession.data,
    treeSession.error?.message);
  const treeSessionId = treeSession.data?.id;
  check('28a: min_words / max_similarity stored as configured',
    Number(treeSession.data?.min_words) === TREE_SESSION.minWords
      && Number(treeSession.data?.max_similarity) === TREE_SESSION.maxSimilarity,
    JSON.stringify(treeSession.data));
  // tree_seed must be auto-generated so every client renders the same tree.
  check('28a: tree_seed defaulted to a non-null integer',
    Number.isInteger(treeSession.data?.tree_seed), String(treeSession.data?.tree_seed));

  // The CHECK must reject a nonsensical similarity ceiling: 0 would reject every
  // answer, since a text is always 100% similar to itself.
  const badCeiling = await teacher.from('tree_sessions').insert({
    user_id: teacherId,
    class_id: treeClassId,
    title: 'Bad ceiling',
    question_text: 'x',
    max_similarity: 0,
  }).select('id').single();
  check('28a: max_similarity = 0 is rejected by the CHECK constraint',
    !!badCeiling.error, JSON.stringify(badCeiling.data));

  // Anonymous client — submit_tree_answer is the student-facing write path.
  const treeAnon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const submitTree = (member, answer) => treeAnon.rpc('submit_tree_answer', {
    p_session_id: treeSessionId,
    p_student_code: member.code,
    p_student_name: member.name,
    p_answer_text: answer,
  });

  // --- 28b. minimum word count -------------------------------------------
  const shortRes = await submitTree(TREE_MEMBERS[0], TREE_SHORT_ANSWER);
  check('28b: a short answer is rejected with MIN_WORDS_NOT_MET',
    shortRes.data?.success === false && shortRes.data?.code === 'MIN_WORDS_NOT_MET',
    JSON.stringify(shortRes.data));
  check('28b: the rejection reports both counts so the UI can guide the student',
    shortRes.data?.current_words === 4 && shortRes.data?.required_words === TREE_SESSION.minWords,
    JSON.stringify(shortRes.data));

  // Whitespace must not be gameable: a "10 word" answer that is really 2 words
  // plus padding has to be counted as 2. (Postgres regexp replaces runs.)
  const paddedRes = await submitTree(TREE_MEMBERS[0], '   tri   thuc   ');
  check('28b: whitespace padding does not inflate the word count',
    paddedRes.data?.success === false && paddedRes.data?.current_words === 2,
    JSON.stringify(paddedRes.data));

  // --- 28c. first accepted answer gets fruit_index = 1 -------------------
  const firstRes = await submitTree(TREE_MEMBERS[0], TREE_ANSWER_ORIGINAL);
  check('28c: a valid original answer is accepted', firstRes.data?.success === true,
    JSON.stringify(firstRes.data));
  check('28c: the first fruit is index 1', firstRes.data?.fruit_index === 1,
    String(firstRes.data?.fruit_index));
  check('28c: the reported word_count matches the answer',
    firstRes.data?.word_count === 15, String(firstRes.data?.word_count));

  // --- 28d. similarity gate ----------------------------------------------
  // A different student submitting (nearly) the same text must be refused.
  const duplicateRes = await submitTree(TREE_MEMBERS[1], TREE_ANSWER_ORIGINAL);
  check('28d: an identical answer is rejected with SIMILARITY_EXCEEDED',
    duplicateRes.data?.success === false && duplicateRes.data?.code === 'SIMILARITY_EXCEEDED',
    JSON.stringify(duplicateRes.data));
  check('28d: the rejection reports the similarity as a percentage',
    duplicateRes.data?.similarity_percent === 100.0,
    String(duplicateRes.data?.similarity_percent));

  const nearDupRes = await submitTree(TREE_MEMBERS[1], TREE_ANSWER_NEAR_DUPLICATE);
  check('28d: a one-word-edit paraphrase is also rejected (0.946 > 0.50)',
    nearDupRes.data?.success === false && nearDupRes.data?.code === 'SIMILARITY_EXCEEDED',
    JSON.stringify(nearDupRes.data));

  // The rejected attempts must NOT have created fruits.
  const afterRejects = await treeAnon
    .from('tree_submissions')
    .select('student_code, fruit_index')
    .eq('session_id', treeSessionId);
  check('28d: rejected submissions did not grow the tree (still 1 fruit)',
    afterRejects.data?.length === 1, String(afterRejects.data?.length));

  // --- 28e. original answer below the threshold is accepted --------------
  const secondRes = await submitTree(TREE_MEMBERS[1], TREE_ANSWER_DIFFERENT);
  check('28e: a genuinely different answer is accepted', secondRes.data?.success === true,
    JSON.stringify(secondRes.data));
  check('28e: it becomes the second fruit', secondRes.data?.fruit_index === 2,
    String(secondRes.data?.fruit_index));

  // --- 28f. resubmission updates in place, no duplicate fruit ------------
  // The same student edits their answer. `student_code <>` in the similarity
  // check means their OWN text is not a self-match, so an edit is always allowed
  // — but the new text still has to clear the ceiling against OTHER answers,
  // which TREE_ANSWER_EDITED does (measured 0.222 vs member[1]'s answer).
  const editRes = await submitTree(TREE_MEMBERS[0], TREE_ANSWER_EDITED);
  check('28f: a student can edit their own answer', editRes.data?.success === true,
    JSON.stringify(editRes.data));
  check('28f: the edit reuses the same submission row', editRes.data?.submission_id
    === firstRes.data?.submission_id, `${editRes.data?.submission_id} vs ${firstRes.data?.submission_id}`);
  // fruit_index is intentionally preserved so the tree does not reshuffle.
  check('28f: the edit keeps the original fruit_index (no new fruit)',
    editRes.data?.fruit_index === 1, String(editRes.data?.fruit_index));

  const finalTree = await treeAnon
    .from('tree_submissions')
    .select('student_code, fruit_index, word_count')
    .eq('session_id', treeSessionId)
    .order('fruit_index');
  check('28f: the tree still holds exactly 2 fruits', finalTree.data?.length === 2,
    String(finalTree.data?.length));
  check('28f: fruit ordinals are 1 and 2 with no gap',
    finalTree.data?.[0]?.fruit_index === 1 && finalTree.data?.[1]?.fruit_index === 2,
    JSON.stringify(finalTree.data?.map((r) => r.fruit_index)));

  // --- 28g. anon can READ the tree through the RLS policy ----------------
  // This is the assertion that would have failed with the draft's inline EXISTS
  // policy: anon holds no privilege on tree_sessions, so the predicate would
  // have raised `permission denied` rather than returning rows.
  check('28g: anon can read the session\'s submissions through RLS',
    finalTree.error === null && finalTree.data?.length === 2,
    finalTree.error?.message);
  check('28g: anon still cannot read tree_sessions directly',
    (await treeAnon.from('tree_sessions').select('id')).error !== null,
    'anon should have been denied');

  // --- 28h. closed / unknown sessions ------------------------------------
  await teacher.from('tree_sessions').update({ is_active: false }).eq('id', treeSessionId);
  const treeClosedRes = await submitTree(TREE_MEMBERS[2], TREE_ANSWER_DIFFERENT);
  check('28h: a closed session rejects with SESSION_INACTIVE',
    treeClosedRes.data?.success === false && treeClosedRes.data?.code === 'SESSION_INACTIVE',
    JSON.stringify(treeClosedRes.data));

  await teacher.from('tree_sessions').update({ is_active: true }).eq('id', treeSessionId);
  const missingSession = await treeAnon.rpc('submit_tree_answer', {
    p_session_id: '00000000-0000-0000-0000-000000000000',
    p_student_code: TREE_MEMBERS[2].code,
    p_student_name: TREE_MEMBERS[2].name,
    p_answer_text: TREE_ANSWER_DIFFERENT,
  });
  check('28h: an unknown session reports SESSION_NOT_FOUND',
    missingSession.data?.success === false && missingSession.data?.code === 'SESSION_NOT_FOUND',
    JSON.stringify(missingSession.data));

  const blankIdentity = await treeAnon.rpc('submit_tree_answer', {
    p_session_id: treeSessionId,
    p_student_code: '   ',
    p_student_name: '',
    p_answer_text: TREE_ANSWER_DIFFERENT,
  });
  check('28h: a blank identity is rejected with IDENTITY_REQUIRED',
    blankIdentity.data?.success === false && blankIdentity.data?.code === 'IDENTITY_REQUIRED',
    JSON.stringify(blankIdentity.data));

  // A freshly created session with a 0-minute limit is already past its window.
  const expiredSession = await teacher.from('tree_sessions').insert({
    user_id: teacherId,
    class_id: treeClassId,
    title: 'Expired',
    question_text: 'x',
    min_words: 1,
    time_limit_minutes: 1,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    // Phase 9.1 — opened directly; the expiry gate (not the lobby one) is what
    // this fixture must trip.
    status: 'ACTIVE',
    is_active: true,
  }).select('id').single();
  const expiredRes = await treeAnon.rpc('submit_tree_answer', {
    p_session_id: expiredSession.data?.id,
    p_student_code: TREE_MEMBERS[2].code,
    p_student_name: TREE_MEMBERS[2].name,
    p_answer_text: TREE_ANSWER_DIFFERENT,
  });
  check('28h: a session past its time limit reports SESSION_EXPIRED',
    expiredRes.data?.success === false && expiredRes.data?.code === 'SESSION_EXPIRED',
    JSON.stringify(expiredRes.data));

  // --- 28i. schema-level guarantees --------------------------------------
  // ON DELETE RESTRICT on class_id: a class in use must not be silently dropped.
  const restrictRes = await teacher.from('classes').delete().eq('id', treeClassId);
  check('28i: deleting a class that still has tree sessions is RESTRICTed',
    !!restrictRes.error, JSON.stringify(restrictRes.data));

  // The UNIQUE(session_id, student_code) is what turns a resubmission into an
  // update rather than a second fruit. Probed over a direct SQL connection:
  // PostgREST cannot reach pg_catalog, and `authenticated` deliberately has no
  // INSERT policy on tree_submissions (writes are RPC-only), so the insert would
  // be rejected by RLS (42501) before the constraint was ever consulted.
  const treeSql = (statement) => execFileSync(
    'docker',
    ['exec', SB_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
    { encoding: 'utf8' },
  ).trim();

  let uniqueViolation = '';
  try {
    treeSql(
      `insert into public.tree_submissions
         (session_id, student_code, student_name, answer_text, word_count, fruit_index)
       values ('${treeSessionId}', '${TREE_MEMBERS[0].code}', 'dup probe', 'x', 1, 99)`,
    );
  } catch (err) {
    uniqueViolation = String(err.stderr || err.message || '');
  }
  check('28i: UNIQUE(session_id, student_code) blocks a duplicate fruit row',
    uniqueViolation.includes('23505') || uniqueViolation.includes('duplicate key'),
    uniqueViolation.slice(-200));

  // The class FK must also be RESTRICT, not CASCADE: a class in use cannot be
  // deleted, so activity data cannot be destroyed as a side effect.
  const fkDeleteRule = treeSql(
    `select confdeltype from pg_constraint
      where conrelid = 'public.tree_sessions'::regclass and contype = 'f'
        and confrelid = 'public.classes'::regclass`,
  );
  // 'r' = RESTRICT, 'c' = CASCADE.
  check('28i: tree_sessions.class_id is ON DELETE RESTRICT', fkDeleteRule === 'r', fkDeleteRule);

  // --- 28j. realtime publication membership ------------------------------
  // pg_publication_tables is a catalog view, so it is probed over SQL rather
  // than PostgREST (which only exposes the `public` schema).
  const inPublication = treeSql(
    `select count(*) from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'tree_submissions'`,
  );
  check('28j: tree_submissions is in the supabase_realtime publication',
    inPublication === '1', inPublication);

  // Realtime filters on session_id (a non-key column) and resubmissions arrive
  // as UPDATEs, so replica identity must be FULL or those events are dropped.
  const replicaIdentity = treeSql(
    `select relreplident from pg_class where oid = 'public.tree_submissions'::regclass`,
  );
  check('28j: tree_submissions uses replica identity FULL', replicaIdentity === 'f', replicaIdentity);

  // --- 28k. cleanup the restricted class --------------------------------
  // Sessions must go first (ON DELETE RESTRICT), then the class.
  await teacher.from('tree_sessions').delete().eq('class_id', treeClassId);
  const treeClassDelete = await teacher.from('classes').delete().eq('id', treeClassId);
  check('28k: the class deletes once its tree sessions are gone',
    !treeClassDelete.error, treeClassDelete.error?.message);

  /* --- 29. Tree of Knowledge procedural renderer (7.2) ------------------ */
  // Pure engine checks: no DB, no DOM. `computeTreeState` must be a function of
  // (seed, data) alone — same inputs -> byte-identical geometry, and the whole
  // state must be free of clock/`Math.random` leakage.
  step(29, 'tree of knowledge procedural renderer');

  const TREE_EPOCH = Date.parse('2026-10-05T08:00:00Z');
  const treeIso = (ms) => new Date(ms).toISOString();
  /** Builds `count` submissions whose answers all land at `minutesEach`. */
  const treeSubs = (count, minutesEach) => Array.from({ length: count }, (_, i) => ({
    id: `sub-${i + 1}`,
    student_code: `HS${String(i + 1).padStart(2, '0')}`,
    student_name: `Học sinh ${i + 1}`,
    word_count: 15 + (i % 5) * 3,
    fruit_index: i + 1,
    submitted_at: treeIso(TREE_EPOCH + minutesEach * 60_000),
  }));
  const treeBase = {
    totalStudents: 10,
    timeLimitMinutes: 45,
    createdAt: treeIso(TREE_EPOCH),
  };
  /** Smallest edge-to-edge clearance between any two laid-out fruits. */
  const minPairGap = (layout) => {
    let gap = Infinity;
    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const dx = layout[j].x - layout[i].x;
        const dy = layout[j].y - layout[i].y;
        const d = Math.sqrt(dx * dx + dy * dy) - (layout[i].pixelRadius + layout[j].pixelRadius);
        if (d < gap) gap = d;
      }
    }
    return gap;
  };

  // --- 29a. determinism --------------------------------------------------
  const treeStateA = computeTreeState({ ...treeBase, seed: 123456, submissions: treeSubs(6, 4) });
  const treeStateB = computeTreeState({ ...treeBase, seed: 123456, submissions: treeSubs(6, 4) });
  check('29a: identical seed + submissions yield a deeply equal state',
    JSON.stringify(treeStateA) === JSON.stringify(treeStateB));
  check('29a: identical inputs yield byte-identical fruit anchors [nx, ny, radius]',
    JSON.stringify(treeStateA.anchors.map((x) => [x.nx, x.ny, x.radius]))
      === JSON.stringify(treeStateB.anchors.map((x) => [x.nx, x.ny, x.radius])));
  check('29a: identical inputs yield the same palette',
    treeStateA.themeIndex === treeStateB.themeIndex
      && treeStateA.theme.name === treeStateB.theme.name,
    `${treeStateA.theme.name} vs ${treeStateB.theme.name}`);

  const treeStateC = computeTreeState({ ...treeBase, seed: 123457, submissions: treeSubs(6, 4) });
  check('29a: a different seed yields different anchor positions',
    JSON.stringify(treeStateA.anchors.map((x) => [x.nx, x.ny]))
      !== JSON.stringify(treeStateC.anchors.map((x) => [x.nx, x.ny])));

  // The array's incidental order must not affect geometry: anchors are sorted by
  // (fruit_index, student_code) before placement, so a reshuffled input is stable.
  const treeShuffled = treeSubs(6, 4).reverse();
  check('29a: anchor placement is independent of submission array order',
    JSON.stringify(computeTreeState({ ...treeBase, seed: 123456, submissions: treeShuffled }).anchors)
      === JSON.stringify(treeStateA.anchors));

  // The PRNG spec pins `seed 0` onto the 123456 fallback (a DB default of
  // `floor(random()*1000000)` can legitimately produce 0).
  check('29a: createPRNG(0) falls back to the 123456 stream',
    createPRNG(0)() === createPRNG(123456)());

  // --- 29b. growth boundaries --------------------------------------------
  const treeAt = (k, n, seed = 42) =>
    computeTreeState({ ...treeBase, totalStudents: n, seed, submissions: treeSubs(k, 4) });

  const treeSeedStage = treeAt(0, 10);
  check('29b: P = 0 yields the seed stage with zero branch recursion',
    treeSeedStage.participation === 0 && treeSeedStage.stage === 'seed'
      && treeSeedStage.maxDepth === 0,
    JSON.stringify({ p: treeSeedStage.participation, stage: treeSeedStage.stage, d: treeSeedStage.maxDepth }));

  const treeFullStage = treeAt(10, 10);
  check('29b: P = 1.0 yields the bloom stage at the maximum recursion depth',
    treeFullStage.participation === 1 && treeFullStage.stage === 'bloom'
      && treeFullStage.maxDepth === MAX_BRANCH_DEPTH,
    JSON.stringify({ p: treeFullStage.participation, stage: treeFullStage.stage, d: treeFullStage.maxDepth }));

  // Every interior boundary must land on the documented stage. Note the Phase
  // 8.2 ladder widens SAPLING's ceiling to 0.50, so MATURING is probed at 0.7.
  check('29b: interior participation boundaries map to sprout / sapling / maturing',
    treeAt(1, 10).stage === 'sprout' && treeAt(1, 10).maxDepth === 1
      && treeAt(3, 10).stage === 'sapling' && treeAt(3, 10).maxDepth === 3
      && treeAt(7, 10).stage === 'maturing' && treeAt(7, 10).maxDepth === 5,
    [treeAt(1, 10).stage, treeAt(3, 10).stage, treeAt(7, 10).stage].join(','));

  check('29b: stage ladder deepens monotonically toward MAX_BRANCH_DEPTH',
    STAGE_LADDER.every((s, i) => i === 0 || s.maxDepth >= STAGE_LADDER[i - 1].maxDepth)
      && STAGE_LADDER[STAGE_LADDER.length - 1].maxDepth === MAX_BRANCH_DEPTH,
    String(MAX_BRANCH_DEPTH));

  // N = 0 must not divide by zero; the denominator is floored at 1.
  const treeEmpty = computeTreeState({ ...treeBase, totalStudents: 0, seed: 1, submissions: [] });
  check('29b: totalStudents = 0 is floored to 1 (no division by zero)',
    treeEmpty.n === 1 && treeEmpty.participation === 0, JSON.stringify({ n: treeEmpty.n }));

  // --- 29c. hitbox integrity ---------------------------------------------
  // Every submission must produce exactly one anchor, inside the canvas bounding
  // box, non-overlapping (positive clearance) even for a dense roster or a big class.
  const treeHitboxCases = [
    [30, 30, 320, 480],
    [40, 45, 360, 640],
    [12, 12, 2000, 1200],
    [1, 1, 300, 300],
  ];
  let treeHitboxFailures = 0;
  let treeWorstGap = Infinity;
  for (const [k, n, w, h] of treeHitboxCases) {
    const state = computeTreeState({ ...treeBase, totalStudents: n, seed: 777, submissions: treeSubs(k, 3) });
    const layout = layoutFruitAnchors(state.anchors, w, h);
    const inBounds = layout.every((p) => p.x - p.pixelRadius >= -0.001 && p.x + p.pixelRadius <= w + 0.001
      && p.y - p.pixelRadius >= -0.001 && p.y + p.pixelRadius <= h + 0.001);
    const normalisedInBounds = state.anchors.every((p) => p.nx - p.radius >= 0 && p.nx + p.radius <= 1
      && p.ny - p.radius >= 0 && p.ny + p.radius <= 1);
    const gap = minPairGap(layout);
    if (gap < treeWorstGap) treeWorstGap = gap;
    if (layout.length !== k || !inBounds || !normalisedInBounds || !(gap > 0)) treeHitboxFailures += 1;
  }
  check('29c: every submission yields exactly one anchor',
    treeHitboxFailures === 0, `failures=${treeHitboxFailures}`);
  check('29c: anchors stay inside the canvas bounding box at any canvas size',
    treeHitboxFailures === 0, `failures=${treeHitboxFailures}`);
  check('29c: no two fruit anchors overlap (strictly positive clearance)',
    treeHitboxFailures === 0 && treeWorstGap > 0,
    `worst gap = ${treeWorstGap.toExponential(3)}px`);

  const treeAnchorsK = computeTreeState({ ...treeBase, seed: 55, submissions: treeSubs(5, 4) });
  check('29c: anchors carry one identity per submission, sans duplicates',
    treeAnchorsK.anchors.length === 5
      && new Set(treeAnchorsK.anchors.map((x) => x.student_code)).size === 5,
    String(treeAnchorsK.anchors.length));

  // --- 29d. vitality decay ------------------------------------------------
  // V = clamp(1 - (avgSubmissionTime / maxSeconds) * 0.6, 0.2, 1.0).
  const treeVitalityAt = (minutes) =>
    computeTreeState({ ...treeBase, seed: 9, submissions: treeSubs(8, minutes) }).vitality;

  check('29d: k = 0 defaults to full vitality (no evidence to judge)',
    computeTreeState({ ...treeBase, seed: 9, submissions: [] }).vitality === 1.0);
  check('29d: prompt submissions (avg 5m of 45m) keep V >= 0.8',
    treeVitalityAt(5) >= 0.8, treeVitalityAt(5).toFixed(4));
  check('29d: submissions at the 45m limit drop V <= 0.4',
    treeVitalityAt(45) <= 0.4, treeVitalityAt(45).toFixed(4));
  check('29d: vitality never falls below the 0.2 floor',
    treeVitalityAt(120) === 0.2, treeVitalityAt(120).toFixed(4));
  check('29d: vitality degrades monotonically as submissions arrive later',
    treeVitalityAt(5) > treeVitalityAt(15) && treeVitalityAt(15) > treeVitalityAt(30)
      && treeVitalityAt(30) > treeVitalityAt(45),
    [5, 15, 30, 45].map((m) => treeVitalityAt(m).toFixed(4)).join(' > '));

  // --- 29e. palettes / archetypes ----------------------------------------
  check('29e: the archetype is seed % 4 across all four themes and cycles',
    themeIndexForSeed(0) === 0 && themeIndexForSeed(1) === 1
      && themeIndexForSeed(2) === 2 && themeIndexForSeed(3) === 3
      && themeIndexForSeed(4) === 0 && themeIndexForSeed(7) === 3,
    [0, 1, 2, 3, 4, 7].map((s) => themeIndexForSeed(s)).join(','));
  check('29e: a negative seed still selects a valid archetype',
    themeIndexForSeed(-1) === 3 && themeForSeed(-1).index === 3, String(themeIndexForSeed(-1)));
  check('29e: the four archetypes carry distinct palettes',
    new Set([0, 1, 2, 3].map((i) => themeForSeed(i).fruit)).size === 4);

  // --- 29f. TreeRenderer against a stub canvas ----------------------------
  // A minimal Canvas 2D stand-in records the calls the renderer makes, so the
  // real `resize()` / `render()` / `getFruitAt()` paths are exercised headless.
  const treeGradient = () => ({ addColorStop() {} });
  const treeCalls = { arc: 0, fill: 0, stroke: 0, fillRect: 0 };
  const treeCtx = {
    setTransform() {}, clearRect() {}, fillRect() { treeCalls.fillRect += 1; },
    beginPath() {}, moveTo() {}, lineTo() {}, ellipse() {}, arc() { treeCalls.arc += 1; },
    fill() { treeCalls.fill += 1; }, stroke() { treeCalls.stroke += 1; },
    createLinearGradient: treeGradient, createRadialGradient: treeGradient,
  };
  const treeCanvasStub = {
    width: 0, height: 0, clientWidth: 600, clientHeight: 450,
    getContext: () => treeCtx,
  };
  const { TreeRenderer } = await import(new URL('../student/tree-engine.js', import.meta.url).href);
  const treeRenderer = new TreeRenderer(treeCanvasStub);

  const treeSized = treeRenderer.resize();
  check('29f: resize() fits the backing store to the CSS box',
    treeCanvasStub.width === 600 && treeCanvasStub.height === 450
      && treeSized.width === 600 && treeSized.height === 450,
    JSON.stringify(treeSized));

  treeRenderer.render(treeStateA);
  check('29f: render() caches one hitbox per fruit',
    treeRenderer.fruitAnchors.length === treeStateA.anchors.length
      && treeCalls.arc > 0 && treeCalls.fill > 0,
    `anchors=${treeRenderer.fruitAnchors.length} arc=${treeCalls.arc}`);
  check('29f: render() draws the tree (branches, foliage and fruits)',
    treeCalls.stroke > 0 && treeCalls.fillRect > 0,
    JSON.stringify(treeCalls));

  const treeTarget = treeRenderer.fruitAnchors[2];
  const treeHit = treeRenderer.getFruitAt(treeTarget.x, treeTarget.y);
  check('29f: getFruitAt() resolves the fruit under a point',
    !!treeHit && treeHit.student_code === treeStateA.anchors[2].student_code,
    treeHit?.student_code);
  check('29f: getFruitAt() returns null off-canvas',
    treeRenderer.getFruitAt(-50, -50) === null);
  check('29f: hitTestFruits agrees with the renderer cache',
    hitTestFruits(treeRenderer.fruitAnchors, treeTarget.x, treeTarget.y)?.student_code
      === treeHit?.student_code);

  // Seed stage draws the mound + seed only, so there are no fruits to tap.
  treeRenderer.render(treeSeedStage);
  check('29f: the seed stage exposes no fruit hitboxes',
    treeRenderer.fruitAnchors.length === 0, String(treeRenderer.fruitAnchors.length));

  // Animation must degrade gracefully where requestAnimationFrame is absent (Node).
  treeRenderer.startAnimation(treeStateA);
  treeRenderer.stopAnimation();
  check('29f: startAnimation/stopAnimation no-op safely without requestAnimationFrame',
    treeRenderer.animFrameId === null);

  /* --- 30. Tree of Knowledge teacher data layer (7.3) ------------------- */
  // The teacher-web persistence path, exercised through the SAME modules the
  // projector imports (not a copy). A dedicated class keeps this step
  // self-contained so it cannot be broken by an earlier step's cleanup order.
  step(30, 'tree of knowledge teacher data layer and engine contract');

  const TREE_WEB_CLASS = 'E2E-TREEWEB-' + String(Math.floor(1000 + Math.random() * 9000));
  const TREE_WEB_MEMBERS = [
    { code: 'E2EWEB01', name: 'Đinh Văn Một', team: 1 },
    { code: 'E2EWEB02', name: 'Bùi Thị Hai', team: 2 },
    { code: 'E2EWEB03', name: 'Dương Văn Ba', team: 3 },
  ];

  const webTreeClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: TREE_WEB_CLASS, academic_year: '2026-2027' })
    .select('id, name')
    .single();
  check('30a: projector test class created', !webTreeClass.error && !!webTreeClass.data,
    webTreeClass.error?.message);
  const webTreeClassId = webTreeClass.data?.id;

  const webTreeMembers = await saveClassMembers(
    teacher,
    webTreeClassId,
    TREE_WEB_MEMBERS.map((m) => ({ student_code: m.code, full_name: m.name, dob: null, pin: null, team_number: m.team })),
  );
  check('30a: the projector class has 3 members', webTreeMembers.saved === 3,
    String(webTreeMembers.saved));

  // --- 30b. createTreeSession --------------------------------------------
  const createdSession = await createTreeSession(teacher, {
    class_id: webTreeClassId,
    title: 'E2E Cây Tri Thức (projector)',
    question_text: 'Theo em, tri thức là gì và nó được hình thành như thế nào?',
    min_words: 15,
    time_limit_minutes: 45,
    max_similarity: 0.65,
  });
  check('30b: createTreeSession inserts a session', !!createdSession?.id, JSON.stringify(createdSession));
  check('30b: the configured thresholds round-trip',
    createdSession?.min_words === 15
      && createdSession?.time_limit_minutes === 45
      && Number(createdSession?.max_similarity) === 0.65,
    JSON.stringify({
      min_words: createdSession?.min_words,
      time_limit_minutes: createdSession?.time_limit_minutes,
      max_similarity: createdSession?.max_similarity,
    }));
  check('30b: a new session starts in the LOBBY and is not yet active',
    createdSession?.is_active === false
      && createdSession?.ended_at === null
      && createdSession?.status === 'LOBBY',
    JSON.stringify({
      is_active: createdSession?.is_active,
      ended_at: createdSession?.ended_at,
      status: createdSession?.status,
    }));
  // The seed MUST be minted server-side: two sessions created in the same
  // millisecond would collide on a client-generated seed and render identically.
  check('30b: tree_seed was minted server-side as a non-null integer',
    Number.isInteger(Number(createdSession?.tree_seed)) && createdSession?.tree_seed !== null,
    String(createdSession?.tree_seed));

  const webTreeSessionId = createdSession.id;

  // A rejection path: an invalid similarity ceiling is caught client-side with a
  // usable message rather than surfacing as an opaque CHECK-constraint error.
  let ceilingRejected = '';
  try {
    await createTreeSession(teacher, {
      class_id: webTreeClassId,
      title: 'Bad ceiling',
      question_text: 'x',
      min_words: 10,
      time_limit_minutes: 45,
      max_similarity: 0,
    });
  } catch (err) {
    ceilingRejected = String(err?.message ?? err);
  }
  check('30b: a max_similarity outside (0,1] is rejected with a teacher-readable message',
    ceilingRejected.includes('Ngưỡng trùng lặp'), ceilingRejected);

  // --- 30c. getTreeSession ------------------------------------------------
  const loadedSession = await getTreeSession(teacher, webTreeSessionId);
  check('30c: getTreeSession loads the session with its class name',
    loadedSession?.id === webTreeSessionId && loadedSession?.class_name === TREE_WEB_CLASS,
    JSON.stringify({ id: loadedSession?.id, class_name: loadedSession?.class_name }));
  // `N` is the participation denominator, so it must arrive with the session —
  // a projector that had to fetch it separately would paint an incomplete tree.
  check('30c: getTreeSession returns the class member count as total_students',
    loadedSession?.total_students === 3, String(loadedSession?.total_students));
  // Phase 8.4 — the arena needs each team's roster size to draw four independent
  // participation denominators. The three members sit one per Tổ 1/2/3, so the
  // tally must mirror that split exactly.
  check('30c: getTreeSession returns a team_counts breakdown of {1,2,3,4}',
    loadedSession?.team_counts
      && loadedSession.team_counts[1] === 1
      && loadedSession.team_counts[2] === 1
      && loadedSession.team_counts[3] === 1
      && loadedSession.team_counts[4] === 0,
    JSON.stringify(loadedSession?.team_counts));
  check('30c: an unknown session id yields null rather than throwing',
    (await getTreeSession(teacher, '00000000-0000-0000-0000-000000000000')) === null);

  // --- 30d. submissions round-trip ---------------------------------------
  // Phase 9.1 — `createTreeSession` leaves the session in LOBBY, so the bout has
  // to be started before any answer is accepted (the lobby gate itself is Step
  // 44's subject; here it is just the necessary precondition).
  const webStarted = await startTreeSession(teacher, webTreeSessionId);
  check('30d: startTreeSession stamps started_at and ends_at',
    !!webStarted.startedAt && !!webStarted.endsAt,
    JSON.stringify(webStarted));

  // Two distinct answers (16 words each, over the 15-word minimum) so the
  // similarity ceiling (65%) accepts both.
  const webAnswers = [
    { member: TREE_WEB_MEMBERS[0], text: 'Tri thuc duoc hinh thanh tu qua trinh hoc tap va trai nghiem song moi ngay' },
    { member: TREE_WEB_MEMBERS[1], text: 'Moi nguoi tim thay tri thuc qua sach vo ban be va thuc te cong viec' },
  ];
  for (const answer of webAnswers) {
    const submitted = await teacher.rpc('submit_tree_answer', {
      p_session_id: webTreeSessionId,
      p_student_code: answer.member.code,
      p_student_name: answer.member.name,
      p_answer_text: answer.text,
    });
    check(`30d: ${answer.member.code} submitted successfully`,
      submitted.data?.success === true, JSON.stringify(submitted.data));
  }

  const webSubmissions = await getTreeSubmissions(teacher, webTreeSessionId);
  check('30d: getTreeSubmissions returns one row per submission, ordered by fruit_index',
    webSubmissions.length === 2
      && webSubmissions[0].fruit_index === 1
      && webSubmissions[1].fruit_index === 2,
    JSON.stringify(webSubmissions.map((row) => row.fruit_index)));
  check('30d: each submission carries the identity and word count the renderer needs',
    webSubmissions.every((row) => row.student_code && row.student_name && row.word_count > 0),
    JSON.stringify(webSubmissions.map((row) => [row.student_code, row.word_count])));
  // Phase 8.4 — `submit_tree_answer` resolves the author's team from the roster
  // (round-robin fallback) and records it, so the arena can route the row.
  check('30d: each submission carries a team_number in 1..4',
    webSubmissions.every((row) => Number.isInteger(row.team_number)
      && row.team_number >= 1 && row.team_number <= 4),
    JSON.stringify(webSubmissions.map((row) => row.team_number)));
  check('30d: getTreeSubmissions excludes another session\'s rows',
    (await getTreeSubmissions(teacher, '00000000-0000-0000-0000-000000000000')).length === 0);

  // --- 30e. data contract with the renderer ------------------------------
  // The fetched rows are fed STRAIGHT into the engine with no mapping step: if
  // the web `TreeSubmissionRow` shape ever drifted from what the renderer reads,
  // the anchors would come back empty or nameless and this fails.
  const contractState = computeTreeState({
    totalStudents: loadedSession.total_students,
    submissions: webSubmissions,
    timeLimitMinutes: loadedSession.time_limit_minutes,
    createdAt: loadedSession.created_at,
    seed: loadedSession.tree_seed,
  });
  check('30e: the engine accepts the web rows unchanged and anchors every one',
    contractState.anchors.length === webSubmissions.length
      && contractState.anchors.every((anchor) => anchor.student_code && anchor.radius > 0),
    JSON.stringify(contractState.anchors.map((a) => a.student_code)));
  check('30e: participation derives from the fetched class size',
    contractState.k === 2 && contractState.n === 3
      && Math.abs(contractState.participation - 2 / 3) < 1e-9,
    JSON.stringify({ k: contractState.k, n: contractState.n, p: contractState.participation }));
  check('30e: vitality is a value the projector can display',
    contractState.vitality >= 0.2 && contractState.vitality <= 1.0,
    contractState.vitality.toFixed(4));

  // The renderer reads a fixed set of fields; the selected column list must
  // cover every one of them, or a field would silently arrive `undefined` while
  // TypeScript still believed the row had the old shape.
  const sessionColumns = TREE_SESSION_COLUMNS.split(',').map((column) => column.trim());
  check('30e: TREE_SESSION_COLUMNS covers every field the renderer reads',
    ['id', 'class_id', 'title', 'question_text', 'min_words', 'time_limit_minutes',
     'max_similarity', 'tree_seed', 'is_active', 'created_at', 'ended_at']
      .every((column) => sessionColumns.includes(column)),
    TREE_SESSION_COLUMNS);
  const submissionColumns = TREE_SUBMISSION_COLUMNS.split(',').map((column) => column.trim());
  check('30e: TREE_SUBMISSION_COLUMNS covers every field the renderer reads',
    ['id', 'session_id', 'student_code', 'student_name', 'answer_text', 'word_count',
     'submitted_at', 'fruit_index', 'team_number']
      .every((column) => submissionColumns.includes(column)),
    TREE_SUBMISSION_COLUMNS);

  // Same deterministic state in the browser and in the suite, because both load
  // the SAME seed-driven engine. A different seed must move the anchors.
  const reState = computeTreeState({
    totalStudents: 3,
    submissions: webSubmissions,
    timeLimitMinutes: loadedSession.time_limit_minutes,
    createdAt: loadedSession.created_at,
    seed: loadedSession.tree_seed,
  });
  check('30e: the projector state is reproducible from the stored seed',
    JSON.stringify(reState.anchors) === JSON.stringify(contractState.anchors));
  check('30e: a different seed would render a different tree',
    JSON.stringify(computeTreeState({
      totalStudents: 3,
      submissions: webSubmissions,
      timeLimitMinutes: loadedSession.time_limit_minutes,
      createdAt: loadedSession.created_at,
      seed: loadedSession.tree_seed + 1,
    }).anchors) !== JSON.stringify(contractState.anchors));

  // --- 30f. the web engine copy must not drift from the student copy -----
  // The projector imports its own copy so Next.js can bundle it; the student
  // SPA imports the original. A divergence would make the classroom projector
  // and the students' phones disagree about the tree.
  const studentEngineSource = readFileSync(new URL('../student/tree-engine.js', import.meta.url), 'utf8');
  const webEngineSource = readFileSync(new URL('../web/src/lib/tree-engine.js', import.meta.url), 'utf8');
  check('30f: the web engine copy is byte-identical to the student engine',
    studentEngineSource === webEngineSource,
    `student=${studentEngineSource.length}B web=${webEngineSource.length}B`);

  // --- 30g. endTreeSession ------------------------------------------------
  const ended = await endTreeSession(teacher, webTreeSessionId);
  check('30g: endTreeSession marks the session inactive and stamps ended_at',
    ended.is_active === false && !!ended.ended_at,
    JSON.stringify({ is_active: ended.is_active, ended_at: ended.ended_at }));

  const reloaded = await getTreeSession(teacher, webTreeSessionId);
  check('30g: the closed state persists on reload', reloaded?.is_active === false);

  // A closed session must stop accepting answers — this is the whole point of
  // the button, and it is enforced server-side by submit_tree_answer.
  const afterClose = await teacher.rpc('submit_tree_answer', {
    p_session_id: webTreeSessionId,
    p_student_code: TREE_WEB_MEMBERS[2].code,
    p_student_name: TREE_WEB_MEMBERS[2].name,
    p_answer_text: 'Mot cau tra loi hoan toan khac biet va khong trung voi ai ca',
  });
  check('30g: a closed session rejects further submissions',
    afterClose.data?.success === false && afterClose.data?.code === 'SESSION_INACTIVE',
    JSON.stringify(afterClose.data));

  let missingEnd = '';
  try {
    await endTreeSession(teacher, '00000000-0000-0000-0000-000000000000');
  } catch (err) {
    missingEnd = String(err?.message ?? err);
  }
  check('30g: ending an unknown session reports a clear error',
    missingEnd.includes('Không tìm thấy'), missingEnd);

  // --- 30h. cleanup -------------------------------------------------------
  await teacher.from('tree_sessions').delete().eq('id', webTreeSessionId);
  const webTreeClassDelete = await teacher.from('classes').delete().eq('id', webTreeClassId);
  check('30h: the projector class deletes once its session is gone',
    !webTreeClassDelete.error, webTreeClassDelete.error?.message);

  /* --- 31. Tree of Knowledge student participation (7.4) ---------------- */
  // Self-contained fixtures: a class whose members carry BOTH a `pin` and a
  // `dob`, so the "never leaks a credential" assertion has something real to
  // leak. A dedicated class keeps Step 31 independent of Step 28/30 cleanup.
  step(31, 'tree of knowledge student participation and word counting');

  const TREE_JOIN_CLASS = 'E2E-TREEJOIN-' + String(Math.floor(1000 + Math.random() * 9000));
  const TREE_JOIN_MEMBERS = [
    { code: 'E2EJOIN01', name: 'Vũ Văn Nhất', dob: '2008-09-05', pin: '2468', team: 1 },
    { code: 'E2EJOIN02', name: 'Đỗ Thị Nhị', dob: '2008-01-17', pin: '1357', team: 2 },
    { code: 'E2EJOIN03', name: 'Hồ Văn Tam', dob: '2008-12-31', pin: '9081', team: 3 },
  ];

  const joinClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: TREE_JOIN_CLASS, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('31a: join test class created', !joinClass.error && !!joinClass.data,
    joinClass.error?.message);
  const joinClassId = joinClass.data?.id;

  const joinMembers = await saveClassMembers(
    teacher,
    joinClassId,
    TREE_JOIN_MEMBERS.map((m) => ({ student_code: m.code, full_name: m.name, dob: m.dob, pin: m.pin, team_number: m.team })),
  );
  check('31a: the class has 3 members with pin + dob stored', joinMembers.saved === 3,
    String(joinMembers.saved));

  // A long-window active session so nothing here is time-sensitive.
  const joinSession = await teacher
    .from('tree_sessions')
    .insert({
      user_id: teacherId,
      class_id: joinClassId,
      title: 'E2E Tham gia Cây Tri Thức',
      question_text: 'Theo em, điều gì làm nên sức mạnh của tri thức tập thể?',
      min_words: 8,
      time_limit_minutes: 45,
      max_similarity: 0.50,
      // Phase 9.1 — opened directly; Step 44 owns the lobby gate.
      status: 'ACTIVE',
      is_active: true,
    })
    .select('id, tree_seed, min_words, session_code')
    .single();
  check('31a: join session created', !joinSession.error && !!joinSession.data,
    joinSession.error?.message);
  const joinSessionId = joinSession.data?.id;
  const joinSessionCode = joinSession.data?.session_code;

  // --- 31b. get_public_tree_session contract -----------------------------
  // Phase 9.1 — the RPC now takes the session CODE (the uuid still resolves, so
  // legacy `?session=` links keep working) plus an optional student code.
  const publicTree = await treeAnon.rpc('get_public_tree_session', {
    p_session_code: joinSessionCode,
  });
  check('31b: anon can load the check-in payload',
    publicTree.data?.success === true, JSON.stringify(publicTree.data));

  const publicSession = publicTree.data?.session || {};
  check('31b: the payload carries the question and word minimum the SPA renders',
    publicSession.title === 'E2E Tham gia Cây Tri Thức'
      && publicSession.question_text === 'Theo em, điều gì làm nên sức mạnh của tri thức tập thể?'
      && Number(publicSession.min_words) === 8,
    JSON.stringify(publicSession));
  // The seed is REQUIRED: without it the student's canvas cannot reproduce the
  // presenter's tree. It is not a credential.
  check('31b: the payload carries the tree_seed the renderer needs',
    Number.isInteger(Number(publicSession.tree_seed))
      && Number(publicSession.tree_seed) === Number(joinSession.data?.tree_seed),
    `${publicSession.tree_seed} vs ${joinSession.data?.tree_seed}`);
  check('31b: the payload carries time_limit_minutes and created_at',
    Number(publicSession.time_limit_minutes) === 45 && !!publicSession.created_at,
    JSON.stringify({ t: publicSession.time_limit_minutes, c: publicSession.created_at }));
  check('31b: the payload carries the class name and size for participation',
    publicTree.data?.class_name === TREE_JOIN_CLASS && publicTree.data?.total_students === 3,
    JSON.stringify({ n: publicTree.data?.class_name, c: publicTree.data?.total_students }));

  const publicCandidates = publicTree.data?.candidates;
  check('31b: candidates list every member with student_code and full_name',
    Array.isArray(publicCandidates) && publicCandidates.length === 3
      && publicCandidates.every((c) => c.student_code && c.full_name),
    JSON.stringify(publicCandidates));
  check('31b: candidates are ordered by team then student_code',
    JSON.stringify(publicCandidates?.map((c) => c.student_code))
      === JSON.stringify(['E2EJOIN01', 'E2EJOIN02', 'E2EJOIN03']),
    JSON.stringify(publicCandidates?.map((c) => c.student_code)));
  // Phase 8.4 — every candidate also carries the team the four-tree arena needs
  // to route the submission, and NOTHING else (no pin/dob leak).
  check('31b: each candidate exposes EXACTLY student_code + full_name + team_number',
    publicCandidates?.every((c) => Object.keys(c).sort().join(',') === 'full_name,student_code,team_number'),
    JSON.stringify(publicCandidates?.[0] && Object.keys(publicCandidates[0])));
  check('31b: every candidate reports a team_number in 1..4',
    publicCandidates?.every((c) => Number.isInteger(c.team_number)
      && c.team_number >= 1 && c.team_number <= 4),
    JSON.stringify(publicCandidates?.map((c) => c.team_number)));

  // --- 31c. credential leak ----------------------------------------------
  // Asserted on the SERIALISED payload rather than on key names, so a future
  // re-keying (e.g. `student_pin`) cannot slip past a `hasOwnProperty('pin')`
  // check. The fixtures above DO carry a pin/dob, so a leak would be visible.
  const publicJson = JSON.stringify(publicTree.data);
  check('31c: the payload never contains the literal key "pin"',
    !publicJson.includes('"pin"'), publicJson.slice(0, 200));
  check('31c: the payload never contains the literal key "dob"',
    !publicJson.includes('"dob"'), publicJson.slice(0, 200));
  // The values themselves must not appear either, even under a renamed key.
  check('31c: no stored PIN value appears anywhere in the payload',
    TREE_JOIN_MEMBERS.every((m) => !publicJson.includes(m.pin)), 'a PIN value leaked');
  check('31c: no stored DOB value appears anywhere in the payload',
    TREE_JOIN_MEMBERS.every((m) => !publicJson.includes(m.dob)), 'a DOB value leaked');

  // --- 31d. unknown / inactive / expired ---------------------------------
  const publicMissing = await treeAnon.rpc('get_public_tree_session', {
    p_session_code: '00000000-0000-0000-0000-000000000000',
  });
  check('31d: an unknown session reports SESSION_NOT_FOUND',
    publicMissing.data?.success === false && publicMissing.data?.code === 'SESSION_NOT_FOUND',
    JSON.stringify(publicMissing.data));

  await teacher.from('tree_sessions').update({ is_active: false, status: 'FINISHED' }).eq('id', joinSessionId);
  const publicClosed = await treeAnon.rpc('get_public_tree_session', {
    p_session_code: joinSessionId,
  });
  check('31d: a closed session reports SESSION_INACTIVE',
    publicClosed.data?.success === false && publicClosed.data?.code === 'SESSION_INACTIVE',
    JSON.stringify(publicClosed.data));
  await teacher.from('tree_sessions').update({ is_active: true, status: 'ACTIVE' }).eq('id', joinSessionId);

  // A session created an hour ago with a 1-minute limit is already past its
  // window — the SPA must refuse it rather than accept an answer the write path
  // would then reject.
  const joinExpired = await teacher.from('tree_sessions').insert({
    user_id: teacherId,
    class_id: joinClassId,
    title: 'Expired join',
    question_text: 'x',
    min_words: 1,
    time_limit_minutes: 1,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'ACTIVE',
    is_active: true,
  }).select('id').single();
  const publicExpired = await treeAnon.rpc('get_public_tree_session', {
    p_session_code: joinExpired.data?.id,
  });
  check('31d: a session past its time limit reports SESSION_EXPIRED',
    publicExpired.data?.success === false && publicExpired.data?.code === 'SESSION_EXPIRED',
    JSON.stringify(publicExpired.data));

  // --- 31e. word counting matches the RPC --------------------------------
  // The SPA decides when to ENABLE the submit button. If it counted differently
  // from the server, a student could be blocked (or allowed through and then
  // refused). These cases mirror submit_tree_answer's regexp_replace/string_to_array.
  const RPC_WORD_CASES = [
    ['Tri thuc la gi', 4],
    ['   tri   thuc   ', 2],
    ['mot\nhai\ttba', 3],
    ['   ', 0],
    ['', 0],
    [null, 0],
    ['  một  hai  ba  bốn  ', 4],
  ];
  let wordCaseFailures = 0;
  for (const [input, expected] of RPC_WORD_CASES) {
    if (countTreeWords(input) !== expected) wordCaseFailures += 1;
  }
  check('31e: the client word counter matches the RPC rule on every case',
    wordCaseFailures === 0, `failures=${wordCaseFailures}`);
  check('31e: whitespace is collapsed exactly like the server stores it',
    normalizeAnswerText('  một   hai\nba  ') === 'một hai ba',
    normalizeAnswerText('  một   hai\nba  '));
  check('31e: the counter label guides the student toward the threshold',
    treeWordCounterLabel(3, 8) === '3 / 8 từ (Cần thêm 5 từ)'
      && treeWordCounterLabel(8, 8).startsWith('8 / 8 từ'),
    treeWordCounterLabel(3, 8));

  // Cross-check the client against the ACTUAL server count: submit a known
  // answer and compare the RPC's reported word_count to the client's count.
  const joinAnon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const CROSS_CHECK_TEXT = 'Tri thuc tap the manh hon khi moi nguoi cung dong gop y kien';
  const clientCount = countTreeWords(CROSS_CHECK_TEXT);
  const crossCheck = await joinAnon.rpc('submit_tree_answer', {
    p_session_id: joinSessionId,
    p_student_code: TREE_JOIN_MEMBERS[0].code,
    p_student_name: TREE_JOIN_MEMBERS[0].name,
    p_answer_text: CROSS_CHECK_TEXT,
  });
  check('31e: the RPC agrees with the client word count',
    crossCheck.data?.success === true && crossCheck.data?.word_count === clientCount,
    `server=${crossCheck.data?.word_count} client=${clientCount}`);

  // --- 31f. end-to-end participation simulation --------------------------
  // Mirrors the SPA flow: load -> pick -> (similarity refusal) -> rewrite ->
  // fruit appears on the tree.
  const loadAgain = await treeAnon.rpc('get_public_tree_session', {
    p_session_code: joinSessionCode,
  });
  const picked = (loadAgain.data?.candidates || [])
    .find((c) => c.student_code === TREE_JOIN_MEMBERS[1].code);
  check('31f: the student can pick their own row from the loaded roster',
    !!picked && picked.full_name === TREE_JOIN_MEMBERS[1].name, JSON.stringify(picked));

  // A near-copy of member[0]'s accepted answer must be refused, and the payload
  // must report a percentage so the SPA can show it.
  const joinDuplicate = await joinAnon.rpc('submit_tree_answer', {
    p_session_id: joinSessionId,
    p_student_code: picked.student_code,
    p_student_name: picked.full_name,
    p_answer_text: `${CROSS_CHECK_TEXT} nhe`,
  });
  check('31f: a near-duplicate answer is refused with a similarity percentage',
    joinDuplicate.data?.success === false
      && joinDuplicate.data?.code === 'SIMILARITY_EXCEEDED'
      && typeof joinDuplicate.data?.similarity_percent === 'number',
    JSON.stringify(joinDuplicate.data));

  // The rewrite is genuinely different, so it clears the ceiling.
  const JOIN_REWRITE = 'Kien thuc cua lop lon len nho vao su chia se va phan bien lan nhau';
  const joinAccepted = await joinAnon.rpc('submit_tree_answer', {
    p_session_id: joinSessionId,
    p_student_code: picked.student_code,
    p_student_name: picked.full_name,
    p_answer_text: JOIN_REWRITE,
  });
  check('31f: a rewritten answer is accepted',
    joinAccepted.data?.success === true, JSON.stringify(joinAccepted.data));

  // The fruit must be visible to the student's own (anon) Realtime read path.
  const joinTree = await joinAnon
    .from('tree_submissions')
    .select('student_code, student_name, word_count, fruit_index')
    .eq('session_id', joinSessionId)
    .order('fruit_index');
  check('31f: the student sees both fruits on the live tree',
    joinTree.error === null && joinTree.data?.length === 2,
    joinTree.error?.message ?? String(joinTree.data?.length));
  check('31f: the accepted rewrite kept the second student\'s fruit ordinal',
    joinTree.data?.[1]?.student_code === picked.student_code
      && joinTree.data?.[1]?.fruit_index === 2,
    JSON.stringify(joinTree.data));

  // The engine must consume the fetched rows and anchor both fruits — the same
  // data contract the projector's canvas relies on.
  const joinState = computeTreeState({
    totalStudents: loadAgain.data?.total_students,
    submissions: joinTree.data,
    timeLimitMinutes: publicSession.time_limit_minutes,
    createdAt: publicSession.created_at,
    seed: publicSession.tree_seed,
  });
  check('31f: the engine anchors both fruits from the student fetch path',
    joinState.anchors.length === 2 && joinState.k === 2 && joinState.n === 3,
    JSON.stringify({ anchors: joinState.anchors.length, k: joinState.k, n: joinState.n }));

  // A resubmission must update in place (same fruit, no third fruit).
  const joinSecondEdit = await joinAnon.rpc('submit_tree_answer', {
    p_session_id: joinSessionId,
    p_student_code: picked.student_code,
    p_student_name: picked.full_name,
    p_answer_text: 'Tri thuc tap the duoc xay dung tu nhieu goc nhin khac nhau trong lop hoc',
  });
  check('31f: re-submitting updates the same fruit instead of adding one',
    joinSecondEdit.data?.success === true
      && joinSecondEdit.data?.submission_id === joinAccepted.data?.submission_id
      && joinSecondEdit.data?.fruit_index === 2,
    JSON.stringify(joinSecondEdit.data));

  // --- 31g. the SPA's session-link handling ------------------------------
  // Phase 9.1 — `loadTreeActivity` no longer requires a uuid: the projector QR
  // now carries the short `session_code`, and the RPC resolves EITHER form. The
  // guard therefore only has to reject an empty token; assert the short code the
  // QR ships is a well-formed join token, and that the SPA still normalises the
  // three URL parameter names to the same value.
  check('31g: the projector session_code is a short uppercase join token',
    typeof joinSessionCode === 'string' && /^[0-9A-F]{6}$/.test(joinSessionCode),
    String(joinSessionCode));
  const spaUrlSource = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('31g: the SPA accepts ?code=, ?session= and ?tree= links',
    spaUrlSource.includes("params.get('code')")
      && spaUrlSource.includes("params.get('session')")
      && spaUrlSource.includes("params.get('tree')"),
    'URL parameter resolution missing');
  check('31g: the SPA calls get_public_tree_session with the code + student code',
    spaUrlSource.includes('p_session_code') && spaUrlSource.includes('p_student_code'),
    'RPC argument names not updated for Phase 9.1');
  check('31g: the SPA rejects an empty join token before calling the RPC',
    spaUrlSource.includes("if (!ref)") && spaUrlSource.includes('Liên kết tham gia không hợp lệ'),
    'empty-token guard missing');

  // --- 31h. cleanup -------------------------------------------------------
  await teacher.from('tree_sessions').delete().eq('id', joinSessionId);
  await teacher.from('tree_sessions').delete().eq('id', joinExpired.data?.id);
  const joinClassDelete = await teacher.from('classes').delete().eq('id', joinClassId);
  check('31h: the join test class deletes once its sessions are gone',
    !joinClassDelete.error, joinClassDelete.error?.message);

  /* --- 32. Exam candidates + flexible identity (8.1) -------------------- */
  // Three concerns share one step because they only make sense together:
  //   32a  the three re-signatured RPCs are SINGLE, non-overloaded, anon-callable
  //        (and, per the Phase 8.5 hardening, the five teacher-only RPCs are NOT)
  //   32b  get_exam_roster(..., true) serves a practice-enabled CLOSED exam
  //   32c  get_practice_exam_payload authorises by (full_name, class_name)
  //   32d  the teacher-web candidate CRUD helpers round-trip
  //   32e  the shipped SPA has no visible student-code input anywhere
  step(32, 'exam candidates, practice roster on closed exams, flexible identity');

  const step32Sql = (statement) => execFileSync(
    'docker',
    ['exec', SB_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
    { encoding: 'utf8' },
  ).trim();

  // --- 32a. signature discipline -----------------------------------------
  // `create or replace` matches on the ARGUMENT SIGNATURE, so a re-signatured
  // function that is not DROPped first survives as a second overload and every
  // matching call then fails with "function is not unique". Assert exactly ONE
  // public signature per name, and that anon may execute each new one.
  const procCount = (name) => Number(step32Sql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace `
    + `where n.nspname = 'public' and p.proname = '${name}'`,
  ));
  check('32a: get_exam_roster has exactly one signature',
    procCount('get_exam_roster') === 1, String(procCount('get_exam_roster')));
  check('32a: get_practice_exam_payload has exactly one signature',
    procCount('get_practice_exam_payload') === 1, String(procCount('get_practice_exam_payload')));
  check('32a: verify_student_practice has exactly one signature',
    procCount('verify_student_practice') === 1, String(procCount('verify_student_practice')));
  check('32a: get_public_practice_classes has exactly one signature',
    procCount('get_public_practice_classes') === 1,
    String(procCount('get_public_practice_classes')));

  const anonCanExecute = (signature) => step32Sql(
    `select has_function_privilege('anon', 'public.${signature}'::regprocedure, 'execute')`,
  ) === 't';
  check('32a: anon may execute get_exam_roster(varchar, boolean)',
    anonCanExecute('get_exam_roster(varchar, boolean)'));
  check('32a: anon may execute get_practice_exam_payload(varchar, varchar, varchar, varchar)',
    anonCanExecute('get_practice_exam_payload(varchar, varchar, varchar, varchar)'));
  check('32a: anon may execute verify_student_practice(varchar, varchar, varchar)',
    anonCanExecute('verify_student_practice(varchar, varchar, varchar)'));
  check('32a: anon may execute get_public_practice_classes()',
    anonCanExecute('get_public_practice_classes()'));

  // Phase 8.5 hardening — the five PRE-EXISTING teacher-only RPCs carried a stale
  // `anon` EXECUTE grant from Supabase's database default privileges (an explicit
  // grant that survives `revoke ... from public`; see Phase 6.1's D-C). They were
  // only protected by their internal auth.uid() body checks. The ACL must now
  // match the documented "teacher-only" intent, while `authenticated` keeps it.
  const TEACHER_ONLY_RPCS = [
    'update_exam_questions_safe(varchar, jsonb)',
    'delete_exam(varchar)',
    'restore_exam(varchar)',
    'purge_expired_exams()',
    'recalculate_exam_scores(varchar)',
  ];
  const authCanExecute = (signature) => step32Sql(
    `select has_function_privilege('authenticated', 'public.${signature}'::regprocedure, 'execute')`,
  ) === 't';
  check('32a: NONE of the five teacher-only RPCs is anon-executable',
    TEACHER_ONLY_RPCS.every((signature) => !anonCanExecute(signature)),
    TEACHER_ONLY_RPCS.map((s) => `${s}=${anonCanExecute(s) ? 'LEAK' : 'ok'}`).join(', '));
  check('32a: all five teacher-only RPCs remain executable by authenticated',
    TEACHER_ONLY_RPCS.every((signature) => authCanExecute(signature)),
    TEACHER_ONLY_RPCS.map((s) => `${s}=${authCanExecute(s) ? 'ok' : 'REVOKED'}`).join(', '));

  // --- fixtures: a practice-enabled exam that is CLOSED ------------------
  const CAN_EXAM = {
    code: 'CAN' + String(Math.floor(100 + Math.random() * 900)),
    title: 'E2E Candidate Management',
    duration: 30,
  };
  const CAN_CLASS = '12CAN';
  // Mixed case on purpose: the flexible RPC must match case/whitespace
  // insensitively, so the assertions below send the name back in a DIFFERENT
  // case than it is stored.
  const CAN_MEMBERS = [
    { code: 'E2ECAN01', fullName: 'Nguyễn Văn Một', dob: '2008-09-05', pin: '1111' },
    { code: 'E2ECAN02', fullName: 'Trần Thị Hai', dob: null, pin: null },
  ];

  await teacher.from('exams').delete().eq('code', CAN_EXAM.code);
  const canExam = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: CAN_EXAM.code,
      title: CAN_EXAM.title,
      duration_minutes: CAN_EXAM.duration,
      allow_practice: false,
      is_active: true,
    })
    .select('id')
    .single();
  check('32b: candidate exam created with practice OFF', !canExam.error && !!canExam.data,
    canExam.error?.message);
  const canExamId = canExam.data?.id;

  const canQuestions = await teacher.from('question_bank').insert({
    user_id: teacherId,
    exam_id: canExamId,
    question_text: 'Câu hỏi ôn luyện số 1?',
    question_type: 'MULTIPLE_CHOICE',
    options: ['A', 'B', 'C', 'D'],
    correct_answer: 0,
    explanation: 'Đáp án A.',
    position: 1,
  });
  check('32b: candidate exam seeded with one question', !canQuestions.error,
    canQuestions.error?.message);

  const canRoster = await teacher.from('students').insert(
    CAN_MEMBERS.map((m) => ({
      exam_code: CAN_EXAM.code,
      student_code: m.code,
      full_name: m.fullName,
      class_name: CAN_CLASS,
      dob: m.dob,
      pin: m.pin,
    })),
  );
  check('32b: candidate exam seeded with a 2-person roster', !canRoster.error,
    canRoster.error?.message);

  // Phase 8.9 — `verify_student_practice` now resolves against `classes` +
  // `class_members`, not the exam whitelist above, so 32c needs a matching class
  // roster with practice ENABLED (this step is about the payload RPC, not the
  // class gate — Step 41 owns the disabled/unknown-class branches). CAN_CLASS is
  // a constant, so clear any leftover row first (see Step 2).
  await teacher.from('classes').delete().eq('name', CAN_CLASS);
  const canClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: CAN_CLASS, academic_year: '2026-2027', allow_practice: true })
    .select('id')
    .single();
  check('32b: practice class created for the CAN roster', !canClass.error,
    canClass.error?.message);
  const canClassId = canClass.data?.id;

  const canClassMembers = await teacher.from('class_members').insert(
    CAN_MEMBERS.map((m) => ({
      class_id: canClassId,
      student_code: m.code,
      full_name: m.fullName,
      dob: m.dob,
      pin: m.pin,
    })),
  );
  check('32b: practice class members created', !canClassMembers.error,
    canClassMembers.error?.message);

  const flexAnon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Practice is OFF: the practice-mode roster must refuse.
  const rosterPracticeOff = await flexAnon.rpc('get_exam_roster', {
    p_exam_code: CAN_EXAM.code, p_for_practice: true,
  });
  check('32b: a practice roster request is refused while allow_practice = false',
    rosterPracticeOff.data?.success === false
      && rosterPracticeOff.data?.code === 'PRACTICE_NOT_ALLOWED',
    JSON.stringify(rosterPracticeOff.data));

  // Now close the exam but open practice — the exact "self-study after the
  // official sitting" case this parameter exists for.
  await teacher.from('exams')
    .update({ allow_practice: true, is_active: false })
    .eq('code', CAN_EXAM.code);

  const rosterOfficialClosed = await flexAnon.rpc('get_exam_roster', {
    p_exam_code: CAN_EXAM.code,
  });
  check('32b: the official roster still refuses a closed exam',
    rosterOfficialClosed.data?.success === false
      && rosterOfficialClosed.data?.code === 'EXAM_INACTIVE',
    JSON.stringify(rosterOfficialClosed.data));

  const rosterPracticeOn = await flexAnon.rpc('get_exam_roster', {
    p_exam_code: CAN_EXAM.code, p_for_practice: true,
  });
  check('32b: the practice roster succeeds on a closed but practice-enabled exam',
    rosterPracticeOn.data?.success === true, JSON.stringify(rosterPracticeOn.data));
  check('32b: the practice roster reports allow_practice = true',
    rosterPracticeOn.data?.allow_practice === true,
    String(rosterPracticeOn.data?.allow_practice));
  check('32b: the practice roster returns both candidates',
    Array.isArray(rosterPracticeOn.data?.candidates)
      && rosterPracticeOn.data.candidates.length === 2,
    JSON.stringify(rosterPracticeOn.data?.candidates));
  // The roster is a display payload: credentials must never ride along, in
  // either mode.
  const practiceRosterJson = JSON.stringify(rosterPracticeOn.data);
  check('32b: the practice roster leaks neither pin nor dob',
    !practiceRosterJson.includes('"pin"') && !practiceRosterJson.includes('"dob"')
      && CAN_MEMBERS.every((m) => !practiceRosterJson.includes('1111')),
    practiceRosterJson.slice(0, 200));

  // A trashed exam stays invisible in practice mode too.
  await teacher.from('exams')
    .update({ deleted_at: new Date().toISOString() })
    .eq('code', CAN_EXAM.code);
  const rosterTrashedPractice = await flexAnon.rpc('get_exam_roster', {
    p_exam_code: CAN_EXAM.code, p_for_practice: true,
  });
  check('32b: a trashed exam is invisible even in practice mode',
    rosterTrashedPractice.data?.success === false
      && rosterTrashedPractice.data?.code === 'EXAM_NOT_FOUND',
    JSON.stringify(rosterTrashedPractice.data));
  await teacher.from('exams').update({ deleted_at: null }).eq('code', CAN_EXAM.code);

  // --- 32c. get_practice_exam_payload by (full_name, class_name) ---------
  // No `student_code` is sent at all — the SPA no longer has a field for it.
  const payloadByName = await flexAnon.rpc('get_practice_exam_payload', {
    p_exam_code: CAN_EXAM.code,
    p_class_name: CAN_CLASS.toLowerCase(),
    p_full_name: CAN_MEMBERS[0].fullName.toUpperCase(),
  });
  check('32c: practice payload authorises by (full_name, class_name) without a code',
    payloadByName.data?.success === true, JSON.stringify(payloadByName.data));
  check('32c: it echoes the roster full name as student_name',
    payloadByName.data?.student_name === CAN_MEMBERS[0].fullName,
    String(payloadByName.data?.student_name));
  check('32c: it still returns the answer key the practice flow needs',
    Array.isArray(payloadByName.data?.questions)
      && payloadByName.data.questions.length === 1
      && payloadByName.data.questions[0].correct_answer === 0,
    JSON.stringify(payloadByName.data?.questions));

  // A name that is not on the roster is refused, even with a valid class.
  const payloadStranger = await flexAnon.rpc('get_practice_exam_payload', {
    p_exam_code: CAN_EXAM.code,
    p_class_name: CAN_CLASS,
    p_full_name: 'Kẻ Mạo Danh',
  });
  check('32c: an off-roster (full_name, class_name) is refused',
    payloadStranger.data?.success === false
      && payloadStranger.data?.message === 'STUDENT_NOT_WHITELISTED',
    JSON.stringify(payloadStranger.data));

  // The legacy student_code path must keep working (the roster picker still
  // resolves a code from the candidates it fetched).
  const payloadByCode = await flexAnon.rpc('get_practice_exam_payload', {
    p_exam_code: CAN_EXAM.code,
    p_student_code: CAN_MEMBERS[1].code,
  });
  check('32c: authorising by student_code still succeeds',
    payloadByCode.data?.success === true, JSON.stringify(payloadByCode.data));

  // verify_student_practice (the personal-.docx path) resolves against the CLASS
  // roster (Phase 8.9), and returns the success/code/full_name contract.
  const verifyByName = await flexAnon.rpc('verify_student_practice', {
    p_class_name: CAN_CLASS,
    p_full_name: CAN_MEMBERS[0].fullName,
  });
  check('32c: verify_student_practice authorises by (class_name, full_name)',
    verifyByName.data?.success === true
      && verifyByName.data?.student_code === CAN_MEMBERS[0].code,
    JSON.stringify(verifyByName.data));

  const verifyMissing = await flexAnon.rpc('verify_student_practice', {
    p_class_name: CAN_CLASS,
    p_full_name: 'Không Có Thật',
  });
  check('32c: verify_student_practice refuses an unknown name',
    verifyMissing.data?.success === false
      && verifyMissing.data?.code === 'STUDENT_NOT_FOUND',
    JSON.stringify(verifyMissing.data));

  const verifyBlank = await flexAnon.rpc('verify_student_practice', {
    p_class_name: '   ', p_full_name: '',
  });
  check('32c: verify_student_practice demands both fields',
    verifyBlank.data?.success === false, JSON.stringify(verifyBlank.data));

  // --- 32d. teacher-web candidate CRUD -----------------------------------
  const listed = await listExamCandidates(teacher, CAN_EXAM.code);
  check('32d: listExamCandidates returns the seeded roster',
    Array.isArray(listed) && listed.length === 2, JSON.stringify(listed?.length));
  check('32d: it carries the credential columns the editor edits',
    listed.every((row) => 'dob' in row && 'pin' in row && 'created_at' in row),
    JSON.stringify(listed?.[0]));

  // Add without a code: the helper derives one from the class name.
  const added = await addExamCandidate(teacher, CAN_EXAM.code, {
    full_name: 'Lê Văn Ba', class_name: CAN_CLASS, dob: '2009-01-02', pin: null,
  });
  check('32d: addExamCandidate auto-generates a student_code',
    !!added?.id && typeof added.student_code === 'string' && added.student_code.length > 0,
    JSON.stringify(added));
  check('32d: the added candidate round-trips its fields',
    added.full_name === 'Lê Văn Ba' && added.class_name === CAN_CLASS
      && added.dob === '2009-01-02' && added.pin === null,
    JSON.stringify(added));

  // A duplicate code must surface a usable message, not a raw constraint error.
  let dupMessage = '';
  try {
    await addExamCandidate(teacher, CAN_EXAM.code, {
      full_name: 'Nguyễn Văn Một (copy)', class_name: CAN_CLASS,
      student_code: CAN_MEMBERS[0].code,
    });
  } catch (err) {
    dupMessage = String(err?.message ?? err);
  }
  check('32d: a duplicate student_code is reported as a friendly error',
    dupMessage.includes(CAN_MEMBERS[0].code) && dupMessage.includes('đã tồn tại'),
    dupMessage);

  // Update: rename, and explicitly CLEAR dob/pin with null.
  const updated = await updateExamCandidate(teacher, added.id, {
    full_name: 'Lê Văn Ba (sửa)', dob: null, pin: '4321',
  });
  check('32d: updateExamCandidate applies the rename',
    updated?.full_name === 'Lê Văn Ba (sửa)', JSON.stringify(updated));
  check('32d: an explicit null clears dob while pin is set',
    updated?.dob === null && updated?.pin === '4321', JSON.stringify(updated));

  let noChangeMessage = '';
  try {
    await updateExamCandidate(teacher, added.id, {});
  } catch (err) {
    noChangeMessage = String(err?.message ?? err);
  }
  check('32d: an empty update is refused with a clear message',
    noChangeMessage.includes('Không có thay đổi'), noChangeMessage);

  // Delete a candidate with NO result: allowed.
  await deleteExamCandidate(teacher, added.id);
  const afterDelete = await listExamCandidates(teacher, CAN_EXAM.code);
  check('32d: deleteExamCandidate removes the row',
    afterDelete.length === 2 && !afterDelete.some((r) => r.id === added.id),
    JSON.stringify(afterDelete.map((r) => r.id)));

  // Delete a candidate WITH a submitted result: refused. A service-role insert
  // is used because `authenticated` deliberately has no INSERT policy on
  // exam_results (writes only ever come from submit_exam_result).
  const canAdmin = createClient(SB_URL, SB_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await canAdmin.from('exam_results').delete()
    .eq('exam_code', CAN_EXAM.code).eq('student_code', CAN_MEMBERS[0].code);
  const resultInsert = await canAdmin.from('exam_results').insert({
    exam_code: CAN_EXAM.code,
    student_code: CAN_MEMBERS[0].code,
    student_name: CAN_MEMBERS[0].fullName,
    class_name: CAN_CLASS,
    score: 1,
    total_questions: 1,
  }).select('id').single();
  check('32d: an exam_results row exists for the delete guard',
    !resultInsert.error && !!resultInsert.data?.id,
    resultInsert.error?.message ?? JSON.stringify(resultInsert.data));

  const guardRow = listed.find((r) => r.student_code === CAN_MEMBERS[0].code);
  let guardMessage = '';
  try {
    await deleteExamCandidate(teacher, guardRow.id);
  } catch (err) {
    guardMessage = String(err?.message ?? err);
  }
  check('32d: a candidate who has submitted cannot be deleted',
    guardMessage.includes('đã nộp bài'), guardMessage);
  const guardStillThere = await listExamCandidates(teacher, CAN_EXAM.code);
  check('32d: the guarded candidate is still on the roster',
    guardStillThere.some((r) => r.student_code === CAN_MEMBERS[0].code),
    JSON.stringify(guardStillThere.map((r) => r.student_code)));

  // --- 32e. the SPA exposes no student-code input ------------------------
  // Read the SHIPPED markup, not a copy: a regression that re-adds the field
  // would otherwise slip past.
  const spaHtml = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const spaJs = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');

  check('32e: the SPA has no student-code input element',
    !spaHtml.includes('id="student-code-input"') && !spaHtml.includes('name="studentCode"'),
    'a visible student-code input returned');
  check('32e: the practice panel has no student-code input',
    !spaHtml.includes('id="practiceStudentCode"'), 'practiceStudentCode returned');
  check('32e: identity is Class + Full Name only',
    spaHtml.includes('id="class-name-input"') && spaHtml.includes('id="student-name-input"')
      && spaHtml.includes('id="practiceClassName"') && spaHtml.includes('id="practiceStudentName"'),
    'expected identity fields missing');
  check('32e: the code still exists as a HIDDEN field resolved from the roster',
    spaHtml.includes('id="student-code-hidden"'), 'hidden code field missing');

  // View isolation: the tree owns the viewport instead of nesting in the shell.
  check('32e: the SPA declares both top-level views',
    spaHtml.includes('id="view-exam"') && spaHtml.includes('id="view-tree"'),
    'view containers missing');
  check('32e: app.js ships the switchView router',
    spaJs.includes('function switchView('), 'switchView missing');
  // The static-host fix: the .docx upload must address the Worker absolutely.
  // Phase 9 moved the resolution into the shared `app-config.js` module, so this
  // asserts the SPA still resolves a base and still builds the absolute
  // practice path — not the shape of the (now imported) resolver.
  check('32e: the .docx upload resolves an absolute Worker base URL',
    spaJs.includes("from './app-config.js'") && spaJs.includes('workerBaseUrl(')
      && spaJs.includes('/api/v1/extract-practice'),
    'worker URL resolution missing');

  // --- cleanup ------------------------------------------------------------
  await canAdmin.from('exam_results').delete()
    .eq('exam_code', CAN_EXAM.code).eq('student_code', CAN_MEMBERS[0].code);
  await teacher.from('exams').delete().eq('code', CAN_EXAM.code);

  /* --- 33. Organic redesign + knowledge dewdrops + bloom (8.2) ---------- */
  // Pure engine checks again, but pinned to the Phase 8.2 contract: the new
  // sprout/sapling/maturing/bloom ladder, the `isFlourished` flag, the dewdrop
  // anchor aliases, and a full draw pass over a curve-capable stub context.
  step(33, 'tree of knowledge organic stages, dewdrops, and bloom celebration');

  // --- 33a. engine parity ------------------------------------------------
  // The web projector bundles its own copy so Next.js can resolve it; a drift
  // would make the classroom screen and the students' phones disagree.
  const studentEngine33 = readFileSync(new URL('../student/tree-engine.js', import.meta.url), 'utf8');
  const webEngine33 = readFileSync(new URL('../web/src/lib/tree-engine.js', import.meta.url), 'utf8');
  check('33a: the web engine copy is byte-identical to the student engine',
    studentEngine33 === webEngine33,
    `student=${studentEngine33.length}B web=${webEngine33.length}B`);

  // The two copies must also be the SAME file the suite imported at the top.
  check('33a: the imported engine exposes the five Phase 8.2 stage constants',
    TREE_STAGES.SEED === 'seed' && TREE_STAGES.SPROUT === 'sprout'
      && TREE_STAGES.SAPLING === 'sapling' && TREE_STAGES.MATURING === 'maturing'
      && TREE_STAGES.BLOOM === 'bloom',
    JSON.stringify(TREE_STAGES));

  // --- 33b. the five growth stages on the new ladder ---------------------
  const treeStateAtP = (k, n) =>
    computeTreeState({ ...treeBase, totalStudents: n, seed: 2026, submissions: treeSubs(k, 4) });

  const stageSeed = treeStateAtP(0, 10);
  check('33b: P = 0 yields TREE_STAGES.SEED',
    stageSeed.participation === 0 && stageSeed.stage === TREE_STAGES.SEED,
    JSON.stringify({ p: stageSeed.participation, stage: stageSeed.stage }));

  const stageSprout = treeStateAtP(1, 10);
  check('33b: P = 0.10 yields TREE_STAGES.SPROUT',
    Math.abs(stageSprout.participation - 0.10) < 1e-9 && stageSprout.stage === TREE_STAGES.SPROUT,
    JSON.stringify({ p: stageSprout.participation, stage: stageSprout.stage }));

  const stageSapling = treeStateAtP(3, 10);
  check('33b: P = 0.30 yields TREE_STAGES.SAPLING',
    Math.abs(stageSapling.participation - 0.30) < 1e-9 && stageSapling.stage === TREE_STAGES.SAPLING,
    JSON.stringify({ p: stageSapling.participation, stage: stageSapling.stage }));

  const stageMaturing = treeStateAtP(7, 10);
  check('33b: P = 0.70 yields TREE_STAGES.MATURING',
    Math.abs(stageMaturing.participation - 0.70) < 1e-9 && stageMaturing.stage === TREE_STAGES.MATURING,
    JSON.stringify({ p: stageMaturing.participation, stage: stageMaturing.stage }));

  const stageBloom = treeStateAtP(10, 10);
  check('33b: P = 1.0 yields TREE_STAGES.BLOOM with isFlourished = true',
    stageBloom.participation === 1 && stageBloom.stage === TREE_STAGES.BLOOM
      && stageBloom.isFlourished === true,
    JSON.stringify({ p: stageBloom.participation, stage: stageBloom.stage, bloom: stageBloom.isFlourished }));

  // The flag must be false at EVERY rung below a full class — otherwise a
  // half-empty room would celebrate.
  check('33b: isFlourished is false for every sub-unity participation',
    [stageSeed, stageSprout, stageSapling, stageMaturing].every((s) => s.isFlourished === false),
    [stageSeed, stageSprout, stageSapling, stageMaturing].map((s) => s.isFlourished).join(','));

  // The ladder is now strictly widening toward the flourish.
  check('33b: the stage ladder reaches MAX_BRANCH_DEPTH only at BLOOM',
    STAGE_LADDER[STAGE_LADDER.length - 1].name === TREE_STAGES.BLOOM
      && STAGE_LADDER[STAGE_LADDER.length - 1].maxDepth === MAX_BRANCH_DEPTH,
    JSON.stringify(STAGE_LADDER[STAGE_LADDER.length - 1]));

  // --- 33c. dewdrop anchors (identity with the fruit aliases) ------------
  const dewAnchors = layoutDewdropAnchors(stageMaturing.anchors, 800, 600);
  check('33c: layoutDewdropAnchors is the SAME behaviour as layoutFruitAnchors',
    JSON.stringify(dewAnchors) === JSON.stringify(layoutFruitAnchors(stageMaturing.anchors, 800, 600)));
  check('33c: every submission yields one in-bounds dewdrop hitbox',
    dewAnchors.length === stageMaturing.anchors.length
      && dewAnchors.every((a) => a.x - a.pixelRadius >= -0.001 && a.x + a.pixelRadius <= 800.001
        && a.y - a.pixelRadius >= -0.001 && a.y + a.pixelRadius <= 600.001),
    JSON.stringify(dewAnchors.map((a) => [a.x, a.y, a.pixelRadius])));
  check('33c: hitTestDewdrops resolves a dewdrop and aliases hitTestFruits',
    hitTestDewdrops(dewAnchors, dewAnchors[0].x, dewAnchors[0].y)?.student_code
      === stageMaturing.anchors[0].student_code
      && hitTestFruits(dewAnchors, dewAnchors[0].x, dewAnchors[0].y)?.student_code
        === stageMaturing.anchors[0].student_code,
    hitTestDewdrops(dewAnchors, dewAnchors[0].x, dewAnchors[0].y)?.student_code);
  check('33c: hitTestDewdrops returns null on empty space',
    hitTestDewdrops([], 10, 10) === null);

  // A denser/harder case must still be overlap-free on the new engine.
  const denseState = computeTreeState({ ...treeBase, totalStudents: 48, seed: 88, submissions: treeSubs(48, 3) });
  const denseLayout = layoutDewdropAnchors(denseState.anchors, 1000, 800);
  let denseWorstGap = Infinity;
  for (let i = 0; i < denseLayout.length; i += 1) {
    for (let j = i + 1; j < denseLayout.length; j += 1) {
      const dx = denseLayout[j].x - denseLayout[i].x;
      const dy = denseLayout[j].y - denseLayout[i].y;
      const gap = Math.sqrt(dx * dx + dy * dy)
        - (denseLayout[i].pixelRadius + denseLayout[j].pixelRadius);
      if (gap < denseWorstGap) denseWorstGap = gap;
    }
  }
  check('33c: a 48-dewdrop canopy stays overlap-free',
    denseLayout.length === 48 && denseWorstGap > 0,
    `worst gap = ${denseWorstGap.toExponential(3)}px`);

  // --- 33d. TreeRenderer draws every stage on a curve-capable stub -------
  // This stub is richer than Step 29's: it records the organic primitives
  // (quadraticCurveTo / bezierCurveTo) so the curved-branch and teardrop paths
  // are actually exercised rather than falling back.
  const richGradient = () => ({ addColorStop() {} });
  const richCalls = { arc: 0, fill: 0, stroke: 0, quadratic: 0, bezier: 0, fillRect: 0, ellipse: 0 };
  const richCtx = {
    setTransform() {}, clearRect() {},
    fillRect() { richCalls.fillRect += 1; },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() { richCalls.quadratic += 1; },
    bezierCurveTo() { richCalls.bezier += 1; },
    ellipse() { richCalls.ellipse += 1; },
    arc() { richCalls.arc += 1; },
    fill() { richCalls.fill += 1; },
    stroke() { richCalls.stroke += 1; },
    save() {}, restore() {},
    createLinearGradient: richGradient, createRadialGradient: richGradient,
  };
  const richCanvas = {
    width: 0, height: 0, clientWidth: 900, clientHeight: 700,
    getContext: () => richCtx,
  };
  const bloomRenderer = new TreeRenderer(richCanvas);

  let renderError = '';
  try {
    bloomRenderer.render(stageSeed);
    bloomRenderer.render(stageSprout);
    bloomRenderer.render(stageSapling);
    bloomRenderer.render(stageMaturing);
    bloomRenderer.render(stageBloom);
  } catch (err) {
    renderError = String(err?.message ?? err);
  }
  check('33d: TreeRenderer draws all five stages without throwing',
    renderError === '', renderError);
  check('33d: the organic branch pass used quadratic Curves',
    richCalls.quadratic > 0, JSON.stringify(richCalls));
  check('33d: the dewdrop body used Bézier Curves',
    richCalls.bezier > 0, JSON.stringify(richCalls));

  // The seed stage draws no dewdrops; the bloom stage caches one per submission
  // AND paints flowers/sparkles (extra `arc` calls beyond the dewdrop count).
  bloomRenderer.render(stageSeed);
  check('33d: the seed stage exposes no dewdrop hitboxes',
    bloomRenderer.dewdropAnchors.length === 0, String(bloomRenderer.dewdropAnchors.length));

  bloomRenderer.render(stageBloom);
  check('33d: the bloom stage caches one hitbox per submission',
    bloomRenderer.dewdropAnchors.length === stageBloom.anchors.length,
    `${bloomRenderer.dewdropAnchors.length} vs ${stageBloom.anchors.length}`);

  const bloomTarget = bloomRenderer.dewdropAnchors[1];
  check('33d: getDewdropAt resolves the dewdrop and aliases getFruitAt',
    bloomRenderer.getDewdropAt(bloomTarget.x, bloomTarget.y)?.student_code
      === stageBloom.anchors[1].student_code
      && bloomRenderer.getFruitAt(bloomTarget.x, bloomTarget.y)?.student_code
        === stageBloom.anchors[1].student_code,
    bloomTarget.student_code);

  bloomRenderer.setHighlight(bloomTarget.id);
  check('33d: setHighlight re-renders the highlighted dewdrop without throwing',
    bloomRenderer.getDewdropAt(bloomTarget.x, bloomTarget.y) !== null);
  bloomRenderer.startAnimation(stageBloom);
  bloomRenderer.stopAnimation();
  check('33d: startAnimation/stopAnimation no-op safely without requestAnimationFrame',
    bloomRenderer.animFrameId === null);

  // --- 33e. UI copy renamed from "Quả" to "Giọt sương" -------------------
  const projectorSource = readFileSync(new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');
  const studentAppSource = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('33e: the projector tooltip is titled "Giọt sương tri thức"',
    projectorSource.includes('Giọt sương tri thức'),
    'projector copy not renamed');
  check('33e: the projector progress badge celebrates contributing "dưỡng chất"',
    projectorSource.includes('đã góp dưỡng chất'), 'badge copy not renamed');
  // Phase 8.4 superseded the single class-wide bloom banner: the P = 1.0
  // celebration is now the per-Tổ champion banner on the winning tree.
  check('33e: the projector celebrates the first Tổ to flourish',
    projectorSource.includes('QUÁN QUÂN: TỔ') && projectorSource.includes('VỀ ĐÍCH ĐẦU TIÊN'),
    'per-team bloom banner missing');
  check('33e: the student SPA success message speaks of a knowledge dewdrop',
    studentAppSource.includes('Giọt sương tri thức của bạn đã hòa vào cây'),
    'student success copy not renamed');
  check('33e: no stale "Quả của bạn" / "Quả #" copy remains in the SPA or projector',
    !studentAppSource.includes('Quả của bạn') && !projectorSource.includes('Quả #'),
    'stale fruit copy remains');

  /* --- 34. Procedural Web Audio effects (8.3) -------------------------- */
  // The audio module is DOM-free at import time EXCEPT the guarded `localStorage`
  // read, so a mock `window`/`localStorage`/`AudioContext` must be installed
  // BEFORE importing it — that is exactly what the guards exist for. Two imports
  // with distinct query strings give a fresh module instance per boot case.
  step(34, 'tree of knowledge procedural audio, mute persistence, and synthesis');

  const makeMockStorage = (initial = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
      _dump: () => Object.fromEntries(store),
    };
  };

  // A recording mock AudioContext. Every node method the engine calls is
  // captured, and each numeric argument is checked for NaN/Infinity so a broken
  // envelope or a bad ramp target fails the test rather than silently passing.
  const createMockAudio = () => {
    const calls = {
      oscillators: [], gains: [], ramps: [], starts: [], stops: [], resumes: 0, connects: 0,
    };
    const badNumbers = [];
    const noteNumber = (value, where) => {
      const n = Number(value);
      if (!Number.isFinite(n)) badNumbers.push(`${where}=${value}`);
      return n;
    };

    const makeParam = (kind, node) => ({
      setValueAtTime(value, time) {
        noteNumber(value, `${kind}.setValueAtTime.value`);
        noteNumber(time, `${kind}.setValueAtTime.time`);
        calls.ramps.push({ kind, type: 'set', value });
        return this;
      },
      exponentialRampToValueAtTime(value, time) {
        noteNumber(value, `${kind}.exp.value`);
        noteNumber(time, `${kind}.exp.time`);
        if (value === 0) badNumbers.push(`${kind}.exp.target=0`);
        calls.ramps.push({ kind, type: 'exp', value });
        return this;
      },
      linearRampToValueAtTime(value, time) {
        noteNumber(value, `${kind}.linear.value`);
        noteNumber(time, `${kind}.linear.time`);
        return this;
      },
    });

    const makeOscillator = () => {
      const osc = {
        type: 'sine',
        frequency: makeParam('frequency', null),
        connect(dest) { calls.connects += 1; return dest; },
        start(time) { noteNumber(time, 'osc.start'); calls.starts.push(time); },
        stop(time) { noteNumber(time, 'osc.stop'); calls.stops.push(time); },
        disconnect() {},
      };
      calls.oscillators.push(osc);
      return osc;
    };

    const makeGain = () => {
      const gain = {
        gain: makeParam('gain', null),
        connect(dest) { calls.connects += 1; return dest; },
        disconnect() {},
      };
      calls.gains.push(gain);
      return gain;
    };

    const ctx = {
      state: 'running',
      currentTime: 1.5,
      destination: { id: 'dest' },
      createOscillator: makeOscillator,
      createGain: makeGain,
      async resume() { calls.resumes += 1; this.state = 'running'; },
      async suspend() { this.state = 'suspended'; },
    };
    return { ctx, calls, badNumbers };
  };

  const installAudioGlobals = (storage) => {
    const { ctx, calls, badNumbers } = createMockAudio();
    globalThis.localStorage = storage;
    globalThis.window = {
      localStorage: storage,
      AudioContext: function MockAudioContext() { return ctx; },
    };
    return { ctx, calls, badNumbers };
  };

  const clearAudioGlobals = () => {
    delete globalThis.window;
    delete globalThis.localStorage;
  };

  // --- 34a. export surface ----------------------------------------------
  const bootStorage = makeMockStorage(); // no persisted flag -> unmuted default
  installAudioGlobals(bootStorage);
  const audio = await import(new URL('../student/tree-audio.js?case=default', import.meta.url).href);

  check('34a: tree-audio.js exports the full procedural surface',
    typeof audio.isAudioMuted === 'function'
      && typeof audio.setAudioMuted === 'function'
      && typeof audio.toggleAudioMute === 'function'
      && typeof audio.resumeAudioContext === 'function'
      && typeof audio.playDewdropSound === 'function'
      && typeof audio.playBloomFanfare === 'function',
    Object.keys(audio).join(','));

  check('34a: a fresh install defaults to unmuted',
    audio.isAudioMuted() === false, String(audio.isAudioMuted()));

  // --- 34b. mute persistence --------------------------------------------
  check('34b: setAudioMuted(true) reports and stores the new state',
    audio.setAudioMuted(true) === true && bootStorage.getItem('adqs_tree_muted') === 'true',
    JSON.stringify(bootStorage._dump()));

  check('34b: toggleAudioMute() flips back to unmuted and persists "false"',
    audio.toggleAudioMute() === false && audio.isAudioMuted() === false
      && bootStorage.getItem('adqs_tree_muted') === 'false',
    JSON.stringify(bootStorage._dump()));

  // A second instance must honour a pre-existing persisted flag — this is the
  // reload path a teacher relies on.
  const mutedStorage = makeMockStorage({ adqs_tree_muted: 'true' });
  installAudioGlobals(mutedStorage);
  const audioMuted = await import(new URL('../student/tree-audio.js?case=muted', import.meta.url).href);
  check('34b: a reload restores the persisted muted state',
    audioMuted.isAudioMuted() === true, String(audioMuted.isAudioMuted()));

  // --- 34c. dewdrop synthesis -------------------------------------------
  // Re-install a clean, UNMUTED context for the synthesis assertions.
  const synthStorage = makeMockStorage();
  const synth = installAudioGlobals(synthStorage);
  const audio2 = await import(new URL('../student/tree-audio.js?case=synth', import.meta.url).href);

  let dewdropError = '';
  try {
    audio2.playDewdropSound(1.0);
  } catch (err) {
    dewdropError = String(err?.message ?? err);
  }
  check('34c: playDewdropSound synthesizes one oscillator + gain without throwing',
    dewdropError === '' && synth.calls.oscillators.length === 1 && synth.calls.gains.length === 1,
    `${dewdropError} osc=${synth.calls.oscillators.length} gain=${synth.calls.gains.length}`);
  check('34c: the dewdrop gain envelope uses exponential ramps (attack + decay)',
    synth.calls.ramps.filter((r) => r.kind === 'gain' && r.type === 'exp').length === 2,
    JSON.stringify(synth.calls.ramps.filter((r) => r.kind === 'gain')));
  check('34c: the dewdrop frequency chirp uses exponential ramps',
    synth.calls.ramps.filter((r) => r.kind === 'frequency' && r.type === 'exp').length === 2,
    JSON.stringify(synth.calls.ramps.filter((r) => r.kind === 'frequency')));
  check('34c: the oscillator is started and stopped',
    synth.calls.starts.length === 1 && synth.calls.stops.length === 1,
    `start=${synth.calls.starts.length} stop=${synth.calls.stops.length}`);
  check('34c: no NaN/Infinity reached any audio parameter',
    synth.badNumbers.length === 0, synth.badNumbers.join(','));

  // Vitality must actually change the pitch — a brighter tree, a brighter drop.
  const freqAt = (vitality) => {
    const local = installAudioGlobals(makeMockStorage());
    // The already-imported module captures its context lazily on first play, so
    // re-import a fresh instance bound to this context.
    return import(new URL(`../student/tree-audio.js?v=${vitality}`, import.meta.url).href)
      .then((mod) => {
        mod.playDewdropSound(vitality);
        const first = local.calls.ramps.find((r) => r.kind === 'frequency' && r.type === 'set');
        return first ? first.value : NaN;
      });
  };
  const lowPitch = await freqAt(0.2);
  const highPitch = await freqAt(1.0);
  check('34c: vitality raises the dewdrop base pitch',
    Number.isFinite(lowPitch) && Number.isFinite(highPitch) && highPitch > lowPitch,
    `low=${lowPitch} high=${highPitch}`);

  // --- 34d. bloom fanfare -------------------------------------------------
  const fanfareStorage = makeMockStorage();
  const fanfare = installAudioGlobals(fanfareStorage);
  const audio3 = await import(new URL('../student/tree-audio.js?case=fanfare', import.meta.url).href);

  let fanfareError = '';
  try {
    audio3.playBloomFanfare();
  } catch (err) {
    fanfareError = String(err?.message ?? err);
  }
  check('34d: playBloomFanfare synthesizes a six-note arpeggio without throwing',
    fanfareError === '' && fanfare.calls.oscillators.length === 6 && fanfare.calls.gains.length === 6,
    `${fanfareError} osc=${fanfare.calls.oscillators.length}`);
  check('34d: the six notes are staggered 120ms apart',
    fanfare.calls.starts.length === 6
      && fanfare.calls.starts.every((t, i) => i === 0 || Math.abs((t - fanfare.calls.starts[i - 1]) - 0.12) < 1e-9),
    JSON.stringify(fanfare.calls.starts));
  check('34d: the fanfare uses a long bell decay (≈1.2s per note)',
    fanfare.calls.ramps.filter((r) => r.kind === 'gain' && r.type === 'exp').length === 12,
    String(fanfare.calls.ramps.filter((r) => r.kind === 'gain').length));
  check('34d: no NaN/Infinity reached the fanfare parameters',
    fanfare.badNumbers.length === 0, fanfare.badNumbers.join(','));

  // --- 34e. mute suppresses playback; resume honours the Autoplay Policy ----
  const silentStorage = makeMockStorage();
  const silent = installAudioGlobals(silentStorage);
  const audio4 = await import(new URL('../student/tree-audio.js?case=silent', import.meta.url).href);
  audio4.setAudioMuted(true);
  audio4.playDewdropSound(1.0);
  audio4.playBloomFanfare();
  check('34e: a muted engine synthesizes nothing',
    silent.calls.oscillators.length === 0 && silent.calls.gains.length === 0,
    `osc=${silent.calls.oscillators.length}`);
  audio4.setAudioMuted(false);

  // A suspended context must be resumed, and playback must not fire until it is.
  silent.ctx.state = 'suspended';
  const beforeResume = silent.calls.oscillators.length;
  audio4.playDewdropSound(1.0);
  check('34e: a suspended context refuses to play until resumed',
    silent.calls.oscillators.length === beforeResume,
    String(silent.calls.oscillators.length - beforeResume));
  await audio4.resumeAudioContext();
  check('34e: resumeAudioContext() resumes the context',
    silent.ctx.state === 'running' && silent.calls.resumes === 1,
    `state=${silent.ctx.state} resumes=${silent.calls.resumes}`);
  audio4.playDewdropSound(1.0);
  check('34e: playback works after the gesture-driven resume',
    silent.calls.oscillators.length === beforeResume + 1,
    String(silent.calls.oscillators.length - beforeResume));

  // --- 34f. no-ops safely with no Web Audio host -------------------------
  // This is the SSR / unsupported-browser path: the helpers must return quietly
  // rather than throwing a ReferenceError.
  clearAudioGlobals();
  let headlessError = '';
  try {
    audio4.playDewdropSound(1.0);
    audio4.playBloomFanfare();
    const ctx = await audio4.resumeAudioContext();
    if (ctx !== null) headlessError = 'expected a null context';
  } catch (err) {
    headlessError = String(err?.message ?? err);
  }
  check('34f: the engine no-ops without a window/AudioContext',
    headlessError === '', headlessError);

  // --- 34g. projector + SPA wiring --------------------------------------
  const projectorAudioSrc = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');
  const studentAudioSrc = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  const studentHtmlAudio = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');

  check('34g: the projector imports and calls the audio engine',
    projectorAudioSrc.includes("from '@/lib/tree-audio'")
      && projectorAudioSrc.includes('playDewdropSound(')
      && projectorAudioSrc.includes('playBloomFanfare(')
      && projectorAudioSrc.includes('resumeAudioContext('),
    'projector audio wiring missing');
  check('34g: the projector ships a mute toggle bound to the persisted flag',
    projectorAudioSrc.includes('toggleAudioMute()') && projectorAudioSrc.includes('isAudioMuted()')
      && projectorAudioSrc.includes('🔇') && projectorAudioSrc.includes('🔊'),
    'mute toggle missing');
  check('34g: the SPA imports the audio engine and chimes on submit',
    studentAudioSrc.includes("from './tree-audio.js'")
      && studentAudioSrc.includes('playDewdropSound(')
      && studentAudioSrc.includes('playBloomFanfare('),
    'SPA audio wiring missing');
  check('34g: the SPA workspace header exposes the audio toggle button',
    studentHtmlAudio.includes('id="btnTreeAudioToggle"'), 'toggle button missing');

  /* --- 35. 4-team competition arena (8.4) ------------------------------ */
  // One class of EIGHT members, exactly two per Tổ, so every team's 100% is a
  // 2/2 rather than a trivial 1/1. This is the smallest shape that exercises the
  // whole arena: four independent denominators, four distinct seeds, and one
  // team racing ahead of the other three.
  step(35, 'tree of knowledge four-team arena and first-to-finish champion');

  const TEAM_CLASS = 'E2E-TEAM-' + String(Math.floor(1000 + Math.random() * 9000));
  const TEAM_MEMBERS = [
    { code: 'E2ETEAM01', name: 'Tổ Một Bạn A', team: 1 },
    { code: 'E2ETEAM02', name: 'Tổ Một Bạn B', team: 1 },
    { code: 'E2ETEAM03', name: 'Tổ Hai Bạn A', team: 2 },
    { code: 'E2ETEAM04', name: 'Tổ Hai Bạn B', team: 2 },
    { code: 'E2ETEAM05', name: 'Tổ Ba Bạn A', team: 3 },
    { code: 'E2ETEAM06', name: 'Tổ Ba Bạn B', team: 3 },
    { code: 'E2ETEAM07', name: 'Tổ Bốn Bạn A', team: 4 },
    { code: 'E2ETEAM08', name: 'Tổ Bốn Bạn B', team: 4 },
  ];

  const teamClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: TEAM_CLASS, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('35a: the 4-team class was created', !teamClass.error && !!teamClass.data,
    teamClass.error?.message);
  const teamClassId = teamClass.data?.id;

  const teamRoster = await saveClassMembers(
    teacher,
    teamClassId,
    TEAM_MEMBERS.map((m) => ({
      student_code: m.code, full_name: m.name, dob: null, pin: null, team_number: m.team,
    })),
  );
  check('35a: the class has 8 members (2 per Tổ)', teamRoster.saved === 8,
    String(teamRoster.saved));

  // A permissive ceiling: the ONLY refusal this step wants is the deliberate
  // cross-team duplicate, so every genuine answer must clear the gate.
  const teamSession = await teacher
    .from('tree_sessions')
    .insert({
      user_id: teacherId,
      class_id: teamClassId,
      title: 'E2E Đấu trường 4 Tổ',
      question_text: 'Vì sao sức mạnh tập thể lại quan trọng trong học tập?',
      min_words: 5,
      time_limit_minutes: 45,
      max_similarity: 0.50,
      // Phase 9.1 — opened directly; Step 44 owns the lobby gate.
      status: 'ACTIVE',
      is_active: true,
    })
    .select('id, tree_seed, session_code')
    .single();
  check('35a: the arena session was created', !teamSession.error && !!teamSession.data,
    teamSession.error?.message);
  const teamSessionId = teamSession.data?.id;
  const teamSeed = Number(teamSession.data?.tree_seed);

  const teamAnon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- 35b. team_counts + per-candidate team_number ---------------------
  const teamPublic = await teamAnon.rpc('get_public_tree_session', {
    p_session_code: teamSession.data?.session_code,
  });
  check('35b: anon can load the arena session', teamPublic.data?.success === true,
    JSON.stringify(teamPublic.data));

  const teamCounts = teamPublic.data?.team_counts;
  check('35b: team_counts reports exactly 2 members per Tổ',
    teamCounts?.[1] === 2 && teamCounts?.[2] === 2
      && teamCounts?.[3] === 2 && teamCounts?.[4] === 2,
    JSON.stringify(teamCounts));
  check('35b: the four team_counts sum to the class size',
    Object.values(teamCounts || {}).reduce((sum, n) => sum + Number(n), 0) === 8,
    JSON.stringify(teamCounts));

  const teamCandidates = teamPublic.data?.candidates || [];
  check('35b: every candidate carries a valid team_number',
    teamCandidates.length === 8
      && teamCandidates.every((c) => Number.isInteger(c.team_number)
        && c.team_number >= 1 && c.team_number <= 4),
    JSON.stringify(teamCandidates.map((c) => [c.student_code, c.team_number])));
  check('35b: candidates are ordered team-first, so Tổ 1 leads the roster',
    JSON.stringify(teamCandidates.slice(0, 2).map((c) => c.student_code))
      === JSON.stringify(['E2ETEAM01', 'E2ETEAM02']),
    JSON.stringify(teamCandidates.map((c) => c.student_code)));

  // --- 35c. seed derivation ---------------------------------------------
  check('35c: TEAM_NUMBERS enumerates exactly the four Tổ',
    JSON.stringify(TEAM_NUMBERS) === JSON.stringify([1, 2, 3, 4]),
    JSON.stringify(TEAM_NUMBERS));
  const teamSeeds = TEAM_NUMBERS.map((team) => getTeamSeed(teamSeed, team));
  check('35c: getTeamSeed yields four DISTINCT seeds from one base seed',
    new Set(teamSeeds).size === 4, JSON.stringify(teamSeeds));
  check('35c: the derived seeds are deterministic and unsigned 32-bit',
    teamSeeds.every((s) => Number.isInteger(s) && s >= 0 && s <= 0xffffffff)
      && getTeamSeed(teamSeed, 2) === teamSeeds[1],
    JSON.stringify(teamSeeds));
  check('35c: clampTeamNumber folds out-of-range input back into 1..4',
    clampTeamNumber(0) === 1 && clampTeamNumber(9) === 4
      && clampTeamNumber('3') === 3 && clampTeamNumber(null) === 1,
    [clampTeamNumber(0), clampTeamNumber(9), clampTeamNumber('3'), clampTeamNumber(null)].join(','));

  // --- 35d. Team 1 races to 100%; submit_tree_answer tags the Tổ --------
  const TEAM1_TEXTS = [
    'Suc manh tap the den tu viec moi nguoi bo sung cho nhau nhung diem manh rieng',
    'Hoc nhom giup chung ta hieu sau hon vi phai giai thich lai cho ban be hieu',
  ];
  const team1Submits = [];
  for (let i = 0; i < 2; i += 1) {
    const member = TEAM_MEMBERS[i];
    const res = await teamAnon.rpc('submit_tree_answer', {
      p_session_id: teamSessionId,
      p_student_code: member.code,
      p_student_name: member.name,
      p_answer_text: TEAM1_TEXTS[i],
    });
    team1Submits.push(res.data);
    check(`35d: ${member.code} (Tổ 1) submitted successfully`,
      res.data?.success === true, JSON.stringify(res.data));
  }
  check('35d: submit_tree_answer returns the author\'s team_number = 1',
    team1Submits.every((d) => d?.team_number === 1),
    JSON.stringify(team1Submits.map((d) => d?.team_number)));

  // The stored rows must carry the same tag the RPC reported.
  const teamRows = await teamAnon
    .from('tree_submissions')
    .select('student_code, team_number, fruit_index')
    .eq('session_id', teamSessionId)
    .order('fruit_index');
  check('35d: both Tổ 1 rows are recorded with team_number = 1',
    teamRows.data?.length === 2 && teamRows.data.every((r) => r.team_number === 1),
    JSON.stringify(teamRows.data));

  // --- 35e. Team 1 blooms while 2-4 stay at SEED ------------------------
  const teamStateFor = (team) => {
    const subs = (teamRows.data || []).filter((r) => r.team_number === team);
    return computeTreeState({
      totalStudents: Math.max(teamCounts?.[team] ?? 0, 1),
      submissions: subs,
      timeLimitMinutes: 45,
      createdAt: teamPublic.data?.session?.created_at,
      seed: getTeamSeed(teamSeed, team),
    });
  };

  const team1State = teamStateFor(1);
  check('35e: Tổ 1 at 2/2 reaches BLOOM with isFlourished = true',
    team1State.participation === 1 && team1State.stage === TREE_STAGES.BLOOM
      && team1State.isFlourished === true,
    JSON.stringify({ p: team1State.participation, stage: team1State.stage }));

  const laggingStates = [2, 3, 4].map(teamStateFor);
  check('35e: Tổ 2, 3 and 4 remain at SEED with participation 0',
    laggingStates.every((s) => s.participation === 0
      && s.stage === TREE_STAGES.SEED && s.isFlourished === false),
    JSON.stringify(laggingStates.map((s) => ({ p: s.participation, stage: s.stage }))));

  // The champion latch belongs to the FIRST finisher only — asserted here as the
  // same rule the projector runs, so a later Tổ could never steal the 🏆.
  const finishedTeams = TEAM_NUMBERS.filter((team) => {
    const total = teamCounts?.[team] ?? 0;
    const done = (teamRows.data || []).filter((r) => r.team_number === team).length;
    return total > 0 && done >= total;
  });
  check('35e: exactly one Tổ has finished, so the champion is unambiguous',
    finishedTeams.length === 1 && finishedTeams[0] === 1,
    JSON.stringify(finishedTeams));

  // --- 35f. cross-team plagiarism is refused ----------------------------
  // A Tổ 2 member copying a Tổ 1 answer verbatim must be rejected: the
  // similarity check spans the WHOLE session, not just the author's team.
  const crossTeamCopy = await teamAnon.rpc('submit_tree_answer', {
    p_session_id: teamSessionId,
    p_student_code: TEAM_MEMBERS[2].code,
    p_student_name: TEAM_MEMBERS[2].name,
    p_answer_text: `${TEAM1_TEXTS[0]} nhe`,
  });
  check('35f: a Tổ 2 answer copied from Tổ 1 is refused with SIMILARITY_EXCEEDED',
    crossTeamCopy.data?.success === false
      && crossTeamCopy.data?.code === 'SIMILARITY_EXCEEDED'
      && typeof crossTeamCopy.data?.similarity_percent === 'number',
    JSON.stringify(crossTeamCopy.data));

  // A genuinely distinct answer from the same Tổ 2 member is accepted and lands
  // on Tổ 2's tree — proving the refusal above was similarity, not team routing.
  const team2Answer = await teamAnon.rpc('submit_tree_answer', {
    p_session_id: teamSessionId,
    p_student_code: TEAM_MEMBERS[2].code,
    p_student_name: TEAM_MEMBERS[2].name,
    p_answer_text: 'Lam viec nhom re chia khoi luong va giup moi thanh vien tien bo cung nhau',
  });
  check('35f: a distinct Tổ 2 answer is accepted and tagged team_number = 2',
    team2Answer.data?.success === true && team2Answer.data?.team_number === 2,
    JSON.stringify(team2Answer.data));
  check('35f: Tổ 1 remains the sole finisher after Tổ 2\'s submission',
    computeTreeState({
      totalStudents: teamCounts?.[2] ?? 1,
      submissions: [{ student_code: TEAM_MEMBERS[2].code, team_number: 2, fruit_index: 3 }],
      timeLimitMinutes: 45,
      createdAt: teamPublic.data?.session?.created_at,
      seed: getTeamSeed(teamSeed, 2),
    }).isFlourished === false,
    'a partially-submitted Tổ must not flourish');

  // --- 35g. the projector + SPA are wired for the arena ------------------
  const projectorArenaSrc = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');
  const studentArenaSrc = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  const studentArenaHtml = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');

  check('35g: the projector derives a per-team seed and renders a 2x2 arena',
    projectorArenaSrc.includes('getTeamSeed(session.tree_seed, team)')
      && projectorArenaSrc.includes('sm:grid-cols-2'),
    'arena grid or per-team seed missing');
  check('35g: the projector latches the first finisher and fires the fanfare',
    projectorArenaSrc.includes('firstFinishedTeam') && projectorArenaSrc.includes('firstFinishedRef')
      && projectorArenaSrc.includes('playBloomFanfare()'),
    'champion latch missing');
  check('35g: the projector crowns the champion with the trophy banner',
    projectorArenaSrc.includes('QUÁN QUÂN: TỔ') && projectorArenaSrc.includes('Trophy'),
    'champion banner missing');
  check('35g: the SPA filters submissions to the student\'s own Tổ',
    studentArenaSrc.includes('state.studentTeam')
      && studentArenaSrc.includes('getTeamSeed(session.seed, team)')
      && studentArenaSrc.includes('clampTeamNumber(row.team_number) === team'),
    'SPA team filter missing');
  check('35g: the SPA renders a sticky mini-leaderboard with an is-my-team badge',
    studentArenaSrc.includes('renderLeaderboard')
      && studentArenaSrc.includes('is-my-team')
      && studentArenaHtml.includes('id="treeTeamLeaderboard"'),
    'leaderboard missing');

  // --- 35h. cleanup ------------------------------------------------------
  await teacher.from('tree_sessions').delete().eq('id', teamSessionId);
  const teamClassDelete = await teacher.from('classes').delete().eq('id', teamClassId);
  check('35h: the arena class deletes once its session is gone',
    !teamClassDelete.error, teamClassDelete.error?.message);

  /* --- 36. Exam navigation, auto-advance, high-contrast themes (8.5) --- */
  // The navigation/theme logic lives in `student/exam-nav.js`, a dependency-free
  // module the SPA imports — so these are REAL executions of the shipped code,
  // not assertions about its source text. The markup/contrast assertions that
  // cannot be executed headlessly (no jsdom in the toolchain) are static checks
  // against index.html/styles.css at the end.
  step(36, 'exam navigation bar, auto-advance, high-contrast themes, palette drawer');

  // --- 36a. markup: the new chrome exists -------------------------------
  const navHtml36 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const navCss36 = readFileSync(new URL('../student/styles.css', import.meta.url), 'utf8');

  check('36a: index.html ships the auto-advance checkbox and the bottom nav buttons',
    navHtml36.includes('id="chk-auto-advance"')
      && navHtml36.includes('id="btn-prev-question"')
      && navHtml36.includes('id="btn-next-question"')
      && navHtml36.includes('id="btn-finish-exam"'),
    'bottom navigation markup missing');
  check('36a: index.html ships the palette trigger + drawer',
    navHtml36.includes('id="btn-open-palette"')
      && navHtml36.includes('id="question-palette-drawer"')
      && navHtml36.includes('id="palette-grid-container"'),
    'palette drawer markup missing');
  check('36a: index.html ships the high-contrast theme + font buttons',
    navHtml36.includes('id="btn-theme-toggle"') && navHtml36.includes('id="btn-font-toggle"'),
    'theme/font buttons missing');
  check('36a: the old invisible icon-btn controls are gone',
    !navHtml36.includes('id="themeBtn"') && !navHtml36.includes('id="navToggleBtn"')
      && !navHtml36.includes('id="navPanel"'),
    'a legacy control survived');
  check('36a: the retired confirm button is gone from the action bar',
    !navHtml36.includes('id="confirmBtn"') && !navHtml36.includes('id="actionBar"'),
    'the draft/confirm action bar survived');

  // --- 36b. auto-advance policy (executed) ------------------------------
  check('36b: the confirmation beat is the specified 280ms',
    AUTO_ADVANCE_MS === 280, String(AUTO_ADVANCE_MS));

  const mcqAnswer = { draft: 1 };
  check('36b: an MCQ selection auto-advances when enabled and not on the last question',
    shouldAutoAdvance({ enabled: true, currentIndex: 0, total: 5, type: 'MCQ', answer: mcqAnswer }) === true,
    'MCQ should advance');
  check('36b: auto-advance is REFUSED on the last question (nowhere to go)',
    shouldAutoAdvance({ enabled: true, currentIndex: 4, total: 5, type: 'MCQ', answer: mcqAnswer }) === false,
    'last question advanced');
  check('36b: auto-advance is REFUSED when the student disabled the toggle',
    shouldAutoAdvance({ enabled: false, currentIndex: 0, total: 5, type: 'MCQ', answer: mcqAnswer }) === false,
    'disabled toggle still advanced');
  check('36b: re-tapping the SAME option does not advance',
    shouldAutoAdvance({ enabled: true, currentIndex: 0, total: 5, type: 'MCQ', answer: mcqAnswer, changed: false }) === false,
    'unchanged selection advanced');
  check('36b: a text (ESSAY) answer NEVER auto-advances mid-typing',
    shouldAutoAdvance({ enabled: true, currentIndex: 0, total: 5, type: 'ESSAY', answer: { draft: 'abc' } }) === false,
    'essay advanced while typing');
  check('36b: a partly-answered TRUE_FALSE does NOT advance',
    shouldAutoAdvance({
      enabled: true, currentIndex: 0, total: 5, type: 'TRUE_FALSE',
      answer: { draft: ['Đ', '', 'S', ''] },
    }) === false,
    'incomplete TRUE_FALSE advanced');
  check('36b: a fully-answered TRUE_FALSE advances',
    shouldAutoAdvance({
      enabled: true, currentIndex: 0, total: 5, type: 'TRUE_FALSE',
      answer: { draft: ['Đ', 'S', 'S', 'Đ'] },
    }) === true,
    'complete TRUE_FALSE did not advance');

  // The preference round-trips through a storage stub, defaulting to ON.
  const storageStub = (() => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      raw: map,
    };
  })();
  check('36b: auto-advance defaults to ON when nothing is stored',
    readAutoAdvancePreference(storageStub) === true, 'default was OFF');
  writeAutoAdvancePreference(storageStub, false);
  check('36b: the OFF preference round-trips through storage',
    readAutoAdvancePreference(storageStub) === false
      && storageStub.raw.get(AUTO_ADVANCE_KEY) === 'false',
    JSON.stringify(storageStub.raw.get(AUTO_ADVANCE_KEY)));
  writeAutoAdvancePreference(storageStub, true);
  check('36b: the ON preference round-trips through storage',
    readAutoAdvancePreference(storageStub) === true, 'ON did not round-trip');
  check('36b: a storage that THROWS still yields the safe ON default',
    readAutoAdvancePreference({ getItem: () => { throw new Error('denied'); } }) === true,
    'a throwing storage disabled auto-advance');

  // --- 36c. index clamping (executed) -----------------------------------
  check('36c: clampQuestionIndex pins out-of-range input into 0..N-1',
    clampQuestionIndex(-5, 10) === 0 && clampQuestionIndex(99, 10) === 9
      && clampQuestionIndex(3, 10) === 3,
    [clampQuestionIndex(-5, 10), clampQuestionIndex(99, 10), clampQuestionIndex(3, 10)].join(','));
  check('36c: a zero-question exam clamps to 0 rather than a negative index',
    clampQuestionIndex(4, 0) === 0 && clampQuestionIndex(0, 0) === 0,
    String(clampQuestionIndex(4, 0)));
  check('36c: non-numeric input clamps to 0',
    clampQuestionIndex('abc', 10) === 0 && clampQuestionIndex(null, 10) === 0,
    String(clampQuestionIndex('abc', 10)));

  // --- 36d. theme + font cycles (executed) ------------------------------
  check('36d: the theme cycle is exactly light -> dark -> sepia',
    JSON.stringify(THEME_CYCLE) === JSON.stringify(['light', 'dark', 'sepia']),
    JSON.stringify(THEME_CYCLE));
  check('36d: nextTheme walks the full cycle and wraps back to light',
    nextTheme('light') === 'dark' && nextTheme('dark') === 'sepia'
      && nextTheme('sepia') === 'light',
    [nextTheme('light'), nextTheme('dark'), nextTheme('sepia')].join('>'));
  check('36d: normalizeTheme keeps an explicit choice and falls back to the OS',
    normalizeTheme('sepia', false) === 'sepia'
      && normalizeTheme(null, true) === 'dark'
      && normalizeTheme(undefined, false) === 'light',
    'normalizeTheme misbehaved');
  check('36d: the font ladder is normal(\'\') -> lg -> xl',
    JSON.stringify(FONT_CYCLE) === JSON.stringify(['', 'lg', 'xl']),
    JSON.stringify(FONT_CYCLE));
  check('36d: nextFontStep walks the ladder and wraps back to normal',
    nextFontStep('') === 'lg' && nextFontStep('lg') === 'xl'
      && nextFontStep('xl') === '',
    [nextFontStep(''), nextFontStep('lg'), nextFontStep('xl')].join('>'));

  // --- 36e. palette cell model (executed) -------------------------------
  const palette = buildPaletteCells({
    total: 6,
    answered: [true, false, true, false, true, false],
    flags: new Set([1, 2]),
    currentIndex: 2,
  });
  check('36e: the palette renders exactly one cell per question (N = 6)',
    palette.length === 6, String(palette.length));
  check('36e: answered indices receive the answered role',
    palette[0].answered === true && palette[1].answered === false
      && palette[2].answered === true,
    JSON.stringify(palette.map((c) => c.answered)));
  check('36e: flagged indices receive the flagged role',
    palette[1].flagged === true && palette[2].flagged === true
      && palette[0].flagged === false,
    JSON.stringify(palette.map((c) => c.flagged)));
  check('36e: exactly one cell is the current question',
    palette.filter((c) => c.current).length === 1 && palette[2].current === true,
    JSON.stringify(palette.map((c) => c.current)));
  check('36e: answered + flagged can co-exist on one cell',
    palette[2].answered === true && palette[2].flagged === true,
    JSON.stringify(palette[2]));
  check('36e: the header count is the number ANSWERED, not the cell count',
    palette.answeredCount === 3, String(palette.answeredCount));
  check('36e: an empty exam yields an empty grid and a zero count',
    buildPaletteCells({ total: 0, answered: [], flags: [], currentIndex: 0 }).length === 0,
    'empty exam produced cells');

  // --- 36f. contrast tokens (static — no CSS engine headless) -----------
  // Every control must declare an EXPLICIT, non-transparent surface + border, and
  // the three themes must each define the canonical button tokens. This is the
  // regression guard for the original bug: buttons that rendered invisible.
  check('36f: styles.css defines the canonical button surface tokens',
    navCss36.includes('--surface-btn:') && navCss36.includes('--surface-btn-hover:')
      && navCss36.includes('--border-color:') && navCss36.includes('--border-focus:'),
    'canonical tokens missing');
  check('36f: all three theme palettes define --surface-btn',
    (navCss36.match(/--surface-btn:/g) || []).length >= 4,
    String((navCss36.match(/--surface-btn:/g) || []).length));
  check('36f: the sepia theme is a real palette (warm sand / amber)',
    navCss36.includes('[data-theme="sepia"]') && navCss36.includes('--bg-app: #fbf0d9'),
    'sepia palette missing');
  check('36f: the font ladder is expressed as data-font CSS rules',
    navCss36.includes('[data-font="lg"]') && navCss36.includes('[data-font="xl"]'),
    'font-size rules missing');
  check('36f: top-nav-btn uses an explicit surface + border, not a transparent fill',
    /\.top-nav-btn\s*\{[^}]*background:\s*var\(--surface-btn\)/s.test(navCss36)
      && /\.top-nav-btn\s*\{[^}]*border:\s*1px solid var\(--border-color\)/s.test(navCss36),
    'top-nav-btn contrast tokens missing');
  check('36f: the bottom nav bar and its buttons are styled',
    navCss36.includes('.exam-bottom-bar') && navCss36.includes('.btn-nav-prev')
      && navCss36.includes('.btn-nav-next') && navCss36.includes('.btn-primary-finish'),
    'bottom bar styles missing');
  check('36f: the palette drawer + cell status styles exist',
    navCss36.includes('.palette-drawer') && navCss36.includes('.palette-cell')
      && navCss36.includes('.palette-cell.is-answered')
      && navCss36.includes('.palette-cell.is-current')
      && navCss36.includes('.palette-cell.is-flagged'),
    'palette styles missing');

  // --- 36g. the SPA is wired to the nav module (static) -----------------
  const navApp36 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('36g: app.js imports the shared navigation module (no duplicated logic)',
    navApp36.includes("from './exam-nav.js'")
      && navApp36.includes('shouldAutoAdvance')
      && navApp36.includes('clampQuestionIndex')
      && navApp36.includes('buildPaletteCells'),
    'SPA does not use the shared module');
  check('36g: app.js wires every bottom-bar + palette control',
    ['btn-open-palette', 'btn-close-palette', 'palette-backdrop', 'btn-theme-toggle',
     'btn-font-toggle', 'btn-prev-question', 'btn-next-question', 'btn-flag-question',
     'btn-finish-exam', 'chk-auto-advance']
      .every((id) => navApp36.includes(id)),
    'a control is not wired');
  check('36g: app.js no longer references the retired confirm flow',
    !navApp36.includes('confirmAnswer') && !navApp36.includes('openNavPanel'),
    'retired confirm/nav-panel code survived');

  /* --- 37. Font resize, global theme toggle, smart submit modal (8.6) --- */
  // The "smart" submit decision is a pure function of the paper + answer slots,
  // so it is EXECUTED here rather than grep-asserted. The markup/CSS wiring that
  // cannot run headlessly (no jsdom) is checked statically at the end.
  step(37, 'font resizing fix, global theme toggle, and smart submit modal');

  const navHtml37 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const navCss37 = readFileSync(new URL('../student/styles.css', import.meta.url), 'utf8');
  const navApp37 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');

  // --- 37a. getUnansweredQuestions (executed) ---------------------------
  // A mixed paper: MCQ (2), TRUE_FALSE (3 sub-statements), SHORT_ANSWER/ESSAY.
  const paper37 = [
    { type: 'MCQ' },                                   // 0 answered
    { type: 'MCQ' },                                   // 1 UNANSWERED
    { type: 'TRUE_FALSE', subQuestions: [1, 2, 3] },   // 2 fully answered
    { type: 'SHORT_ANSWER' },                          // 3 UNANSWERED (blank)
    { type: 'ESSAY' },                                 // 4 answered
  ];
  const answers37 = [
    { draft: 2 },                 // MCQ chosen (index 0 is a valid choice!)
    { draft: null },              // MCQ untouched
    { draft: ['Đ', 'S', 'Đ'] },   // TRUE_FALSE all filled
    { draft: '   ' },             // whitespace only = NOT an answer
    { draft: 'Bài làm của em' },  // ESSAY typed
  ];
  const unanswered37 = getUnansweredQuestions(paper37, answers37);
  check('37a: only genuinely unanswered questions are reported',
    JSON.stringify(unanswered37) === JSON.stringify([{ index: 1, ordinal: 2 }, { index: 3, ordinal: 4 }]),
    JSON.stringify(unanswered37));
  check('37a: the list is ordered so result[0] is the SMALLEST unanswered index',
    unanswered37.length === 2 && unanswered37[0].index === 1
      && unanswered37.every((u, i, all) => i === 0 || u.index > all[i - 1].index),
    JSON.stringify(unanswered37.map((u) => u.index)));
  check('37a: MCQ choice index 0 counts as ANSWERED (not falsy-dropped)',
    getUnansweredQuestions([{ type: 'MCQ' }], [{ draft: 0 }]).length === 0,
    'a zero-index MCQ choice was treated as blank');
  check('37a: a partly-answered TRUE_FALSE counts as ANSWERED (matches the palette)',
    // Deliberate: `isDraftReady()` — and therefore `countAnswered()` and the
    // palette — treat ANY filled sub-statement as answered. The submit modal must
    // use the SAME rule, or it would claim a question is outstanding while the
    // palette paints it green. (Auto-advance uses the stricter all-filled rule;
    // that is a navigation concern, not an "answered" one.)
    getUnansweredQuestions(
      [{ type: 'TRUE_FALSE', subQuestions: [1, 2, 3] }],
      [{ draft: ['Đ', '', ''] }],
    ).length === 0,
    'a partially-answered TRUE_FALSE was reported as unanswered');
  check('37a: an UNTOUCHED TRUE_FALSE is unanswered',
    getUnansweredQuestions(
      [{ type: 'TRUE_FALSE', subQuestions: [1, 2, 3] }],
      [{ draft: ['', '', ''] }],
    ).length === 1,
    'a blank TRUE_FALSE was treated as done');
  check('37a: a fully-answered paper yields an empty list',
    getUnansweredQuestions([{ type: 'MCQ' }], [{ draft: 1 }]).length === 0,
    'a complete paper reported outstanding questions');
  check('37a: a missing answer slot counts as unanswered (no crash)',
    getUnansweredQuestions([{ type: 'MCQ' }, { type: 'ESSAY' }], []).length === 2,
    'a short answers array was mishandled');
  check('37a: an empty paper yields an empty list',
    getUnansweredQuestions([], []).length === 0, 'empty paper produced entries');

  // --- 37b. font cycle + labels (executed) ------------------------------
  check('37b: the reading scale ladder is 1 / 1.18 / 1.36 in CSS',
    /:root\[data-font="lg"\][^}]*--reading-scale:\s*1\.18/.test(navCss37)
      && /:root\[data-font="xl"\][^}]*--reading-scale:\s*1\.36/.test(navCss37)
      && /--reading-scale:\s*1;/.test(navCss37),
    'reading-scale ladder missing/incorrect');
  check('37b: the button label names the CURRENT size (Chuẩn / Lớn / Rất lớn)',
    FONT_LABELS[''] === 'Chuẩn' && FONT_LABELS.lg === 'Lớn' && FONT_LABELS.xl === 'Rất lớn',
    JSON.stringify(FONT_LABELS));
  check('37b: app.js renders the label from the shared FONT_LABELS map',
    navApp37.includes('FONT_LABELS') && navApp37.includes('Cỡ chữ:'),
    'app.js does not use the shared font labels');
  check('37b: the question body AND options both scale with --reading-scale',
    /\.q-text\s*\{[^}]*font-size:\s*calc\([^)]*var\(--reading-scale\)/s.test(navCss37)
      && /\.option\s*\{[^}]*font-size:\s*calc\([^}]*var\(--reading-scale\)/s.test(navCss37),
    'reading text is not scale-driven');
  check('37b: no desktop media query re-pins .q-text (the original bug)',
    // Comments are stripped first: the removed override is *described* in a
    // comment, and matching that prose would be a false positive.
    !/@media[^{]*\{[^@]*[^@]?\.q-text\s*\{[^}]*font-size:\s*\d+px/.test(
      navCss37.replace(/\/\*[\s\S]*?\*\//g, ''),
    ),
    'a media query still overrides .q-text font-size');

  // --- 37c. global theme toggle on the login view (static) --------------
  check('37c: index.html ships a global header OUTSIDE #examHeader',
    navHtml37.includes('id="globalHeader"')
      && navHtml37.includes('id="btn-global-theme-toggle"')
      && navHtml37.indexOf('id="globalHeader"') < navHtml37.indexOf('id="examHeader"'),
    'global theme toggle missing or nested inside the exam header');
  check('37c: styles.css styles .app-global-header as a top-right shell strip',
    /\.app-global-header\s*\{[^}]*position:\s*absolute/s.test(navCss37)
      && /\.app-global-header\s*\{[^}]*justify-content:\s*flex-end/s.test(navCss37),
    'global header is not positioned top-right');
  check('37c: app.js wires the global theme toggle to the SHARED cycle',
    navApp37.includes("$('btn-global-theme-toggle')")
      && navApp37.includes('paintThemeButton')
      && (navApp37.match(/paintThemeButton\(/g) || []).length >= 3,
    'the global toggle is not wired to toggleTheme');
  check('37c: the login card is theme-aware through the canonical tokens',
    /\.login__card\s*\{[^}]*background:\s*var\(--surface\)/s.test(navCss37)
      && /\.field input[^{]*\{[^}]*background:\s*var\(--surface\)/s.test(navCss37),
    'login surface does not follow the theme');

  // --- 37d. smart submit modal markup + wiring (static) -----------------
  check('37d: the retired confirm overlay is gone, replaced by #submitModal',
    !navHtml37.includes('id="confirmOverlay"') && navHtml37.includes('id="submitModal"')
      && navHtml37.includes('id="submitModalUnansweredList"'),
    'confirm overlay was not replaced');
  check('37d: the modal ships both a continue and a confirm action',
    navHtml37.includes('id="btnModalContinueExam"') && navHtml37.includes('id="btnModalConfirmSubmit"'),
    'modal action buttons missing');
  check('37d: styles.css styles the backdrop, card and unanswered tags',
    navCss37.includes('.modal-backdrop') && navCss37.includes('.submit-modal-card')
      && navCss37.includes('.unanswered-tag-list') && navCss37.includes('.unanswered-tag'),
    'smart modal styles missing');
  check('37d: the modal copy matches the spec (warning title + unanswered count)',
    navApp37.includes('Chưa hoàn thành bài thi') && navApp37.includes('Hoàn thành bài thi!')
      && navApp37.includes('câu chưa trả lời'),
    'modal copy drifted from the spec');
  check('37d: "Tiếp tục làm bài" jumps to the smallest unanswered index',
    /goToQuestion\(unanswered\[0\]\.index\)/.test(navApp37),
    'continue does not jump to unanswered[0]');
  check('37d: the confirm button submits the sitting (no worker change)',
    navApp37.includes("$('btnModalConfirmSubmit').addEventListener")
      && navApp37.includes('submitExam(false)'),
    'confirm button is not wired to submitExam');

  /* --- 38. Exam shuffle toggle + partitioned shuffle (8.7) -------------- */
  // Two independent halves: the partitioned-ordering POLICY is a pure function
  // and is EXECUTED here; the column/RPC plumbing is asserted against the live
  // database (the toggle is worthless if the column never round-trips).
  step(38, 'per-exam shuffle toggle and TRUE_FALSE-at-the-end partitioning');

  // --- 38a. the column list carries the new field -----------------------
  const columns38 = EXAM_COLUMNS.split(',').map((c) => c.trim());
  check('38a: EXAM_COLUMNS includes shuffle_questions',
    columns38.includes('shuffle_questions'), EXAM_COLUMNS);

  // --- 38b. saveExam persists shuffle_questions and defaults it to true --
  // A real save through the SHIPPED helper, not a hand-written insert: this is
  // what proves the create path actually writes the column. `saveExam` reserves
  // its own code, so the returned code (not a pre-chosen one) is the fixture key.
  const savedShuffle = await saveExam(teacher, {
    title: 'E2E Phase 8.7 Shuffle',
    durationMinutes: 20,
    // Deliberately NOT passing shuffleQuestions: the helper must default it ON.
    questions: [
      { question_text: 'Câu MCQ 1', question_type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correct_answer: 0, explanation: null },
      { question_text: 'Câu Đúng/Sai', question_type: 'TRUE_FALSE', options: ['a', 'b', 'c', 'd'], correct_answer: ['Đ', 'S', 'Đ', 'S'], explanation: null },
    ],
  });
  const shuffleCode = savedShuffle.exam?.code;
  check('38b: saveExam returns the new exam code',
    typeof savedShuffle.exam?.code === 'string' && savedShuffle.exam.code.length === 6,
    JSON.stringify(savedShuffle.exam?.code));
  check('38b: shuffle_questions defaults to true when the caller omits it',
    savedShuffle.exam?.shuffle_questions === true,
    JSON.stringify(savedShuffle.exam?.shuffle_questions));

  // --- 38c. updateExamMetadata round-trips the toggle -------------------
  await updateExamMetadata(teacher, shuffleCode, { shuffleQuestions: false });
  const afterShuffleOff = await teacher
    .from('exams').select('shuffle_questions').eq('code', shuffleCode).single();
  check('38c: updateExamMetadata persists shuffle_questions = false',
    afterShuffleOff.data?.shuffle_questions === false,
    JSON.stringify(afterShuffleOff.data?.shuffle_questions));

  await updateExamMetadata(teacher, shuffleCode, { shuffleQuestions: true });
  const afterShuffleOn = await teacher
    .from('exams').select('shuffle_questions').eq('code', shuffleCode).single();
  check('38c: updateExamMetadata persists shuffle_questions = true',
    afterShuffleOn.data?.shuffle_questions === true,
    JSON.stringify(afterShuffleOn.data?.shuffle_questions));

  // A partial patch must not clobber the column (same discipline as pin_mode).
  await updateExamMetadata(teacher, shuffleCode, { title: 'E2E Phase 8.7 Shuffle (renamed)' });
  const afterTitleOnly = await teacher
    .from('exams').select('shuffle_questions').eq('code', shuffleCode).single();
  check('38c: a title-only patch leaves shuffle_questions untouched',
    afterTitleOnly.data?.shuffle_questions === true,
    JSON.stringify(afterTitleOnly.data?.shuffle_questions));

  // --- 38d. get_exam_roster exposes the flag to the student -------------
  const rosterShuffle = await rosterAnon.rpc('get_exam_roster', { p_exam_code: shuffleCode });
  check('38d: get_exam_roster reports shuffle_questions as a boolean',
    typeof rosterShuffle.data?.shuffle_questions === 'boolean',
    JSON.stringify(rosterShuffle.data?.shuffle_questions));
  check('38d: the reported value matches the stored column',
    rosterShuffle.data?.shuffle_questions === true,
    JSON.stringify(rosterShuffle.data?.shuffle_questions));

  // Flip it and re-read: a hard-coded `true` in the projection would pass the
  // check above but fail this one.
  await updateExamMetadata(teacher, shuffleCode, { shuffleQuestions: false });
  const rosterShuffleOff = await rosterAnon.rpc('get_exam_roster', { p_exam_code: shuffleCode });
  check('38d: the flag follows the stored value (not hard-coded true)',
    rosterShuffleOff.data?.shuffle_questions === false,
    JSON.stringify(rosterShuffleOff.data?.shuffle_questions));

  // --- 38e. get_student_exam_payload exposes it (the SPA needs it) ------
  // Without this the SPA cannot honour the toggle at all: this RPC is the only
  // source of `state.exam` for an official sitting.
  await updateExamMetadata(teacher, shuffleCode, {
    isActive: true, shuffleQuestions: false,
  });
  await teacher.from('students').delete().eq('exam_code', shuffleCode);
  await teacher.from('students').insert({
    student_code: 'E2ESHF01', full_name: 'Phan Văn Trộn',
    class_name: '12SHF', exam_code: shuffleCode,
  });
  const shfClient = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const shfAcquire = await shfClient.rpc('verify_and_acquire_session', {
    p_exam_code: shuffleCode,
    p_student_code: 'E2ESHF01',
    p_full_name: 'Phan Văn Trộn',
    p_class_name: '12SHF',
  });
  check('38e: the shuffle fixture session is acquired',
    shfAcquire.data?.success === true, JSON.stringify(shfAcquire.data ?? shfAcquire.error));

  const shfPayload = await shfClient.rpc('get_student_exam_payload', {
    p_exam_code: shuffleCode,
    p_session_token: shfAcquire.data?.session_token,
  });
  check('38e: get_student_exam_payload exposes shuffle_questions = false',
    shfPayload.data?.exam?.shuffle_questions === false,
    JSON.stringify(shfPayload.data?.exam));
  // The sanitisation contract must survive: adding a key must not leak answers.
  check('38e: the payload still leaks no answer key',
    !JSON.stringify(shfPayload.data).includes('correct_answer')
      && !JSON.stringify(shfPayload.data).includes('explanation'),
    JSON.stringify(shfPayload.data).slice(0, 200));

  // get_practice_exam_payload must expose the flag AND keep its existing keys —
  // Step 32c asserts `student_name`, so this guards the other direction of the
  // same edit (a re-created function silently losing a return field).
  await teacher.from('exams').update({ allow_practice: true })
    .eq('code', shuffleCode);
  const shfPractice = await shfClient.rpc('get_practice_exam_payload', {
    p_exam_code: shuffleCode,
    p_student_code: 'E2ESHF01',
  });
  check('38e: get_practice_exam_payload exposes shuffle_questions',
    shfPractice.data?.success === true
      && shfPractice.data?.exam?.shuffle_questions === false,
    JSON.stringify(shfPractice.data));
  check('38e: the practice payload keeps its existing exam keys',
    shfPractice.data?.exam?.total_questions === 2
      && typeof shfPractice.data?.exam?.title === 'string'
      && typeof shfPractice.data?.student_name === 'string',
    JSON.stringify(shfPractice.data?.exam));

  // --- 38f. variant generation groups TRUE_FALSE at the END -------------
  // A pool whose TRUE_FALSE items are deliberately INTERLEAVED, so a plain
  // Fisher-Yates (or a stable partition) would be caught.
  const variantPool = [
    { question_text: 'Q1', question_type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correct_answer: 0, explanation: null },
    { question_text: 'TF-A', question_type: 'TRUE_FALSE', options: ['a', 'b', 'c', 'd'], correct_answer: ['Đ', 'S', 'Đ', 'S'], explanation: null },
    { question_text: 'Q2', question_type: 'MULTIPLE_CHOICE', options: ['A', 'B'], correct_answer: 1, explanation: null },
    { question_text: 'TF-B', question_type: 'TRUE_FALSE', options: ['a', 'b', 'c', 'd'], correct_answer: ['Đ', 'Đ', 'S', 'S'], explanation: null },
    { question_text: 'Q3', question_type: 'SHORT_ANSWER', options: [], correct_answer: 'x', explanation: null },
    { question_text: 'TF-C', question_type: 'TRUE_FALSE', options: ['a', 'b', 'c', 'd'], correct_answer: ['S', 'S', 'Đ', 'Đ'], explanation: null },
  ];
  const tfIndices = (list) => list
    .map((q, i) => (q.question_type === 'TRUE_FALSE' ? i : -1))
    .filter((i) => i >= 0);

  // Every variant must satisfy: min(TF index) > max(non-TF index). Run it many
  // times because the failure is order-dependent, not deterministic.
  let variantOrderViolations = 0;
  let variantsChecked = 0;
  for (let round = 0; round < 25; round++) {
    for (const variant of generateExamVariants(variantPool, { variantCount: 4 })) {
      variantsChecked++;
      const questions = variant.questions;
      const tf = tfIndices(questions);
      const nonTf = questions
        .map((q, i) => (q.question_type === 'TRUE_FALSE' ? -1 : i))
        .filter((i) => i >= 0);
      if (tf.length === 0 || nonTf.length === 0) continue;
      if (Math.min(...tf) <= Math.max(...nonTf)) variantOrderViolations++;
    }
  }
  check('38f: every generated variant puts all TRUE_FALSE after all other types',
    variantsChecked > 0 && variantOrderViolations === 0,
    `checked=${variantsChecked} violations=${variantOrderViolations}`);
  check('38f: variants still carry contiguous 1-based positions',
    generateExamVariants(variantPool, { variantCount: 2 }).every((variant) =>
      variant.questions.every((q, i) => q.position === i + 1)),
    'position renumbering broke');
  check('38f: shufflePartitioned keeps every question exactly once',
    JSON.stringify(shufflePartitioned(variantPool).map((q) => q.question_text).sort())
      === JSON.stringify(variantPool.map((q) => q.question_text).sort()),
    JSON.stringify(shufflePartitioned(variantPool).map((q) => q.question_text)));

  // --- 38g. the SPA partitioner (executed) ------------------------------
  const tfFixture = [
    { position: 1, type: 'MCQ', content: 'q1' },
    { position: 2, type: 'TRUE_FALSE', content: 'tf1' },
    { position: 3, type: 'MCQ', content: 'q2' },
    { position: 4, type: 'ESSAY', content: 'q3' },
    { position: 5, type: 'TRUE_FALSE', content: 'tf2' },
    { position: 6, type: 'SHORT_ANSWER', content: 'q4' },
  ];
  const isTf = (q) => String(q.type || '').toUpperCase() === 'TRUE_FALSE';

  let spaViolations = 0;
  let spaRuns = 0;
  for (let round = 0; round < 60; round++) {
    const out = partitionAndShuffleQuestions(tfFixture, true);
    spaRuns++;
    const tfPos = out.map((q, i) => (isTf(q) ? i : -1)).filter((i) => i >= 0);
    const nonTfPos = out.map((q, i) => (isTf(q) ? -1 : i)).filter((i) => i >= 0);
    if (Math.min(...tfPos) <= Math.max(...nonTfPos)) spaViolations++;
  }
  check('38g: shuffle ON (SPA) always places TRUE_FALSE strictly at the end',
    spaRuns === 60 && spaViolations === 0, `runs=${spaRuns} violations=${spaViolations}`);

  const spaShuffled = partitionAndShuffleQuestions(tfFixture, true);
  check('38g: shuffle ON preserves every question exactly once',
    JSON.stringify([...spaShuffled].map((q) => q.content).sort())
      === JSON.stringify(tfFixture.map((q) => q.content).sort()),
    JSON.stringify(spaShuffled.map((q) => q.content)));
  check('38g: shuffle ON stamps contiguous 1-based displayOrdinal',
    spaShuffled.every((q, i) => q.displayOrdinal === i + 1),
    JSON.stringify(spaShuffled.map((q) => q.displayOrdinal)));
  check('38g: shuffle ON does not mutate the source array',
    JSON.stringify(tfFixture.map((q) => q.position)) === '[1,2,3,4,5,6]');

  // The TRUE_FALSE block is genuinely shuffled WITHIN itself (a stable partition
  // would leave tf1 before tf2 on every single run).
  const tfBlockOrders = new Set();
  for (let round = 0; round < 60; round++) {
    tfBlockOrders.add(
      partitionAndShuffleQuestions(tfFixture, true)
        .filter(isTf).map((q) => q.content).join('|'),
    );
  }
  check('38g: the TRUE_FALSE block is shuffled within itself, not stable',
    tfBlockOrders.size > 1, JSON.stringify([...tfBlockOrders]));

  // --- 38h. shuffle OFF restores the authored order ---------------------
  const spaOrdered = partitionAndShuffleQuestions(tfFixture, false);
  check('38h: shuffle OFF preserves the original position order (TF stays interleaved)',
    JSON.stringify(spaOrdered.map((q) => q.content)) === JSON.stringify(['q1', 'tf1', 'q2', 'q3', 'tf2', 'q4']),
    JSON.stringify(spaOrdered.map((q) => q.content)));
  check('38h: shuffle OFF sorts a scrambled input by position',
    JSON.stringify(
      partitionAndShuffleQuestions([tfFixture[4], tfFixture[0], tfFixture[3]], false)
        .map((q) => q.position),
    ) === '[1,4,5]',
    JSON.stringify(partitionAndShuffleQuestions([tfFixture[4], tfFixture[0], tfFixture[3]], false).map((q) => q.position)));

  // --- 38i. the SPA reads the flag (static) -----------------------------
  const appJs38 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('38i: app.js honours exam.shuffle_questions for the official sitting',
    appJs38.includes('shuffle_questions === false'), 'the toggle is not consulted');
  check('38i: app.js routes the official shuffle through the shared partitioner',
    appJs38.includes('partitionAndShuffleOrder'), 'the partitioned order is not used');
  check('38i: app.js routes practice through partitionAndShuffleQuestions',
    appJs38.includes('partitionAndShuffleQuestions('), 'practice does not partition');
  check('38i: the retired orderPracticeQuestions helper is gone from the SPA',
    !appJs38.includes('orderPracticeQuestions'), 'the superseded helper is still imported');

  // --- 38j. the teacher UI exposes the toggle (static) ------------------
  const previewSrc38 = readFileSync(
    new URL('../web/src/components/questions/ExamPreviewEditor.tsx', import.meta.url), 'utf8',
  );
  const editorSrc38 = readFileSync(
    new URL('../web/src/components/questions/ExamEditor.tsx', import.meta.url), 'utf8',
  );
  check('38j: ExamPreviewEditor ships the shuffle toggle (defaults ON)',
    previewSrc38.includes('shuffleQuestions') && previewSrc38.includes('useState(true)')
      && previewSrc38.includes('Xáo trộn thứ tự câu hỏi'),
    'preview editor toggle missing');
  check('38j: ExamPreviewEditor passes the toggle to both save paths',
    (previewSrc38.match(/shuffleQuestions,/g) || []).length >= 2,
    'the toggle is not forwarded to saveExam/saveExamVariants');
  check('38j: ExamEditor ships the shuffle toggle seeded from the stored row',
    editorSrc38.includes('useState(exam.shuffle_questions)')
      && editorSrc38.includes('shuffleQuestions'),
    'exam editor toggle missing');
  check('38j: ExamEditor persists the toggle through updateExamMetadata',
    /updateExamMetadata\([\s\S]*?shuffleQuestions,/.test(editorSrc38),
    'the editor does not persist the toggle');

  // --- 38k. cleanup -----------------------------------------------------
  await teacher.from('exams').delete().eq('code', shuffleCode);

  /* --- 39. configuration externalization (Phase 9) ---------------------- */
  step(39, 'externalized configuration and modern Supabase key resolution');

  // --- 39a. the teacher web env template documents every variable -------
  // `.env.example` is the only place an operator learns the required set, so a
  // missing key here is a deployment that will fail at runtime. Read the file
  // and require each name to appear as an assignment or a commented example.
  const envExamplePath = new URL('../web/.env.example', import.meta.url);
  check('39a: web/.env.example exists', existsSync(envExamplePath), envExamplePath.pathname);
  const envExample = readFileSync(envExamplePath, 'utf8');
  const REQUIRED_ENV_KEYS = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_EXTRACTOR_API_URL',
    'EXTRACTOR_INTERNAL_SECRET',
    'NEXT_PUBLIC_AI_MODEL_NAME',
    'NEXT_PUBLIC_AI_PROVIDER',
    'NEXT_PUBLIC_STUDENT_APP_URL',
  ];
  const missingEnvKeys = REQUIRED_ENV_KEYS.filter((key) => !envExample.includes(key));
  check('39a: web/.env.example documents every required variable',
    missingEnvKeys.length === 0, `missing: ${missingEnvKeys.join(', ')}`);
  check('39a: web/.env.example carries explanatory comments',
    envExample.split('\n').filter((line) => line.trim().startsWith('#')).length >= 20,
    'too few comments to be a usable template');
  // A secret must never be suggested with the browser-inlining prefix.
  check('39a: web/.env.example never prefixes a secret with NEXT_PUBLIC_',
    !/^NEXT_PUBLIC_(SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|EXTRACTOR_INTERNAL_SECRET)/m
      .test(envExample),
    'a server-only secret is exposed to the browser bundle');

  // --- 39b. the student SPA config template -----------------------------
  const studentExamplePath = new URL('../student/config.example.js', import.meta.url);
  check('39b: student/config.example.js exists',
    existsSync(studentExamplePath), studentExamplePath.pathname);
  const studentExample = readFileSync(studentExamplePath, 'utf8');
  check('39b: it defines window.__APP_CONFIG__',
    studentExample.includes('window.__APP_CONFIG__'), 'the global is missing');
  check('39b: it documents all three config keys',
    ['supabaseUrl', 'supabasePublishableKey', 'workerApiUrl']
      .every((key) => studentExample.includes(key)),
    'a config key is undocumented');
  // The template must be a template: shipping real endpoints would defeat the
  // point of untracking config.js.
  check('39b: the template carries no real project URL or key',
    !/https:\/\/[a-z]{20}\.supabase\.co/.test(studentExample)
      && !/sb_publishable_[A-Za-z0-9_-]{10,}/.test(studentExample),
    'a live endpoint leaked into the template');

  // --- 39c. config.js is untracked and config-load order is correct -----
  // The concrete config names one deployment's project, so it must not be
  // committed; index.html and verify.html must still load it before the module
  // that reads it.
  const studentGitignore = readFileSync(
    new URL('../student/.gitignore', import.meta.url), 'utf8',
  );
  check('39c: student/.gitignore excludes config.js',
    /^config\.js\s*$/m.test(studentGitignore), 'config.js is still committable');
  const indexHtml39 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const verifyHtml39 = readFileSync(new URL('../student/verify.html', import.meta.url), 'utf8');
  check('39c: index.html loads config.js before app.js',
    indexHtml39.indexOf('src="./config.js"') !== -1
      && indexHtml39.indexOf('src="./config.js"') < indexHtml39.indexOf('src="./app.js"'),
    'config.js is not loaded first');
  check('39c: verify.html loads config.js before its module script',
    verifyHtml39.indexOf('src="./config.js"') !== -1
      && verifyHtml39.indexOf('src="./config.js"') < verifyHtml39.indexOf('type="module"'),
    'config.js is not loaded first');

  // --- 39d. the SPA reads ONLY __APP_CONFIG__ ---------------------------
  const appJs39 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('39d: app.js reads window.__APP_CONFIG__',
    appJs39.includes('window.__APP_CONFIG__'), 'the new global is not read');
  check('39d: app.js declares no legacy config read',
    !appJs39.includes('window.APP_CONFIG') && !appJs39.includes('window.WORKER_API_URL'),
    'a legacy global is still consulted');
  check('39d: app.js hardcodes no development URL',
    !appJs39.includes('127.0.0.1:8787') && !appJs39.includes('localhost:8787')
      && !appJs39.includes('workers.dev'),
    'a private development endpoint is baked into the bundle');
  check('39d: app.js resolves config through the shared module',
    appJs39.includes("from './app-config.js'"), 'app-config.js is not imported');

  // --- 39e. the SPA resolvers behave (executed) -------------------------
  // Trailing slashes are the defect this guards: both values are concatenated
  // with a leading '/', so a trailing slash silently doubles the separator.
  check('39e: stripTrailingSlashes removes one or many trailing slashes',
    stripTrailingSlashes('https://host///') === 'https://host'
      && stripTrailingSlashes('https://host/') === 'https://host'
      && stripTrailingSlashes('https://host') === 'https://host',
    stripTrailingSlashes('https://host///'));

  const supabaseConfig = resolveSupabaseConfig({
    supabaseUrl: 'https://example.supabase.co/',
    supabasePublishableKey: '  sb_publishable_abc  ',
  });
  check('39e: resolveSupabaseConfig strips the URL and trims the key',
    supabaseConfig.url === 'https://example.supabase.co'
      && supabaseConfig.key === 'sb_publishable_abc'
      && supabaseConfig.configured === true,
    JSON.stringify(supabaseConfig));
  check('39e: resolveSupabaseConfig accepts the legacy anon-key name',
    resolveSupabaseConfig({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'legacy-anon',
    }).key === 'legacy-anon',
    'the anon-key alias is not resolved');
  check('39e: resolveSupabaseConfig reports an unconfigured deployment',
    resolveSupabaseConfig({}).configured === false
      && resolveSupabaseConfig({ supabaseUrl: 'https://x.supabase.co' }).configured === false,
    'a partial config reported as configured');

  // WORKER_BASE_URL resolution + trailing-slash stripping.
  check('39e: resolveWorkerBaseUrl strips trailing slashes from the origin',
    resolveWorkerBaseUrl({ workerApiUrl: 'https://worker.example.workers.dev///' })
      === 'https://worker.example.workers.dev',
    resolveWorkerBaseUrl({ workerApiUrl: 'https://worker.example.workers.dev///' }));
  check('39e: resolveWorkerBaseUrl strips the full practice endpoint path',
    resolveWorkerBaseUrl({
      workerApiUrl: 'https://worker.example.workers.dev/api/v1/extract-practice/',
    }) === 'https://worker.example.workers.dev',
    'the endpoint path survived, so the caller would build a doubled path');
  check('39e: resolveWorkerBaseUrl is empty when unconfigured',
    resolveWorkerBaseUrl({}) === '' && resolveWorkerBaseUrl({ workerApiUrl: '   ' }) === '',
    'an unconfigured Worker did not resolve to empty');
  // The built endpoint the SPA actually issues must have exactly one separator.
  const builtEndpoint = `${resolveWorkerBaseUrl({
    workerApiUrl: 'https://worker.example.workers.dev/',
  })}/api/v1/extract-practice`;
  check('39e: the built practice endpoint has no doubled separator',
    builtEndpoint === 'https://worker.example.workers.dev/api/v1/extract-practice',
    builtEndpoint);

  // --- 39f. the web env resolvers accept BOTH key schemes ---------------
  const ENV_NAMES = [
    'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_AI_MODEL_NAME', 'AI_MODEL_NAME',
    'NEXT_PUBLIC_AI_PROVIDER', 'AI_PROVIDER',
    'NEXT_PUBLIC_STUDENT_APP_URL',
    'NEXT_PUBLIC_EXTRACTOR_API_URL', 'EXTRACTOR_INTERNAL_SECRET',
  ];
  // Snapshot so the suite leaves the process environment as it found it.
  const envBackup = {};
  for (const name of ENV_NAMES) envBackup[name] = process.env[name];
  const setEnv = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const clearEnv = () => ENV_NAMES.forEach((name) => setEnv(name, undefined));

  try {
    clearEnv();
    // Modern names only.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://modern.supabase.co/';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_modern';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_modern';
    check('39f: the URL resolver strips a trailing slash',
      getSupabaseUrl() === 'https://modern.supabase.co', getSupabaseUrl());
    check('39f: the publishable resolver prefers the modern key',
      getSupabasePublishableKey() === 'sb_publishable_modern', getSupabasePublishableKey());
    check('39f: the secret resolver reads the modern secret key',
      getSupabaseSecretKey() === 'sb_secret_modern', getSupabaseSecretKey());

    // Legacy names only — the whole point of the fallback chain.
    clearEnv();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://legacy.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'legacy-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role';
    check('39f: the publishable resolver falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY',
      getSupabasePublishableKey() === 'legacy-anon-key', getSupabasePublishableKey());
    check('39f: the secret resolver falls back to SUPABASE_SERVICE_ROLE_KEY',
      getSupabaseSecretKey() === 'legacy-service-role', getSupabaseSecretKey());

    // Both present: the modern name must win, not merely work.
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_wins';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_wins';
    check('39f: the modern publishable key wins over the legacy anon key',
      getSupabasePublishableKey() === 'sb_publishable_wins', getSupabasePublishableKey());
    check('39f: the modern secret key wins over the legacy service role key',
      getSupabaseSecretKey() === 'sb_secret_wins', getSupabaseSecretKey());

    // A blank value is not a value: it must fall through, not resolve to ''.
    clearEnv();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://blank.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '   ';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon';
    check('39f: a blank preferred key falls through to the fallback',
      getSupabasePublishableKey() === 'real-anon', JSON.stringify(getSupabasePublishableKey()));

    // Fully unconfigured: every resolver must throw with an actionable message
    // rather than handing `undefined` to a client constructor.
    clearEnv();
    const throwsWith = (fn) => {
      try {
        fn();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const urlError = throwsWith(getSupabaseUrl);
    const keyError = throwsWith(getSupabasePublishableKey);
    const secretError = throwsWith(getSupabaseSecretKey);
    check('39f: an unconfigured Supabase URL throws',
      typeof urlError === 'string' && urlError.includes('.env.example'), String(urlError));
    check('39f: an unconfigured publishable key throws',
      typeof keyError === 'string' && keyError.includes('.env.example'), String(keyError));
    check('39f: an unconfigured secret key throws',
      typeof secretError === 'string' && secretError.includes('.env.example'), String(secretError));

    // --- 39g. AI model configuration ------------------------------------
    clearEnv();
    check('39g: the AI model is null when unset (the Worker then decides)',
      getAiModelName() === null, JSON.stringify(getAiModelName()));
    check('39g: the AI provider defaults to gemini',
      getAiProvider() === 'gemini', getAiProvider());
    check('39g: the default model option carries an EMPTY value',
      buildModelOptions()[0].value === '', JSON.stringify(buildModelOptions()[0]));
    check('39g: with no model configured the default label is generic',
      buildModelOptions()[0].label === 'Mặc định hệ thống', buildModelOptions()[0].label);
    check('39g: the gemini shortlist is offered without configuration',
      buildModelOptions().length === 4, String(buildModelOptions().length));

    process.env.NEXT_PUBLIC_AI_MODEL_NAME = 'gemini-9-experimental';
    process.env.NEXT_PUBLIC_AI_PROVIDER = 'GEMINI';
    check('39g: the env model reaches the picker label',
      buildModelOptions()[0].label === 'Mặc định hệ thống (gemini-9-experimental)',
      buildModelOptions()[0].label);
    check('39g: the provider id is lower-cased before comparison',
      buildModelOptions().length === 4, String(buildModelOptions().length));

    // An unknown provider must not advertise a shortlist it cannot call, but
    // the default option (the Worker's own model) always survives.
    process.env.NEXT_PUBLIC_AI_PROVIDER = 'some-other-vendor';
    check('39g: an unknown provider drops the gemini shortlist',
      buildModelOptions().length === 1 && buildModelOptions()[0].value === '',
      JSON.stringify(buildModelOptions()));
    check('39g: the custom-model sentinel is still exported',
      CUSTOM_MODEL === '__custom__', CUSTOM_MODEL);

    // --- 39h. deep links + extractor endpoints ---------------------------
    clearEnv();
    check('39h: the student app base is empty with no window and no config',
      resolveStudentAppBaseUrl() === '', resolveStudentAppBaseUrl());
    process.env.NEXT_PUBLIC_STUDENT_APP_URL = 'https://student.example.pages.dev/';
    check('39h: the student app base strips a trailing slash',
      resolveStudentAppBaseUrl() === 'https://student.example.pages.dev',
      resolveStudentAppBaseUrl());

    check('39h: the extractor endpoint is null when unset',
      getExtractorEndpoint() === null, String(getExtractorEndpoint()));
    process.env.NEXT_PUBLIC_EXTRACTOR_API_URL = 'http://localhost:8787/api/v1/extract/';
    check('39h: the extractor endpoint strips a trailing slash',
      getExtractorEndpoint() === 'http://localhost:8787/api/v1/extract',
      String(getExtractorEndpoint()));
    check('39h: the internal secret is null when unset',
      getExtractorInternalSecret() === null, String(getExtractorInternalSecret()));
    process.env.EXTRACTOR_INTERNAL_SECRET = 'shared-secret';
    check('39h: the internal secret is read when set',
      getExtractorInternalSecret() === 'shared-secret', String(getExtractorInternalSecret()));
  } finally {
    for (const name of ENV_NAMES) setEnv(name, envBackup[name]);
  }

  // --- 39i. the web call sites go through the resolvers (static) --------
  // Importing `lib/env.ts` proves the resolvers work; these checks prove the
  // app actually USES them, so `process.env` reads cannot creep back in.
  const clientSrc39 = readFileSync(
    new URL('../web/src/lib/supabase/client.ts', import.meta.url), 'utf8',
  );
  const serverSrc39 = readFileSync(
    new URL('../web/src/lib/supabase/server.ts', import.meta.url), 'utf8',
  );
  const sessionSrc39 = readFileSync(
    new URL('../web/src/lib/supabase/session.ts', import.meta.url), 'utf8',
  );
  check('39i: all three Supabase clients resolve through lib/env.ts',
    [clientSrc39, serverSrc39, sessionSrc39].every((src) => src.includes("from '../env'")),
    'a client still reads process.env directly');
  check('39i: no Supabase client reads process.env anymore',
    [clientSrc39, serverSrc39, sessionSrc39].every((src) => !src.includes('process.env')),
    'a raw process.env lookup survived');
  const routeSrc39 = readFileSync(
    new URL('../web/src/app/api/extract/route.ts', import.meta.url), 'utf8',
  );
  check('39i: the extract proxy resolves its endpoint and secret through lib/env.ts',
    routeSrc39.includes('getExtractorEndpoint') && routeSrc39.includes('getExtractorInternalSecret')
      && !routeSrc39.includes('process.env'),
    'the proxy still reads process.env');
  const shareSrc39 = readFileSync(
    new URL('../web/src/components/ExamShareModal.tsx', import.meta.url), 'utf8',
  );
  const projectorSrc39 = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8',
  );
  check('39i: both deep-link builders use the shared student-base resolver',
    shareSrc39.includes('resolveStudentAppBaseUrl')
      && projectorSrc39.includes('resolveStudentAppBaseUrl')
      && !shareSrc39.includes('process.env')
      && !projectorSrc39.includes('process.env'),
    'a link builder still reads process.env');
  const uploadSrc39 = readFileSync(
    new URL('../web/src/components/UploadZone.tsx', import.meta.url), 'utf8',
  );
  check('39i: the upload UI builds its model list from lib/ai.ts',
    uploadSrc39.includes('buildModelOptions') && !uploadSrc39.includes('MODEL_OPTIONS'),
    'the hardcoded model list survived');

  // --- 39j. the Worker reads its model + origins from bindings ----------
  const workerSrc39 = readFileSync(new URL('../worker/src/index.ts', import.meta.url), 'utf8');
  check('39j: the Worker resolves its model from env.AI_MODEL_NAME',
    workerSrc39.includes('env.AI_MODEL_NAME'), 'the new binding is not read');
  check('39j: the Worker resolves CORS origins from env.ALLOWED_ORIGINS',
    workerSrc39.includes('env.ALLOWED_ORIGINS'), 'the origins binding is not read');
  check('39j: the Worker no longer hardcodes a wildcard CORS origin',
    !workerSrc39.includes("cors()") && workerSrc39.includes('corsOptions(c.env)'),
    'the CORS middleware still uses the default wildcard');
  const wranglerToml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  check('39j: wrangler.toml [vars] declares AI_MODEL_NAME',
    /^AI_MODEL_NAME\s*=\s*"[^"]+"/m.test(wranglerToml), 'the var is missing');
  check('39j: wrangler.toml [vars] declares ALLOWED_ORIGINS',
    /^ALLOWED_ORIGINS\s*=\s*"[^"]+"/m.test(wranglerToml), 'the var is missing');
  const devVarsPath = new URL('../worker/.dev.vars.example', import.meta.url);
  check('39j: worker/.dev.vars.example exists', existsSync(devVarsPath), devVarsPath.pathname);
  const devVars = readFileSync(devVarsPath, 'utf8');
  check('39j: .dev.vars.example declares both worker secrets',
    devVars.includes('GEMINI_API_KEY') && devVars.includes('INTERNAL_SECRET'),
    'a required local secret is undocumented');

  // --- 39k. the resolved bindings actually drive the Worker -------------
  // Executed rather than inspected: a GET / must carry the configured origin,
  // and the allow-list branch must refuse an origin that is not on it.
  const corsProbe = async (env, origin) => {
    const response = await workerApp.fetch(
      new Request('http://localhost/health', { headers: { Origin: origin } }),
      env,
    );
    return response.headers.get('Access-Control-Allow-Origin');
  };
  check('39k: a wildcard binding echoes * for any origin',
    await corsProbe({ ALLOWED_ORIGINS: '*' }, 'https://any.example') === '*',
    String(await corsProbe({ ALLOWED_ORIGINS: '*' }, 'https://any.example')));
  check('39k: an unset binding still defaults to *',
    await corsProbe({}, 'https://any.example') === '*',
    String(await corsProbe({}, 'https://any.example')));
  check('39k: an allow-list admits a listed origin',
    await corsProbe({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' }, 'https://b.example')
      === 'https://b.example',
    String(await corsProbe(
      { ALLOWED_ORIGINS: 'https://a.example, https://b.example' }, 'https://b.example')));
  check('39k: an allow-list omits the header for an unlisted origin',
    await corsProbe({ ALLOWED_ORIGINS: 'https://a.example' }, 'https://evil.example') === null,
    String(await corsProbe({ ALLOWED_ORIGINS: 'https://a.example' }, 'https://evil.example')));
  check('39k: a blank binding falls back to * rather than blocking everyone',
    await corsProbe({ ALLOWED_ORIGINS: '   ' }, 'https://any.example') === '*',
    String(await corsProbe({ ALLOWED_ORIGINS: '   ' }, 'https://any.example')));

  // The model binding must be consumed, not merely declared: the Worker echoes
  // the effective model in `meta.model_used`, which is the observable proof.
  const aiEnvProbe = async (env, requestedModel) => {
    const form = new FormData();
    form.append('file', new Blob([mismatched]), 'mismatched.docx');
    const query = requestedModel ? `&model=${requestedModel}` : '';
    const response = await workerApp.fetch(
      new Request(`http://localhost/api/v1/extract?mode=ai${query}`, { method: 'POST', body: form }),
      { GEMINI_API_KEY: 'e2e-stub-key', ...env },
    );
    return (await response.json()).meta?.model_used;
  };
  // `mismatched` is the fixture the AI-fallback step already proved reachable;
  // its fetch stub is restored by then, so the outgoing Gemini call is stubbed
  // again here purely to read the model the Worker chose.
  const realFetch39 = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch39(input, init);
  };
  try {
    check('39k: the Worker reports the AI_MODEL_NAME binding as the model used',
      await aiEnvProbe({ AI_MODEL_NAME: 'gemini-e2e-binding' }) === 'gemini-e2e-binding',
      String(await aiEnvProbe({ AI_MODEL_NAME: 'gemini-e2e-binding' })));
    check('39k: a caller-supplied ?model= outranks the binding',
      await aiEnvProbe({ AI_MODEL_NAME: 'gemini-e2e-binding' }, 'gemini-e2e-requested')
        === 'gemini-e2e-requested',
      String(await aiEnvProbe({ AI_MODEL_NAME: 'gemini-e2e-binding' }, 'gemini-e2e-requested')));
    check('39k: the legacy DEFAULT_AI_MODEL name is still honoured',
      await aiEnvProbe({ DEFAULT_AI_MODEL: 'gemini-e2e-legacy' }) === 'gemini-e2e-legacy',
      String(await aiEnvProbe({ DEFAULT_AI_MODEL: 'gemini-e2e-legacy' })));
    check('39k: AI_MODEL_NAME outranks the legacy DEFAULT_AI_MODEL',
      await aiEnvProbe({
        AI_MODEL_NAME: 'gemini-e2e-new', DEFAULT_AI_MODEL: 'gemini-e2e-old',
      }) === 'gemini-e2e-new',
      'the legacy name is winning over the current one');
    check('39k: a blank binding falls through to the built-in default',
      await aiEnvProbe({ AI_MODEL_NAME: '   ' }) === 'gemini-3.5-flash-lite',
      String(await aiEnvProbe({ AI_MODEL_NAME: '   ' })));
  } finally {
    globalThis.fetch = realFetch39;
  }

  /* --- 40. top-first exam code entry + flexible candidate lookup (8.8) -- */
  step(40, 'top-first exam code entry, progressive roster picker, dual-auth fallback');

  // --- 40a. the official form puts the exam code FIRST -------------------
  // Order is asserted on the RAW STRING INDEX, not on a parsed DOM: there is no
  // HTML parser in this toolchain, and `indexOf` is exactly the question being
  // asked ("does the code input physically precede the identity fields?").
  const indexHtml40 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const loginForm40 = indexHtml40.slice(
    indexHtml40.indexOf('id="loginForm"'),
    indexHtml40.indexOf('id="practicePanel"'),
  );
  const posExamCode = loginForm40.indexOf('id="exam-code"');
  const posClass = loginForm40.indexOf('id="class-select"');
  const posName = loginForm40.indexOf('id="student-select"');
  const posManualClass = loginForm40.indexOf('id="class-name-input"');
  const posManualName = loginForm40.indexOf('id="student-name-input"');
  check('40a: the exam-code input renders before the class picker',
    posExamCode !== -1 && posClass !== -1 && posExamCode < posClass,
    `exam-code@${posExamCode} class-select@${posClass}`);
  check('40a: the exam-code input renders before the name picker',
    posExamCode !== -1 && posName !== -1 && posExamCode < posName,
    `exam-code@${posExamCode} student-select@${posName}`);
  check('40a: the exam-code input renders before the manual identity fields',
    posExamCode < posManualClass && posExamCode < posManualName,
    `exam-code@${posExamCode} manual@${posManualClass}/${posManualName}`);
  check('40a: the exam code is the FIRST control of the official form',
    posExamCode !== -1
      && posExamCode < loginForm40.indexOf('type="submit"'),
    'the code is not the first field');

  // The banner + verify button are what make the code-first flow usable.
  check('40a: the exam meta banner exists with both slots',
    loginForm40.includes('id="examMetaBanner"')
      && loginForm40.includes('id="examMetaTitle"')
      && loginForm40.includes('id="examMetaStatus"'),
    'banner markup missing');
  check('40a: it has an explicit "Kiểm tra đề" trigger',
    loginForm40.includes('id="btnVerifyExamCode"'), 'verify button missing');
  check('40a: the PIN label and hint are addressable for the dynamic rewrite',
    loginForm40.includes('id="labelStudentPin"') && loginForm40.includes('id="hintStudentPin"'),
    'PIN label/hint ids missing');

  // --- 40b. the practice panel is likewise top-first --------------------
  const practicePanel40 = indexHtml40.slice(indexHtml40.indexOf('id="practicePanel"'));
  check('40b: the practice exam code renders before the practice class field',
    practicePanel40.indexOf('id="practice-exam-code"') !== -1
      && practicePanel40.indexOf('id="practice-exam-code"')
        < practicePanel40.indexOf('id="practiceClassName"'),
    `code@${practicePanel40.indexOf('id="practice-exam-code"')} class@${practicePanel40.indexOf('id="practiceClassName"')}`);
  check('40b: the practice exam code renders before the practice name field',
    practicePanel40.indexOf('id="practice-exam-code"')
      < practicePanel40.indexOf('id="practiceStudentName"'),
    'practice code is not first');

  // --- 40c. readIdentity no longer REQUIRES a roster --------------------
  // The behaviour that makes a failed roster fetch survivable: the manual branch
  // must not return an error just because `state.roster` is empty.
  const appSrc40 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  const readIdentityBody = appSrc40.slice(
    appSrc40.indexOf('function readIdentity()'),
    appSrc40.indexOf('async function handleLoginSubmit'),
  );
  check('40c: readIdentity no longer blocks on a missing roster',
    !readIdentityBody.includes('danh sách dự thi nên không thể xác minh'),
    'the empty-roster hard block survived');
  check('40c: readIdentity tolerates a null roster when matching',
    readIdentityBody.includes('(state.roster || [])'), 'the roster is dereferenced unsafely');
  check('40c: readIdentity sends a null code when nothing matched',
    readIdentityBody.includes('match ? match.student_code : null'),
    'a missing match does not degrade to a null code');

  // --- 40d. normalizeText -----------------------------------------------
  // Executed, not inspected: the function is pure and DOM-free, so the suite can
  // evaluate the shipped definition directly.
  const normalizeTextSrc = appSrc40.slice(
    appSrc40.indexOf('function normalizeText'),
    appSrc40.indexOf('/* =====', appSrc40.indexOf('function normalizeText')),
  );
  const normalizeText = new Function(`${normalizeTextSrc}; return normalizeText;`)();
  check('40d: normalizeText trims and lower-cases',
    normalizeText('  Nguyễn Văn A  ') === 'nguyễn văn a', normalizeText('  Nguyễn Văn A  '));
  check('40d: normalizeText collapses internal whitespace',
    normalizeText('Nguyễn   Văn\tA') === 'nguyễn văn a', normalizeText('Nguyễn   Văn\tA'));
  // The whole reason for NFC: a decomposed Vietnamese name must equal the same
  // name in composed form. The decomposed form is DERIVED with `normalize('NFD')`
  // rather than hand-written, so the test cannot itself be wrong about which
  // combining marks a given glyph decomposes into.
  const composed = 'Nguyễn';
  const decomposed = composed.normalize('NFD');
  check('40d: the NFC fixture is meaningful (composed and decomposed really differ)',
    composed !== decomposed, 'the two forms are identical, so the next check is vacuous');
  check('40d: normalizeText unifies NFC-composed and decomposed diacritics',
    normalizeText(composed) === normalizeText(decomposed),
    `${normalizeText(composed)} vs ${normalizeText(decomposed)}`);
  check('40d: normalizeText maps every falsy input to an empty string',
    normalizeText('') === '' && normalizeText(null) === '' && normalizeText(undefined) === '',
    'a falsy input did not resolve to empty');

  // --- 40e. the SQL lookup is normalized on BOTH sides ------------------
  // The client normalizes; the server must too, or a double space typed by the
  // student would still fail. Asserted on the function source because the
  // comparison is an authentication decision worth pinning.
  const schemaSrc40 = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const verifySrc40 = schemaSrc40.slice(
    schemaSrc40.indexOf('create or replace function public.verify_and_acquire_session'),
    schemaSrc40.indexOf('-- C.2  record_student_heartbeat'),
  );
  check('40e: the RPC normalizes the supplied name and class',
    verifySrc40.includes("v_name  := nullif(lower(regexp_replace(trim(coalesce(p_full_name, '')), '\\s+', ' ', 'g')), '')")
      && verifySrc40.includes("v_class := nullif(lower(regexp_replace(trim(coalesce(p_class_name, '')), '\\s+', ' ', 'g')), '')"),
    'the inputs are not normalized');
  check('40e: the RPC normalizes the stored row before comparing',
    verifySrc40.includes("lower(regexp_replace(trim(s.full_name),  '\\s+', ' ', 'g')) = v_name")
      && verifySrc40.includes("lower(regexp_replace(trim(s.class_name), '\\s+', ' ', 'g')) = v_class"),
    'the stored side is not normalized');
  check('40e: the code is a fast path and the name+class pair the fallback',
    verifySrc40.includes('if v_code is not null then')
      && verifySrc40.includes('elsif v_name is not null and v_class is not null then'),
    'the two lookup strategies are not both present');
  check('40e: a blank/whitespace code degrades to the fallback (nullif)',
    verifySrc40.includes("v_code  := nullif(lower(trim(coalesce(p_student_code, ''))), '')"),
    'a blank code would be treated as a real code');

  // --- 40f. every security guard survived the rewrite -------------------
  // The rewrite touched a SECURITY DEFINER authentication path, so the guards
  // that existed before it are re-asserted explicitly.
  check('40f: the duplicate-submission guard is keyed on the RESOLVED code',
    verifySrc40.includes('exam_code = p_exam_code and student_code = v_student.student_code'),
    'the ALREADY_SUBMITTED probe uses the caller-supplied code');
  check('40f: the single-device lock is keyed on the RESOLVED code',
    verifySrc40.includes('and student_code = v_student.student_code')
      && verifySrc40.includes('for update'),
    'the session lock uses the caller-supplied code');
  check('40f: the PIN gate still fails closed via is distinct from',
    (verifySrc40.match(/is distinct from/g) || []).length >= 3,
    'a fail-closed PIN comparison was lost');
  check('40f: the F5 token-resume tolerance survived',
    verifySrc40.includes('p_existing_token = v_session.session_token'), 'token resume removed');
  check('40f: the 60-second stale-session takeover survived',
    verifySrc40.includes("interval '60 seconds'"), 'stale takeover removed');
  check('40f: the function is still SECURITY DEFINER with a pinned search_path',
    verifySrc40.includes('security definer') && verifySrc40.includes('set search_path = public, pg_temp'),
    'security context changed');

  // --- 40g. the resolved identity is echoed back (live, against the DB) ---
  // Exercised end to end: seed a candidate whose stored name has EXTRA whitespace
  // and a mixed-case class, then log in with a differently-cased, differently-
  // spaced typing of the same identity and NO student code. This is the exact
  // scenario the migration exists for.
  const FLEX_EXAM = {
    code: 'FLX' + String(Math.floor(100 + Math.random() * 900)),
    title: 'E2E Flexible Lookup',
    duration: 25,
  };
  const FLEX_CLASS_STORED = 'e2e-flex-' + String(Math.floor(1000 + Math.random() * 9000));
  const FLEX_MEMBER = {
    code: 'E2EFLX01',
    // Deliberately messy on the STORED side: doubled spaces in both fields.
    fullNameStored: 'Nguyễn  Văn   Linh',
    classNameStored: FLEX_CLASS_STORED.toUpperCase() + '  X',
  };
  const flex40Anon = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const flexAdmin = createClient(SB_URL, SB_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await teacher.from('exams').delete().eq('code', FLEX_EXAM.code);
  const flexExamInsert = await teacher.from('exams').insert({
    user_id: teacherId,
    code: FLEX_EXAM.code,
    title: FLEX_EXAM.title,
    duration_minutes: FLEX_EXAM.duration,
    is_active: true,
    pin_mode: 'NONE',
  });
  check('40g: flexible-lookup exam created', !flexExamInsert.error, flexExamInsert.error?.message);
  await teacher.from('students').insert({
    exam_code: FLEX_EXAM.code,
    student_code: FLEX_MEMBER.code,
    full_name: FLEX_MEMBER.fullNameStored,
    class_name: FLEX_MEMBER.classNameStored,
  });

  const tryFlexLogin = async (overrides) => {
    await flexAdmin.from('active_sessions').delete()
      .eq('exam_code', FLEX_EXAM.code).eq('student_code', FLEX_MEMBER.code);
    return flex40Anon.rpc('verify_and_acquire_session', {
      p_exam_code: FLEX_EXAM.code,
      p_student_code: null,
      p_full_name: null,
      p_class_name: null,
      p_device_info: 'e2e-flex/1.0',
      p_existing_token: null,
      p_pin: null,
      ...overrides,
    });
  };

  // The core case: no code, and the typed identity differs only in case and
  // whitespace from what is stored.
  const flexTyped = await tryFlexLogin({
    p_full_name: '  nguyễn văn linh ',
    p_class_name: `${FLEX_CLASS_STORED.toLowerCase()} x`,
  });
  check('40g: a NULL student code authenticates via the (class, name) fallback',
    flexTyped.data?.success === true, JSON.stringify(flexTyped.data));
  check('40g: it resolves the roster row despite case + whitespace differences',
    flexTyped.data?.student_code === FLEX_MEMBER.code, String(flexTyped.data?.student_code));
  check('40g: it echoes the CANONICAL stored identity, not the typed one',
    flexTyped.data?.student_name === FLEX_MEMBER.fullNameStored
      && flexTyped.data?.class_name === FLEX_MEMBER.classNameStored,
    JSON.stringify({ name: flexTyped.data?.student_name, cls: flexTyped.data?.class_name }));
  // The banner + session metadata the SPA needs from this one round-trip.
  check('40g: it returns exam_title for the banner',
    flexTyped.data?.exam_title === FLEX_EXAM.title, String(flexTyped.data?.exam_title));
  check('40g: it returns duration_minutes for the banner',
    Number(flexTyped.data?.duration_minutes) === FLEX_EXAM.duration,
    String(flexTyped.data?.duration_minutes));
  check('40g: it returns shuffle_questions so the sitting can honour the toggle',
    typeof flexTyped.data?.shuffle_questions === 'boolean',
    String(flexTyped.data?.shuffle_questions));

  // A whitespace-only code must behave identically to NULL (the `nullif` path).
  const flexBlankCode = await tryFlexLogin({
    p_student_code: '   ',
    p_full_name: 'Nguyễn Văn Linh',
    p_class_name: `${FLEX_CLASS_STORED} X`,
  });
  check('40g: a whitespace-only student code degrades to the fallback',
    flexBlankCode.data?.success === true && flexBlankCode.data?.student_code === FLEX_MEMBER.code,
    JSON.stringify(flexBlankCode.data));

  // The code fast path still works and is still dominant when both are sent.
  const flexByCode = await tryFlexLogin({
    p_student_code: FLEX_MEMBER.code,
    p_full_name: 'Nguyễn Văn Linh',
    p_class_name: `${FLEX_CLASS_STORED} X`,
  });
  check('40g: supplying the code still works (fast path)',
    flexByCode.data?.success === true && flexByCode.data?.student_code === FLEX_MEMBER.code,
    JSON.stringify(flexByCode.data));

  // A wrong NAME with a correct code must still be refused: the code alone must
  // never seat someone under another candidate's identity.
  const flexWrongName = await tryFlexLogin({
    p_student_code: FLEX_MEMBER.code,
    p_full_name: 'Kẻ Mạo Danh',
    p_class_name: `${FLEX_CLASS_STORED} X`,
  });
  check('40g: a correct code with the wrong name is still refused',
    flexWrongName.data?.success === false && flexWrongName.data?.message === 'IDENTITY_MISMATCH',
    JSON.stringify(flexWrongName.data));

  // An unknown identity must NOT be admitted, and must not leak which half was
  // wrong.
  const flexUnknown = await tryFlexLogin({
    p_full_name: 'Người Không Có Trong Danh Sách',
    p_class_name: FLEX_CLASS_STORED,
  });
  check('40g: an unknown (class, name) pair is refused',
    flexUnknown.data?.success === false
      && flexUnknown.data?.message === 'STUDENT_NOT_WHITELISTED',
    JSON.stringify(flexUnknown.data));
  check('40g: neither identity input alone is enough',
    (await tryFlexLogin({ p_full_name: 'Nguyễn Văn Linh' })).data?.success === false
      && (await tryFlexLogin({ p_class_name: `${FLEX_CLASS_STORED} X` })).data?.success === false,
    'a half-supplied identity was admitted');

  // A wrong class with the right name must also fail (the pair is the key).
  const flexWrongClass = await tryFlexLogin({
    p_full_name: 'Nguyễn Văn Linh',
    p_class_name: 'LỚP-KHÔNG-ĐÚNG',
  });
  check('40g: a correct name with the wrong class is refused',
    flexWrongClass.data?.success === false, JSON.stringify(flexWrongClass.data));

  // --- 40h. the roster reports duration_minutes for the banner ----------
  const flexRoster = await flex40Anon.rpc('get_exam_roster', { p_exam_code: FLEX_EXAM.code });
  check('40h: get_exam_roster still succeeds', flexRoster.data?.success === true,
    JSON.stringify(flexRoster.data));
  check('40h: get_exam_roster now exposes duration_minutes for the banner',
    Number(flexRoster.data?.duration_minutes) === FLEX_EXAM.duration,
    String(flexRoster.data?.duration_minutes));
  check('40h: the candidate projection still leaks neither pin nor dob',
    Array.isArray(flexRoster.data?.candidates)
      && flexRoster.data.candidates.every((c) => !('pin' in c) && !('dob' in c)),
    JSON.stringify(flexRoster.data?.candidates));

  // --- 40i. the SPA is wired to the resolved identity -------------------
  check('40i: the login submit sends NULL rather than an empty code',
    appSrc40.includes('p_student_code: state.studentCode || null'),
    'an empty string could be sent as the code');
  check('40i: the SPA adopts the server-resolved identity after login',
    appSrc40.includes('if (payload.student_code) state.studentCode = String(payload.student_code);'),
    'the resolved code is not kept for later RPCs');
  check('40i: the login completeness check no longer demands a student code',
    !appSrc40.includes('Mã đề, Mã học sinh, Họ tên và Lớp'),
    'the old code-required message survived');
  // Both the SPA matcher and the practice matcher must use the same normalizer.
  check('40i: the practice candidate matcher uses normalizeText',
    appSrc40.slice(appSrc40.indexOf('function matchPracticeCandidate'))
      .includes('normalizeText(row.class_name)'),
    'the practice matcher still compares raw strings');
  check('40i: the exam code can be verified via the explicit button',
    appSrc40.includes("$('btnVerifyExamCode')"), 'the verify button is not wired');
  check('40i: the exam banner is rendered from the roster payload',
    appSrc40.includes('renderExamBanner(payload)'), 'the banner is never shown');

  // --- 40l. cleanup -----------------------------------------------------
  await teacher.from('exams').delete().eq('code', FLEX_EXAM.code); // cascades

  /* --- 41. Class-gated .docx self-practice (Phase 8.9) ------------------ */
  // The .docx path is now authorised against the CLASS roster (classes +
  // class_members) instead of the exam whitelist, and the owning teacher can
  // suspend it per class via `classes.allow_practice`. This step walks every
  // branch of the new contract plus the pick-list RPC the SPA fills from.
  step(41, 'class-gated DOCX self-practice with teacher permission toggle');

  // --- 41a. the column itself -------------------------------------------
  // `not null default true` backfills in a single pass, so an existing class
  // can never be left with a NULL permission.
  const gateColumn = step32Sql(
    `select is_nullable || '|' || coalesce(column_default, '') `
    + `from information_schema.columns where table_schema = 'public' `
    + `and table_name = 'classes' and column_name = 'allow_practice'`,
  );
  check('41a: classes.allow_practice is NOT NULL', gateColumn.startsWith('NO|'), gateColumn);
  check('41a: classes.allow_practice defaults to true', gateColumn === 'NO|true', gateColumn);

  // --- 41b. enable branch ------------------------------------------------
  // Deliberately omits `allow_practice` on insert: the DB default must supply
  // it, which is exactly what the teacher-web create modal relies on.
  const GATE_CLASS = 'E2E-10A1-' + String(Math.floor(1000 + Math.random() * 9000));
  const GATE_MEMBER = { code: 'E2E10A1', fullName: 'Nguyễn Văn Mười' };

  const gateInsert = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: GATE_CLASS, academic_year: '2026-2027' })
    .select('id, allow_practice')
    .single();
  check('41b: a new class defaults to allow_practice = true',
    !gateInsert.error && gateInsert.data?.allow_practice === true,
    gateInsert.error?.message ?? JSON.stringify(gateInsert.data));
  const gateClassId = gateInsert.data?.id;

  const gateMembers = await teacher.from('class_members').insert({
    class_id: gateClassId,
    student_code: GATE_MEMBER.code,
    full_name: GATE_MEMBER.fullName,
    team_number: 1,
  });
  check('41b: the practice class is seeded with one member', !gateMembers.error,
    gateMembers.error?.message);

  const gateOk = await flex40Anon.rpc('verify_student_practice', {
    p_class_name: GATE_CLASS,
    p_full_name: GATE_MEMBER.fullName,
  });
  check('41b: an enabled class authorises its member',
    gateOk.data?.success === true && gateOk.data?.student_code === GATE_MEMBER.code,
    JSON.stringify(gateOk.data));
  check('41b: the success payload echoes class_name instead of authorized',
    gateOk.data?.class_name === GATE_CLASS && !('authorized' in gateOk.data),
    JSON.stringify(gateOk.data));

  // A name that is not on THIS class's roster is refused with a distinct code,
  // so the SPA can tell "wrong class" from "not your roster".
  const gateStranger = await flex40Anon.rpc('verify_student_practice', {
    p_class_name: GATE_CLASS,
    p_full_name: 'Người Ngoài Lớp',
  });
  check('41b: a non-member is refused with STUDENT_NOT_FOUND',
    gateStranger.data?.success === false && gateStranger.data?.code === 'STUDENT_NOT_FOUND',
    JSON.stringify(gateStranger.data));

  // --- 41c. the pick-list RPC -------------------------------------------
  const listOn = await flex40Anon.rpc('get_public_practice_classes', {});
  check('41c: get_public_practice_classes succeeds',
    listOn.data?.success === true, JSON.stringify(listOn.data));
  check('41c: it returns an array (never null) even when empty',
    Array.isArray(listOn.data?.classes), JSON.stringify(listOn.data?.classes));
  check('41c: it lists the practice-enabled class',
    listOn.data.classes.includes(GATE_CLASS), JSON.stringify(listOn.data.classes));
  // Ordered by the DATABASE's collation (jsonb_agg ... order by name), which is
  // not necessarily a codepoint sort, so the expectation is built from the same
  // ORDER BY rather than re-sorted in JS.
  const gateExpectedOrder = step32Sql(
    `select coalesce(string_agg(name, '|' order by name asc), '') `
    + `from public.classes where allow_practice = true`,
  );
  check('41c: the list is ordered by class name',
    listOn.data.classes.join('|') === gateExpectedOrder,
    `got ${listOn.data.classes.join('|')} want ${gateExpectedOrder}`);

  // --- 41d. disable branch ----------------------------------------------
  const gateDisable = await teacher
    .from('classes')
    .update({ allow_practice: false })
    .eq('id', gateClassId)
    .select('allow_practice')
    .single();
  check('41d: the toggle persists false', gateDisable.data?.allow_practice === false,
    gateDisable.error?.message ?? JSON.stringify(gateDisable.data));

  const gateDisabled = await flex40Anon.rpc('verify_student_practice', {
    p_class_name: GATE_CLASS,
    p_full_name: GATE_MEMBER.fullName,
  });
  check('41d: a disabled class returns CLASS_PRACTICE_DISABLED',
    gateDisabled.data?.success === false
      && gateDisabled.data?.code === 'CLASS_PRACTICE_DISABLED',
    JSON.stringify(gateDisabled.data));
  check('41d: the disabled message names the teacher as the route to re-enable',
    typeof gateDisabled.data?.message === 'string'
      && gateDisabled.data.message.includes('giáo viên'),
    String(gateDisabled.data?.message));

  const listOff = await flex40Anon.rpc('get_public_practice_classes', {});
  check('41d: a disabled class drops out of the pick list',
    listOff.data?.classes.includes(GATE_CLASS) === false, JSON.stringify(listOff.data?.classes));

  // --- 41e. unknown class ----------------------------------------------
  const gateMissing = await flex40Anon.rpc('verify_student_practice', {
    p_class_name: 'E2E-KHONG-TON-TAI-' + String(Math.floor(1000 + Math.random() * 9000)),
    p_full_name: GATE_MEMBER.fullName,
  });
  check('41e: an unknown class returns CLASS_NOT_FOUND',
    gateMissing.data?.success === false && gateMissing.data?.code === 'CLASS_NOT_FOUND',
    JSON.stringify(gateMissing.data));

  // --- 41f. the SPA is wired to the new gate ----------------------------
  const appSrc41 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  check('41f: the SPA populates the picker from get_public_practice_classes',
    appSrc41.includes("callRpc('get_public_practice_classes'"),
    'the pick-list RPC is never called');
  check('41f: the verification runs BEFORE the .docx is uploaded',
    appSrc41.indexOf("callRpc('verify_student_practice'")
      < appSrc41.indexOf('await extractPracticeDocx(file)'),
    'the file is uploaded before authorisation');
  check('41f: the SPA branches on the success contract',
    appSrc41.includes('auth.data?.success !== true'), 'the old `authorized` check survived');
  check('41f: a refused verification clears the file picker',
    appSrc41.includes("fileInput.value = ''"), 'the rejected file is not reset');
  check('41f: the SPA reads the roster full_name, not student_name',
    appSrc41.includes('auth.data?.full_name'), 'the canonical name is not adopted');

  await teacher.from('classes').delete().eq('id', gateClassId); // members cascade

  /* --- 42. Practice exam code verification + meta banner (Phase 8.10) ---- */
  // The practice panel gains the same explicit "Kiểm tra đề" affordance the
  // official form has (Phase 8.8): the code is verified up-front and the exam's
  // identity — or the server's refusal — is revealed before the student commits.
  step(42, 'practice exam code verification and meta banner');

  const indexHtml42 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');
  const appSrc42 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  const practicePanel42 = indexHtml42.slice(indexHtml42.indexOf('id="practicePanel"'));

  // --- 42a. markup -------------------------------------------------------
  check('42a: the practice code input sits in an .input-with-button row',
    practicePanel42.includes('id="btnVerifyPracticeCode"')
      && /id="practice-exam-code"[\s\S]{0,400}?id="btnVerifyPracticeCode"/.test(practicePanel42),
    'the verify button is not next to the practice code input');
  check('42a: the practice meta banner exists with both slots',
    practicePanel42.includes('id="practiceMetaBanner"')
      && practicePanel42.includes('id="practiceMetaTitle"')
      && practicePanel42.includes('id="practiceMetaStatus"'),
    'practice banner markup missing');
  check('42a: the banner starts hidden so an unverified code shows nothing',
    /id="practiceMetaBanner"[^>]*class="[^"]*\bhidden\b/.test(practicePanel42),
    'the banner is visible before verification');
  check('42a: the banner renders after the code row, before the class field',
    practicePanel42.indexOf('id="practiceMetaBanner"') !== -1
      && practicePanel42.indexOf('id="practiceMetaBanner"')
        < practicePanel42.indexOf('id="practiceClassName"')
      && practicePanel42.indexOf('id="practiceMetaBanner"')
        > practicePanel42.indexOf('id="btnVerifyPracticeCode"'),
    'banner is not between the code row and the identity fields');
  check('42a: the verify button is type="button" so it cannot submit the form',
    /id="btnVerifyPracticeCode"[^>]*/.test(practicePanel42)
      && practicePanel42.slice(
        practicePanel42.lastIndexOf('<button', practicePanel42.indexOf('id="btnVerifyPracticeCode"')),
        practicePanel42.indexOf('id="btnVerifyPracticeCode"'),
      ).includes('type="button"'),
    'a type=button guard is missing — the button would submit #practiceForm');

  // --- 42b. the SPA is wired to the RPC ---------------------------------
  const verifyFn42 = appSrc42.slice(
    appSrc42.indexOf('async function loadPracticeRoster'),
    appSrc42.indexOf('function renderPracticeBanner'),
  );
  check('42b: verification calls get_exam_roster with p_for_practice: true',
    verifyFn42.includes("callRpc('get_exam_roster'")
      && verifyFn42.includes('p_for_practice: true'),
    'the practice-roster RPC call is missing or lacks the practice flag');
  check('42b: the verify button is bound to the loader',
    /btnVerifyPracticeCode'\)[\s\S]{0,400}?loadPracticeRoster\(/.test(appSrc42),
    'the verify button is never wired');
  check('42b: Enter in the code field verifies instead of submitting',
    appSrc42.includes("practiceCodeInput.addEventListener('keydown'")
      && appSrc42.includes("event.key !== 'Enter'")
      && appSrc42.includes('event.preventDefault()'),
    'Enter is not intercepted, so it would start practice');
  check('42b: blur also triggers verification',
    appSrc42.includes("practiceCodeInput.addEventListener('blur'"),
    'blur is not wired');
  check('42b: editing the code clears the stale banner',
    appSrc42.includes("practiceCodeInput.addEventListener('input'")
      && appSrc42.includes('clearPracticeBanner()'),
    'a stale verdict can survive an edit');
  check('42b: the success branch renders the title and the permission badge',
    appSrc42.includes('`📚 ${title}`')
      && appSrc42.includes("statusNode.textContent = 'Cho phép tự luyện'"),
    'the success banner copy is missing');
  check('42b: the success branch carries the is-success class',
    appSrc42.includes("banner.classList.add('is-success')"),
    'the success banner is not colour-coded');
  check('42b: the failure branch carries the is-error class',
    appSrc42.includes("banner.classList.add('is-error')"),
    'the error banner is not colour-coded');
  check('42b: the failure branch disables the start button',
    appSrc42.includes('updatePracticeStartState'), 'the start button is never disabled');
  // The start button is shared with the .docx source: a bad code must not
  // disable the personal-file flow (Phase 8.9 regression guard).
  check('42b: the disabled state is scoped to the by-code source',
    appSrc42.includes("state.practiceSource === 'code' && state.practiceCodeStatus === 'error'"),
    'a bad code would disable the .docx flow too');
  check('42b: a slow earlier verification cannot overwrite a newer verdict',
    verifyFn42.includes('requestId !== state.practiceRosterRequestId'),
    'the request-id guard was dropped');

  // --- 42c. URL prefill -------------------------------------------------
  check('42c: the URL can carry the practice code',
    appSrc42.includes("params.get('practice_code') || params.get('code')"),
    'the ?practice_code= / ?code= params are not read');
  check('42c: the URL prefill runs on first practice-tab activation',
    appSrc42.includes('applyPracticeCodeFromUrl()'),
    'the URL prefill is never called');
  check('42c: the URL prefill runs at most once',
    appSrc42.includes('practiceUrlPrefilled'), 'the prefill is not latched');

  // --- 42d. live RPC round-trips ----------------------------------------
  // Practice mode must succeed on a CLOSED exam (that is the whole point of
  // p_for_practice) and expose `title` for the banner.
  const PCODE_EXAM = {
    code: 'PCV' + String(Math.floor(100 + Math.random() * 900)),
    title: 'E2E Practice Verify',
    duration: 30,
  };
  const PCODE_OFF_EXAM = {
    code: 'PCO' + String(Math.floor(100 + Math.random() * 900)),
    title: 'E2E Practice Closed',
    duration: 30,
  };
  const PCODE_MEMBER = { code: 'E2EPCV01', fullName: 'Nguyễn Văn Ôn', className: '12PCV' };

  await teacher.from('exams').delete().in('code', [PCODE_EXAM.code, PCODE_OFF_EXAM.code]);
  const pcodeOn = await teacher.from('exams').insert({
    user_id: teacherId,
    code: PCODE_EXAM.code,
    title: PCODE_EXAM.title,
    duration_minutes: PCODE_EXAM.duration,
    allow_practice: true,
    is_active: false, // closed: practice must still work
  }).select('id').single();
  check('42d: the practice-enabled exam is created (closed)', !pcodeOn.error,
    pcodeOn.error?.message);

  const pcodeOff = await teacher.from('exams').insert({
    user_id: teacherId,
    code: PCODE_OFF_EXAM.code,
    title: PCODE_OFF_EXAM.title,
    duration_minutes: PCODE_OFF_EXAM.duration,
    allow_practice: false,
    is_active: false,
  }).select('id').single();
  check('42d: the practice-disabled exam is created', !pcodeOff.error,
    pcodeOff.error?.message);

  await teacher.from('students').insert({
    exam_code: PCODE_EXAM.code,
    student_code: PCODE_MEMBER.code,
    full_name: PCODE_MEMBER.fullName,
    class_name: PCODE_MEMBER.className,
  });

  const practiceVerify = await flex40Anon.rpc('get_exam_roster', {
    p_exam_code: PCODE_EXAM.code,
    p_for_practice: true,
  });
  check('42d: a closed-but-practice-enabled exam verifies for practice',
    practiceVerify.data?.success === true, JSON.stringify(practiceVerify.data));
  check('42d: the payload carries the title the banner renders',
    practiceVerify.data?.title === PCODE_EXAM.title, String(practiceVerify.data?.title));
  check('42d: the payload confirms allow_practice for the badge',
    practiceVerify.data?.allow_practice === true, String(practiceVerify.data?.allow_practice));
  check('42d: the payload returns candidates for the datalists',
    Array.isArray(practiceVerify.data?.candidates)
      && practiceVerify.data.candidates.some((c) => c.student_code === PCODE_MEMBER.code),
    JSON.stringify(practiceVerify.data?.candidates));

  // The refusal path the banner must render, verbatim.
  const practiceOff = await flex40Anon.rpc('get_exam_roster', {
    p_exam_code: PCODE_OFF_EXAM.code,
    p_for_practice: true,
  });
  check('42d: a practice-disabled exam is refused with PRACTICE_NOT_ALLOWED',
    practiceOff.data?.success === false && practiceOff.data?.code === 'PRACTICE_NOT_ALLOWED',
    JSON.stringify(practiceOff.data));
  check('42d: the refusal message is the one the banner shows',
    practiceOff.data?.message === 'Đề thi này chưa mở cho tự luyện tập.',
    String(practiceOff.data?.message));

  const practiceUnknown = await flex40Anon.rpc('get_exam_roster', {
    p_exam_code: 'ZZZ' + String(Math.floor(100 + Math.random() * 900)),
    p_for_practice: true,
  });
  check('42d: an unknown code is refused with EXAM_NOT_FOUND',
    practiceUnknown.data?.success === false && practiceUnknown.data?.code === 'EXAM_NOT_FOUND',
    JSON.stringify(practiceUnknown.data));
  check('42d: the not-found message is the one the banner shows',
    practiceUnknown.data?.message === 'Đề thi không tồn tại.',
    String(practiceUnknown.data?.message));
  // Both refusal codes must be in the SPA's local map, so a payload that omits
  // the message still renders Vietnamese rather than a raw code.
  check('42d: the SPA maps PRACTICE_NOT_ALLOWED to Vietnamese',
    appSrc42.includes("PRACTICE_NOT_ALLOWED: 'Giáo viên chưa mở đề này cho chế độ luyện tập.'"),
    'the PRACTICE_NOT_ALLOWED copy is missing');

  await teacher.from('exams').delete().in('code', [PCODE_EXAM.code, PCODE_OFF_EXAM.code]);

  /* --- 43. Class member groups + auto-balancing (Phase 8.11) ------------- */
  // `class_members.group_number` (1..8) is a CLASSROOM grouping for seat-work,
  // deliberately independent of the Phase 8.4 arena `team_number` (1..4). 43f
  // asserts that independence, because a regression that aliased the two would
  // silently re-partition the Tree of Knowledge arena.
  step(43, 'class member group management and auto-balancing');

  // --- 43a. column + constraint -----------------------------------------
  const groupColumn = step32Sql(
    `select is_nullable || '|' || coalesce(column_default, '') || '|' || data_type `
    + `from information_schema.columns where table_schema = 'public' `
    + `and table_name = 'class_members' and column_name = 'group_number'`,
  );
  check('43a: class_members.group_number is NOT NULL smallint defaulting to 1',
    groupColumn === 'NO|1|smallint', groupColumn);

  const groupCheck = step32Sql(
    `select pg_get_constraintdef(oid) from pg_constraint `
    + `where conrelid = 'public.class_members'::regclass `
    + `and conname = 'class_members_group_number_check'`,
  );
  check('43a: the CHECK constraint exists and spans 1..8',
    groupCheck.includes('>= 1') && groupCheck.includes('<= 8'), groupCheck);
  check('43a: the (class_id, group_number) index exists',
    step32Sql(`select count(*) from pg_indexes where schemaname = 'public' `
      + `and indexname = 'idx_class_members_group'`) === '1');

  // The RPCs must NOT be reachable by a student client.
  const aclFor = (signature) => step32Sql(
    `select has_function_privilege('anon', 'public.${signature}'::regprocedure, 'execute')`,
  );
  check('43a: anon may NOT execute update_class_member_group',
    aclFor('update_class_member_group(uuid, integer)') === 'f');
  check('43a: anon may NOT execute auto_balance_class_groups',
    aclFor('auto_balance_class_groups(uuid, integer, boolean)') === 'f');
  check('43a: authenticated MAY execute both group RPCs',
    step32Sql(`select has_function_privilege('authenticated', `
      + `'public.update_class_member_group(uuid, integer)'::regprocedure, 'execute')`) === 't'
    && step32Sql(`select has_function_privilege('authenticated', `
      + `'public.auto_balance_class_groups(uuid, integer, boolean)'::regprocedure, 'execute')`) === 't');
  check('43a: both group RPCs have exactly one signature each',
    procCount('update_class_member_group') === 1 && procCount('auto_balance_class_groups') === 1,
    `${procCount('update_class_member_group')}/${procCount('auto_balance_class_groups')}`);

  // --- 43b. the DB default -----------------------------------------------
  const GROUP_CLASS = 'E2E-GRP-' + String(Math.floor(1000 + Math.random() * 9000));
  // Deliberately constant, so an aborted run's rows are cleared before re-insert.
  // (classes_user_name_uniq would otherwise reject the second attempt.)
  await teacher.from('classes').delete().eq('name', GROUP_CLASS);
  const groupClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: GROUP_CLASS, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('43b: the group test class is created', !groupClass.error, groupClass.error?.message);
  const groupClassId = groupClass.data?.id;

  // 13 students: an odd count that does NOT divide by 4, so the balance check
  // below has real work to do (13/4 -> 4,3,3,3).
  const GROUP_SIZE = 13;
  const groupMembers = Array.from({ length: GROUP_SIZE }, (_, i) => ({
    class_id: groupClassId,
    // Zero-padded so `student_code` ORDER matches the numeric order.
    student_code: `E2EGRP${String(i + 1).padStart(2, '0')}`,
    full_name: `Học Sinh Tổ ${String(i + 1).padStart(2, '0')}`,
  }));
  const groupInsert = await teacher.from('class_members').insert(groupMembers).select('id, group_number');
  check('43b: 13 members inserted', !groupInsert.error && groupInsert.data?.length === GROUP_SIZE,
    groupInsert.error?.message ?? String(groupInsert.data?.length));
  check('43b: a member inserted without the column defaults to group 1',
    groupInsert.data?.every((row) => row.group_number === 1),
    JSON.stringify(groupInsert.data?.map((r) => r.group_number)));

  // --- 43c. the CHECK constraint rejects out-of-range values -------------
  const groupTarget = groupInsert.data?.[0]?.id;
  const groupBadHigh = await teacher
    .from('class_members').update({ group_number: 9 }).eq('id', groupTarget);
  check('43c: the constraint rejects group_number = 9', !!groupBadHigh.error,
    'a 9 was accepted');
  const groupBadLow = await teacher
    .from('class_members').update({ group_number: 0 }).eq('id', groupTarget);
  check('43c: the constraint rejects group_number = 0', !!groupBadLow.error,
    'a 0 was accepted');

  // --- 43d. auto-balancing ----------------------------------------------
  const balanced = await teacher.rpc('auto_balance_class_groups', {
    p_class_id: groupClassId, p_num_groups: 4, p_randomize: true,
  });
  check('43d: auto_balance_class_groups succeeds',
    balanced.data?.success === true, JSON.stringify(balanced.data));
  check('43d: it reports every member as assigned',
    balanced.data?.total_assigned === GROUP_SIZE, String(balanced.data?.total_assigned));
  check('43d: it echoes the requested group count',
    balanced.data?.num_groups === 4, String(balanced.data?.num_groups));

  const afterBalance = await teacher
    .from('class_members').select('group_number').eq('class_id', groupClassId);
  const groupSizes = (afterBalance.data ?? [])
    .reduce((acc, row) => {
      acc[row.group_number] = (acc[row.group_number] ?? 0) + 1;
      return acc;
    }, {});
  const sizes = Object.values(groupSizes);
  check('43d: all 13 members fall in groups 1..4',
    afterBalance.data?.length === GROUP_SIZE
      && Object.keys(groupSizes).every((g) => Number(g) >= 1 && Number(g) <= 4),
    JSON.stringify(groupSizes));
  // The balance guarantee: max - min <= 1. For 13/4 that is exactly {4,3,3,3}.
  check('43d: the split is balanced (max - min <= 1)',
    sizes.length === 4 && Math.max(...sizes) - Math.min(...sizes) <= 1,
    JSON.stringify(sizes));
  check('43d: 13 members over 4 groups yields sizes 4/3/3/3',
    JSON.stringify([...sizes].sort((a, b) => b - a)) === JSON.stringify([4, 3, 3, 3]),
    JSON.stringify(sizes));

  // A no-randomize run must be deterministic AND still balanced.
  const orderedSplit = await teacher.rpc('auto_balance_class_groups', {
    p_class_id: groupClassId, p_num_groups: 4, p_randomize: false,
  });
  check('43d: the ordered split also succeeds', orderedSplit.data?.success === true,
    JSON.stringify(orderedSplit.data));
  const afterOrdered = await teacher
    .from('class_members').select('student_code, group_number')
    .eq('class_id', groupClassId).order('student_code');
  // Re-run and compare the FULL assignment, so "deterministic" is actually
  // asserted rather than inferred from the second call merely succeeding.
  await teacher.rpc('auto_balance_class_groups', {
    p_class_id: groupClassId, p_num_groups: 4, p_randomize: false,
  });
  const afterOrderedAgain = await teacher
    .from('class_members').select('student_code, group_number')
    .eq('class_id', groupClassId).order('student_code');
  check('43d: the ordered split is repeatable (identical assignments on re-run)',
    JSON.stringify(afterOrderedAgain.data) === JSON.stringify(afterOrdered.data),
    JSON.stringify(afterOrderedAgain.data?.map((r) => r.group_number)));
  // Alphabetical split: student 01 -> Tổ 1, 02 -> Tổ 2, ... 05 -> Tổ 1 again.
  check('43d: the ordered split follows the roster order (1,2,3,4,1,…)',
    afterOrdered.data?.[0]?.group_number === 1
      && afterOrdered.data?.[1]?.group_number === 2
      && afterOrdered.data?.[3]?.group_number === 4
      && afterOrdered.data?.[4]?.group_number === 1,
    JSON.stringify(afterOrdered.data?.map((r) => r.group_number)));

  // --- 43e. update_class_member_group ------------------------------------
  const switched = await teacher.rpc('update_class_member_group', {
    p_member_id: groupTarget, p_group_number: 3,
  });
  check('43e: update_class_member_group succeeds',
    switched.data?.success === true && switched.data?.group_number === 3,
    JSON.stringify(switched.data));

  const reread = await teacher
    .from('class_members').select('group_number').eq('id', groupTarget).single();
  check('43e: the new group persisted', reread.data?.group_number === 3,
    String(reread.data?.group_number));

  const outOfRange = await teacher.rpc('update_class_member_group', {
    p_member_id: groupTarget, p_group_number: 9,
  });
  check('43e: an out-of-range group is refused with INVALID_GROUP',
    outOfRange.data?.success === false && outOfRange.data?.code === 'INVALID_GROUP',
    JSON.stringify(outOfRange.data));

  // A random (real) uuid is not a member of any class this teacher owns.
  const foreign = await teacher.rpc('update_class_member_group', {
    p_member_id: '00000000-0000-0000-0000-000000000000', p_group_number: 2,
  });
  check('43e: an unknown member is refused with NOT_FOUND',
    foreign.data?.success === false && foreign.data?.code === 'NOT_FOUND',
    JSON.stringify(foreign.data));

  const foreignClass = await teacher.rpc('auto_balance_class_groups', {
    p_class_id: '00000000-0000-0000-0000-000000000000', p_num_groups: 4, p_randomize: true,
  });
  check('43e: an unknown class is refused with NOT_FOUND',
    foreignClass.data?.success === false && foreignClass.data?.code === 'NOT_FOUND',
    JSON.stringify(foreignClass.data));

  const badCount = await teacher.rpc('auto_balance_class_groups', {
    p_class_id: groupClassId, p_num_groups: 9, p_randomize: true,
  });
  check('43e: a group count of 9 is refused with INVALID_GROUP_COUNT',
    badCount.data?.success === false && badCount.data?.code === 'INVALID_GROUP_COUNT',
    JSON.stringify(badCount.data));

  // --- 43f. independence from the arena team_number ---------------------
  // A student client must not be able to reach either RPC at all (43a asserted
  // the ACL; this proves the call actually fails end-to-end).
  const anonGroupCall = await flex40Anon.rpc('update_class_member_group', {
    p_member_id: groupTarget, p_group_number: 2,
  });
  check('43f: an anon client cannot call update_class_member_group',
    !!anonGroupCall.error || anonGroupCall.data?.success !== true,
    JSON.stringify(anonGroupCall.data ?? anonGroupCall.error?.message));

  // group_number and team_number are separate columns: writing one leaves the
  // other untouched, so the arena keeps its own four-team split.
  const before = await teacher
    .from('class_members').select('team_number').eq('id', groupTarget).single();
  await teacher.rpc('update_class_member_group', { p_member_id: groupTarget, p_group_number: 6 });
  const after = await teacher
    .from('class_members').select('team_number, group_number').eq('id', groupTarget).single();
  check('43f: changing group_number does NOT touch team_number',
    after.data?.team_number === before.data?.team_number && after.data?.group_number === 6,
    JSON.stringify(after.data));

  // --- 43g. the teacher web is wired to the new layer -------------------
  const classesSrc43 = readFileSync(
    new URL('../web/src/lib/classes.ts', import.meta.url), 'utf8');
  const rosterSrc43 = readFileSync(
    new URL('../web/src/components/ClassRosterManager.tsx', import.meta.url), 'utf8');
  const excelSrc43 = readFileSync(new URL('../web/src/lib/excel.ts', import.meta.url), 'utf8');
  check('43g: MEMBER_COLUMNS selects group_number',
    classesSrc43.includes('group_number'), 'the column is never read');
  check('43g: the client wraps both group RPCs',
    classesSrc43.includes("rpc('update_class_member_group'")
      && classesSrc43.includes("rpc('auto_balance_class_groups'"),
    'a group RPC wrapper is missing');
  check('43g: the CSV parser reads a group header',
    excelSrc43.includes('GROUP_HEADERS') && excelSrc43.includes('normalizeGroupNumber'),
    'the group column is not parsed');
  check('43g: the roster UI renders the four group badges',
    rosterSrc43.includes('bg-blue-100 text-blue-800 border-blue-300')
      && rosterSrc43.includes('bg-emerald-100 text-emerald-800 border-emerald-300')
      && rosterSrc43.includes('bg-amber-100 text-amber-800 border-amber-300')
      && rosterSrc43.includes('bg-purple-100 text-purple-800 border-purple-300'),
    'a group badge colour is missing');
  check('43g: the roster UI has the filter pills and both auto-balance buttons',
    rosterSrc43.includes('Tất cả (')
      && rosterSrc43.includes('🎲 Chia ngẫu nhiên 4 tổ')
      && rosterSrc43.includes('📋 Chia theo thứ tự (1..4)'),
    'a group toolbar control is missing');

  await teacher.from('classes').delete().eq('id', groupClassId); // members cascade

  /* --- 44. Tree arena lobby, pre-flight roster & game modes (9.1) ------- */
  // The lobby vertical: a session opens in LOBBY and refuses every answer until
  // `start_tree_session` moves it to ACTIVE; the teacher's pre-flight
  // `participant_config` can mark a student absent (they are then excluded from
  // their Tổ's denominator and cannot submit) or move them to another Tổ.
  step(44, 'tree arena lobby, pre-flight roster config, and game modes');

  // --- 44a. schema ------------------------------------------------------
  const columnSpec = (table, column) => step32Sql(
    `select is_nullable || '|' || coalesce(column_default, '') || '|' || data_type `
    + `from information_schema.columns where table_schema = 'public' `
    + `and table_name = '${table}' and column_name = '${column}'`,
  );
  check('44a: tree_sessions.status is NOT NULL varchar defaulting to LOBBY',
    columnSpec('tree_sessions', 'status') === "NO|'LOBBY'::character varying|character varying",
    columnSpec('tree_sessions', 'status'));
  check('44a: tree_sessions.game_mode defaults to BRAINSTORM',
    columnSpec('tree_sessions', 'game_mode') === "NO|'BRAINSTORM'::character varying|character varying",
    columnSpec('tree_sessions', 'game_mode'));
  check('44a: tree_sessions.target_score is NOT NULL integer defaulting to 20',
    columnSpec('tree_sessions', 'target_score') === 'NO|20|integer',
    columnSpec('tree_sessions', 'target_score'));
  check('44a: tree_sessions.participant_config is NOT NULL jsonb with the empty default',
    columnSpec('tree_sessions', 'participant_config').startsWith('NO|')
      && columnSpec('tree_sessions', 'participant_config').includes('jsonb'),
    columnSpec('tree_sessions', 'participant_config'));

  const statusCheck = step32Sql(
    `select pg_get_constraintdef(oid) from pg_constraint `
    + `where conrelid = 'public.tree_sessions'::regclass `
    + `and conname = 'tree_sessions_status_check'`,
  );
  check('44a: the status CHECK spans LOBBY/ACTIVE/FINISHED',
    statusCheck.includes('LOBBY') && statusCheck.includes('ACTIVE')
      && statusCheck.includes('FINISHED'),
    statusCheck);
  const modeCheck = step32Sql(
    `select pg_get_constraintdef(oid) from pg_constraint `
    + `where conrelid = 'public.tree_sessions'::regclass `
    + `and conname = 'tree_sessions_game_mode_check'`,
  );
  check('44a: the game_mode CHECK spans BRAINSTORM/SPEED_QUIZ',
    modeCheck.includes('BRAINSTORM') && modeCheck.includes('SPEED_QUIZ'), modeCheck);
  check('44a: the session_code unique index exists',
    step32Sql(`select count(*) from pg_indexes where schemaname = 'public' `
      + `and indexname = 'tree_sessions_session_code_uniq'`) === '1');
  check('44a: the status index exists',
    step32Sql(`select count(*) from pg_indexes where schemaname = 'public' `
      + `and indexname = 'idx_tree_sessions_status'`) === '1');

  // start_tree_session is teacher-only: Supabase grants anon EXECUTE directly, so
  // a PUBLIC-only revoke would leak it.
  check('44a: anon may NOT execute start_tree_session',
    aclFor('start_tree_session(uuid)') === 'f');
  check('44a: authenticated MAY execute start_tree_session',
    step32Sql(`select has_function_privilege('authenticated', `
      + `'public.start_tree_session(uuid)'::regprocedure, 'execute')`) === 't');
  check('44a: both tree RPCs have exactly one signature each',
    procCount('start_tree_session') === 1 && procCount('get_public_tree_session') === 1,
    `${procCount('start_tree_session')}/${procCount('get_public_tree_session')}`);

  // --- 44b. fixtures ----------------------------------------------------
  const LOBBY_CLASS = 'E2E-LOBBY-' + String(Math.floor(1000 + Math.random() * 9000));
  const LOBBY_MEMBERS = [
    { code: 'E2ELOBBY01', name: 'Ngô Văn Nhất', team: 1 },
    { code: 'E2ELOBBY02', name: 'Lý Thị Nhị', team: 1 },
    { code: 'E2ELOBBY03', name: 'Đinh Văn Tam', team: 2 },
    { code: 'E2ELOBBY04', name: 'Cao Thị Tư', team: 2 },
  ];

  const lobbyClass = await teacher
    .from('classes')
    .insert({ user_id: teacherId, name: LOBBY_CLASS, academic_year: '2026-2027' })
    .select('id')
    .single();
  check('44b: the lobby test class was created', !lobbyClass.error && !!lobbyClass.data,
    lobbyClass.error?.message);
  const lobbyClassId = lobbyClass.data?.id;

  const lobbyRoster = await saveClassMembers(
    teacher,
    lobbyClassId,
    LOBBY_MEMBERS.map((m) => ({
      student_code: m.code, full_name: m.name, dob: null, pin: null, team_number: m.team,
    })),
  );
  check('44b: the class has 4 members (2 per Tổ 1/2)', lobbyRoster.saved === 4,
    String(lobbyRoster.saved));

  // The teacher's pre-flight roster: member[3] is absent, and member[2] is moved
  // from Tổ 2 to Tổ 4 by an explicit assignment override.
  const lobbyMemberRows = await teacher
    .from('class_members')
    .select('id, student_code')
    .eq('class_id', lobbyClassId);
  const memberIdByCode = Object.fromEntries(
    (lobbyMemberRows.data || []).map((row) => [row.student_code, row.id]),
  );
  const absentMemberId = memberIdByCode.E2ELOBBY04;
  const movedMemberId = memberIdByCode.E2ELOBBY03;

  const LOBBY_CONFIG = {
    absent_ids: [absentMemberId],
    assignments: { [movedMemberId]: 4 },
  };

  // A session created through the web helper lands in LOBBY with is_active false.
  // SPEED_QUIZ draws its questions from a stored exam, so a minimal one is seeded
  // here (the mode itself, not the question pool, is what this step exercises).
  const LOBBY_EXAM_CODE = 'LOB' + String(Math.floor(100 + Math.random() * 900));
  await teacher.from('exams').delete().eq('code', LOBBY_EXAM_CODE);
  const lobbyExam = await teacher
    .from('exams')
    .insert({
      user_id: teacherId,
      code: LOBBY_EXAM_CODE,
      title: 'E2E Đề đua tốc độ',
      duration_minutes: 15,
      is_active: true,
    })
    .select('id')
    .single();
  check('44b: the speed-quiz source exam was created', !lobbyExam.error && !!lobbyExam.data,
    lobbyExam.error?.message);

  const lobbySession = await createTreeSession(teacher, {
    class_id: lobbyClassId,
    title: 'E2E Phòng chờ Cây Tri Thức',
    question_text: 'Theo em, làm thế nào để học tập hiệu quả hơn mỗi ngày?',
    min_words: 5,
    time_limit_minutes: 30,
    max_similarity: 0.6,
    game_mode: 'SPEED_QUIZ',
    exam_id: lobbyExam.data?.id,
    target_score: 25,
    participant_config: LOBBY_CONFIG,
  });
  check('44b: createTreeSession honours the game mode and target score',
    lobbySession?.game_mode === 'SPEED_QUIZ' && Number(lobbySession?.target_score) === 25,
    JSON.stringify({ mode: lobbySession?.game_mode, target: lobbySession?.target_score }));
  check('44b: the participant_config round-trips',
    lobbySession?.participant_config?.absent_ids?.length === 1
      && String(lobbySession.participant_config.assignments[movedMemberId]) === '4',
    JSON.stringify(lobbySession?.participant_config));
  check('44b: a fresh session is in the lobby, inactive, and carries a session_code',
    lobbySession?.status === 'LOBBY' && lobbySession?.is_active === false
      && /^[0-9A-F]{6}$/.test(String(lobbySession?.session_code)),
    JSON.stringify({ status: lobbySession?.status, code: lobbySession?.session_code }));

  const lobbySessionId = lobbySession.id;
  const lobbySessionCode = lobbySession.session_code;

  // --- 44c. the public read resolves the pre-flight config --------------
  const anonLobby = createClient(SB_URL, SB_PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const lobbyPayload = await anonLobby.rpc('get_public_tree_session', {
    p_session_code: lobbySessionCode,
    p_student_code: 'E2ELOBBY01',
  });
  check('44c: a LOBBY session is readable by anon (the waiting room must load)',
    lobbyPayload.data?.success === true, JSON.stringify(lobbyPayload.data));
  check('44c: the payload reports the lobby status, mode and target score',
    lobbyPayload.data?.session?.status === 'LOBBY'
      && lobbyPayload.data?.session?.game_mode === 'SPEED_QUIZ'
      && Number(lobbyPayload.data?.session?.target_score) === 25,
    JSON.stringify(lobbyPayload.data?.session));
  check('44c: the payload reports the full time budget while still in the lobby',
    Number(lobbyPayload.data?.session?.time_remaining_seconds) === 30 * 60,
    String(lobbyPayload.data?.session?.time_remaining_seconds));
  check('44c: a present student resolves to their Tổ with is_absent false',
    lobbyPayload.data?.session?.is_absent === false
      && Number(lobbyPayload.data?.session?.team_number) === 1,
    JSON.stringify(lobbyPayload.data?.session));
  // team_counts excludes the absentee (4 members - 1 absent = 3 counted), and the
  // assignment override moves member[2] from Tổ 2 to Tổ 4.
  check('44c: team_counts excludes the absentee and honours the assignment override',
    Number(lobbyPayload.data?.team_counts?.[1]) === 2
      && Number(lobbyPayload.data?.team_counts?.[2]) === 0
      && Number(lobbyPayload.data?.team_counts?.[3]) === 0
      && Number(lobbyPayload.data?.team_counts?.[4]) === 1,
    JSON.stringify(lobbyPayload.data?.team_counts));
  check('44c: the candidates list carries the OVERRIDDEN team for the moved member',
    (lobbyPayload.data?.candidates || [])
      .find((c) => c.student_code === 'E2ELOBBY03')?.team_number === 4,
    JSON.stringify(lobbyPayload.data?.candidates));

  const absentPayload = await anonLobby.rpc('get_public_tree_session', {
    p_session_code: lobbySessionCode,
    p_student_code: 'E2ELOBBY04',
  });
  check('44c: an absent student is flagged with is_absent true and no team',
    absentPayload.data?.session?.is_absent === true
      && absentPayload.data?.session?.team_number === null,
    JSON.stringify(absentPayload.data?.session));
  check('44c: the absent student is still named in the payload (Spectator card copy)',
    absentPayload.data?.session?.student_name === 'Cao Thị Tư',
    String(absentPayload.data?.session?.student_name));

  // --- 44d. submission is refused while in the lobby --------------------
  const lobbySubmit = await anonLobby.rpc('submit_tree_answer', {
    p_session_id: lobbySessionId,
    p_student_code: 'E2ELOBBY01',
    p_student_name: 'Ngô Văn Nhất',
    p_answer_text: 'Hoc tap hieu qua can co muc tieu ro rang va su kien tri moi ngay',
  });
  check('44d: a LOBBY session refuses a submission with NOT_STARTED',
    lobbySubmit.data?.success === false && lobbySubmit.data?.code === 'NOT_STARTED',
    JSON.stringify(lobbySubmit.data));

  // --- 44e. start_tree_session: the atomic LOBBY -> ACTIVE transition ----
  const started = await startTreeSession(teacher, lobbySessionId);
  check('44e: startTreeSession reports the stamped window',
    !!started.startedAt && !!started.endsAt, JSON.stringify(started));

  const afterStart = await teacher
    .from('tree_sessions')
    .select('status, is_active, started_at, ends_at')
    .eq('id', lobbySessionId)
    .single();
  check('44e: the session is now ACTIVE + is_active with started_at and ends_at stamped',
    afterStart.data?.status === 'ACTIVE' && afterStart.data?.is_active === true
      && !!afterStart.data?.started_at && !!afterStart.data?.ends_at,
    JSON.stringify(afterStart.data));

  let secondStart = '';
  try {
    await startTreeSession(teacher, lobbySessionId);
  } catch (err) {
    secondStart = String(err?.message ?? err);
  }
  check('44e: starting an already-started session is refused with INVALID_STATE',
    secondStart.includes('đã bắt đầu'), secondStart);

  // --- 44f. submissions now succeed, and the absentee is refused --------
  const activePayload = await anonLobby.rpc('get_public_tree_session', {
    p_session_code: lobbySessionCode,
    p_student_code: 'E2ELOBBY01',
  });
  check('44f: the payload reports ACTIVE with a seconds-level countdown',
    activePayload.data?.session?.status === 'ACTIVE'
      && Number(activePayload.data?.session?.time_remaining_seconds) > 0
      && Number(activePayload.data?.session?.time_remaining_seconds) <= 30 * 60,
    JSON.stringify({
      status: activePayload.data?.session?.status,
      remaining: activePayload.data?.session?.time_remaining_seconds,
    }));

  const nowSubmit = await anonLobby.rpc('submit_tree_answer', {
    p_session_id: lobbySessionId,
    p_student_code: 'E2ELOBBY01',
    p_student_name: 'Ngô Văn Nhất',
    p_answer_text: 'Hoc tap hieu qua can co muc tieu ro rang va su kien tri moi ngay',
  });
  check('44f: a submission is accepted once the session is ACTIVE',
    nowSubmit.data?.success === true, JSON.stringify(nowSubmit.data));

  const absentSubmit = await anonLobby.rpc('submit_tree_answer', {
    p_session_id: lobbySessionId,
    p_student_code: 'E2ELOBBY04',
    p_student_name: 'Cao Thị Tư',
    p_answer_text: 'Em nghi rang can phai co gang that nhieu thi moi thanh cong trong hoc tap',
  });
  check('44f: an absent student is refused with STUDENT_ABSENT',
    absentSubmit.data?.success === false && absentSubmit.data?.code === 'STUDENT_ABSENT',
    JSON.stringify(absentSubmit.data));

  // The assignment override routes the moved member's fruit to Tổ 4, not to the
  // Tổ 2 their roster row still carries.
  const movedSubmit = await anonLobby.rpc('submit_tree_answer', {
    p_session_id: lobbySessionId,
    p_student_code: 'E2ELOBBY03',
    p_student_name: 'Đinh Văn Tam',
    p_answer_text: 'De hoc tot thi can phai kien tri va luon luon tim toi kham pha',
  });
  check('44f: the assignment override routes the submission to the overridden Tổ',
    movedSubmit.data?.success === true && movedSubmit.data?.team_number === 4,
    JSON.stringify(movedSubmit.data));

  // --- 44g. the waiting-room promotion path -----------------------------
  // A separate LOBBY session, so the NOT_STARTED (44d) and the promotion checks
  // cannot interfere with the one already started above.
  const promoSession = await createTreeSession(teacher, {
    class_id: lobbyClassId,
    title: 'E2E Phòng chờ khuyến mãi',
    question_text: 'Em hay ke mot viec tot em da lam trong tuan nay cho lop nghe?',
    min_words: 3,
    time_limit_minutes: 20,
    max_similarity: 0.6,
  });
  check('44g: the second lobby session is created via the web default (BRAINSTORM)',
    promoSession?.game_mode === 'BRAINSTORM' && promoSession?.status === 'LOBBY',
    JSON.stringify({ mode: promoSession?.game_mode, status: promoSession?.status }));
  const promoStarted = await startTreeSession(teacher, promoSession.id);
  check('44g: the second session can also be started',
    !!promoStarted.startedAt, JSON.stringify(promoStarted));
  await teacher.from('tree_sessions').delete().eq('id', promoSession.id);

  // --- 44h. teacher web + SPA are wired for the lobby -------------------
  const treeLibSrc44 = readFileSync(new URL('../web/src/lib/tree.ts', import.meta.url), 'utf8');
  const typesSrc44 = readFileSync(new URL('../web/src/lib/types.ts', import.meta.url), 'utf8');
  const modalSrc44 = readFileSync(
    new URL('../web/src/components/tree/CreateTreeSessionModal.tsx', import.meta.url), 'utf8');
  const lobbySrc44 = readFileSync(
    new URL('../web/src/components/tree/TreeLobby.tsx', import.meta.url), 'utf8');
  const plannerSrc44 = readFileSync(
    new URL('../web/src/components/tree/TreeRosterPlanner.tsx', import.meta.url), 'utf8');
  const projectorSrc44 = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');
  const spaSrc44 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');
  const spaHtml44 = readFileSync(new URL('../student/index.html', import.meta.url), 'utf8');

  check('44h: the web tree layer wraps start_tree_session',
    treeLibSrc44.includes("rpc('start_tree_session'"), 'startTreeSession wrapper missing');
  check('44h: TREE_SESSION_COLUMNS selects every Phase 9.1 column',
    ['status', 'session_code', 'game_mode', 'exam_id', 'target_score', 'participant_config',
     'started_at', 'ends_at'].every((c) => TREE_SESSION_COLUMNS.includes(c)),
    TREE_SESSION_COLUMNS);
  check('44h: types define the lobby status and game-mode unions',
    typesSrc44.includes("'LOBBY' | 'ACTIVE' | 'FINISHED'")
      && typesSrc44.includes("'BRAINSTORM' | 'SPEED_QUIZ'"),
    'the Phase 9.1 unions are missing');
  check('44h: the creation modal offers both game modes and the roster planner',
    modalSrc44.includes('Bão não từ khóa') && modalSrc44.includes('Đua tốc độ trắc nghiệm')
      && modalSrc44.includes('TreeRosterPlanner'), 'the pre-flight modal is incomplete');
  check('44h: the roster planner offers balance + absent actions',
    plannerSrc44.includes('Chia đều 4 cây') && plannerSrc44.includes('Vắng mặt'),
    'the planner actions are missing');
  check('44h: the lobby renders a QR, the PIN and the start button',
    lobbySrc44.includes('TreeQrCode') && lobbySrc44.includes('session_code')
      && lobbySrc44.includes('BẮT ĐẦU THI ĐẤU'),
    'the lobby view is incomplete');
  check('44h: the projector branches on the lobby status',
    projectorSrc44.includes("status === 'LOBBY'") && projectorSrc44.includes('TreeLobby'),
    'the projector lobby branch is missing');
  check('44h: the SPA has spectator and lobby cards in its markup',
    spaHtml44.includes('id="treeSpectatorCard"') && spaHtml44.includes('id="treeLobbyCard"'),
    'the SPA cards are missing');
  check('44h: the SPA subscribes to tree_sessions for the lobby promotion',
    spaSrc44.includes("table: 'tree_sessions'") && spaSrc44.includes('subscribeTreeSessionChannel'),
    'the session subscription is missing');
  check('44h: the SPA renders a mode-specific prompt and a countdown',
    spaSrc44.includes('applyTreeModePresentation')
      && spaSrc44.includes("gameMode === 'SPEED_QUIZ'")
      && spaSrc44.includes('startTreeCountdown'),
    'the SPA game-mode branch is missing');
  check('44h: the SPA maps the new refusal codes to the lobby/spectator states',
    spaSrc44.includes("payload.code === 'NOT_STARTED'")
      && spaSrc44.includes("payload.code === 'STUDENT_ABSENT'"),
    'the SPA does not handle the new refusal codes');

  // --- 44i. cleanup ------------------------------------------------------
  await teacher.from('tree_sessions').delete().eq('id', lobbySessionId);
  const lobbyClassDelete = await teacher.from('classes').delete().eq('id', lobbyClassId);
  check('44i: the lobby test class deletes once its sessions are gone',
    !lobbyClassDelete.error, lobbyClassDelete.error?.message);
  await teacher.from('exams').delete().eq('code', LOBBY_EXAM_CODE);

  /* --- 45. Natural roster assignment & adaptive brainstorm target (9.2) -- */
  // The arena's planning rules, exercised on their pure homes:
  //   * opening the modal must preserve the class's own `team_number` layout
  //     rather than re-shuffling it;
  //   * "Chia đều 4 cây" is the ONLY balancing path;
  //   * a BRAINSTORM target tracks the LARGEST present team, and a team's
  //     vitality/completion is normalised against its OWN present headcount.
  step(45, 'natural roster assignment + adaptive brainstorm target score');

  // A roster whose natural split is deliberately UNEVEN and NOT round-robin
  // ordered, so any accidental modulo-4 redistribution is visible: Tổ 1 has 3
  // members, Tổ 2 has 1, Tổ 3 has 2, Tổ 4 has 0. `group_number` is the value the
  // Phase 9.3 resolver reads FIRST, so it is set consistently with the intended
  // Tổ (`((group - 1) % 4) + 1`), with `team_number` carried along to prove it is
  // ignored when a group exists.
  const planMembers = [
    { id: 'm1', team_number: 1, group_number: 1 }, // (1-1)%4+1 = 1
    { id: 'm2', team_number: 1, group_number: 5 }, // (5-1)%4+1 = 1
    { id: 'm3', team_number: 1, group_number: 1 }, // 1
    { id: 'm4', team_number: 2, group_number: 2 }, // 2
    { id: 'm5', team_number: 3, group_number: 3 }, // 3
    { id: 'm6', team_number: 3, group_number: 7 }, // (7-1)%4+1 = 3
  ];

  // --- 45a. initial state preserves the natural teams -------------------
  const initialAssignments = buildInitialAssignments(planMembers);
  check('45a: buildInitialAssignments preserves every member\'s natural team_number',
    initialAssignments.m1 === 1 && initialAssignments.m2 === 1 && initialAssignments.m3 === 1
      && initialAssignments.m4 === 2 && initialAssignments.m5 === 3 && initialAssignments.m6 === 3,
    JSON.stringify(initialAssignments));
  check('45a: it does NOT modulo-4 distribute (m5 keeps Tổ 3, not the index-derived 1)',
    initialAssignments.m5 === 3 && initialAssignments.m5 !== (4 % 4) + 1,
    JSON.stringify(initialAssignments));
  // The natural split must survive into countActiveMembersPerTeam untouched.
  const naturalCounts = countActiveMembersPerTeam(planMembers, { absent_ids: [], assignments: initialAssignments });
  check('45a: the natural split is 3/1/2/0, not balanced',
    naturalCounts[1] === 3 && naturalCounts[2] === 1
      && naturalCounts[3] === 2 && naturalCounts[4] === 0,
    JSON.stringify(naturalCounts));

  // Phase 9.3 — `group_number` is read FIRST. With both fields present (and in
  // conflict) the group wins; `team_number` is consulted only when the group is
  // missing/null.
  const priorityAssignments = buildInitialAssignments([
    { id: 'g1', team_number: 2, group_number: 1 }, // group wins -> 1 (not 2)
    { id: 'g2', team_number: 4, group_number: 5 }, // group wins -> 1 (not 4)
    { id: 'g3', team_number: null, group_number: 4 }, // (4-1)%4+1 = 4
  ]);
  check('45a: group_number is prioritized over a conflicting team_number',
    priorityAssignments.g1 === 1 && priorityAssignments.g2 === 1 && priorityAssignments.g3 === 4,
    JSON.stringify(priorityAssignments));
  const teamFallback = buildInitialAssignments([
    { id: 't1', team_number: 2, group_number: null }, // -> team_number
    { id: 't2', team_number: 3, group_number: undefined }, // -> team_number
    { id: 't3', team_number: null, group_number: null }, // -> 1
  ]);
  check('45a: a missing group_number falls back to team_number, else 1',
    teamFallback.t1 === 2 && teamFallback.t2 === 3 && teamFallback.t3 === 1,
    JSON.stringify(teamFallback));

  // --- 45b. explicit "Chia đều 4 cây" balances the present members -------
  const balancedByClick = balanceTeamAssignments(planMembers, [], initialAssignments);
  const balancedClickCounts = countActiveMembersPerTeam(
    planMembers, { absent_ids: [], assignments: balancedByClick });
  const balancedValues = Object.values(balancedClickCounts);
  check('45b: an explicit balance spreads 6 members as 2/2/1/1 (max-min <= 1)',
    Math.max(...balancedValues) - Math.min(...balancedValues) <= 1
      && balancedValues.reduce((sum, n) => sum + n, 0) === 6,
    JSON.stringify(balancedClickCounts));
  check('45b: balance overrides the natural teams it re-partitions (m4 leaves Tổ 2)',
    balancedByClick.m4 !== initialAssignments.m4 || balancedClickCounts[2] === 2,
    JSON.stringify({ natural: initialAssignments.m4, balanced: balancedByClick.m4 }));

  // Balancing only the PRESENT members: with m1 absent, the remaining 5 split
  // 2/1/1/1 and the absent member keeps their prior value.
  const balancedWithAbsent = balanceTeamAssignments(planMembers, ['m1'], initialAssignments);
  const absentCounts = countActiveMembersPerTeam(
    planMembers, { absent_ids: ['m1'], assignments: balancedWithAbsent });
  check('45b: an absent member is excluded from the balance and keeps their old team',
    absentCounts[1] + absentCounts[2] + absentCounts[3] + absentCounts[4] === 5
      && Math.max(...Object.values(absentCounts)) - Math.min(...Object.values(absentCounts)) <= 1
      && balancedWithAbsent.m1 === 1,
    JSON.stringify({ counts: absentCounts, m1: balancedWithAbsent.m1 }));

  // --- 45c. brainstorm target = max(activeTeamCounts) -------------------
  check('45c: the brainstorm target tracks the LARGEST present team (3)',
    brainstormTargetScore(naturalCounts) === 3, String(brainstormTargetScore(naturalCounts)));
  check('45c: an empty arena floors the target at 1',
    brainstormTargetScore({ 1: 0, 2: 0, 3: 0, 4: 0 }) === 1,
    String(brainstormTargetScore({ 1: 0, 2: 0, 3: 0, 4: 0 })));
  // Reassignment reacts: balancing to 2/2/1/1 drops the target from 3 to 2.
  check('45c: re-partitioning to 2/2/1/1 lowers the auto target to 2',
    brainstormTargetScore(balancedClickCounts) === 2, String(brainstormTargetScore(balancedClickCounts)));
  // Marking a member of the largest Tổ absent recomputes it too.
  const afterAbsent = countActiveMembersPerTeam(
    planMembers, { absent_ids: ['m3'], assignments: initialAssignments });
  check('45c: marking the 3-member Tổ down to 2 recomputes the target to 2',
    brainstormTargetScore(afterAbsent) === 2, String(brainstormTargetScore(afterAbsent)));

  // --- 45d. per-team vitality normalises against the team's OWN headcount --
  // Tổ 1 has 3 present; answering all 3 reaches 100% / the Golden Latch.
  const teamProgress = (accepted, active) => computeTeamProgress({
    gameMode: 'BRAINSTORM', acceptedCount: accepted, activeMembersCount: active,
    targetScore: brainstormTargetScore(naturalCounts),
  });
  check('45d: a Tổ with 3 present reaches 100% when all 3 have answered',
    teamProgress(3, 3).progress === 1 && teamProgress(3, 3).isFinished === true,
    JSON.stringify(teamProgress(3, 3)));
  check('45d: the same Tổ at 2/3 is 66.7% and NOT finished',
    Math.abs(teamProgress(2, 3).progress - 2 / 3) < 1e-9
      && teamProgress(2, 3).isFinished === false,
    JSON.stringify(teamProgress(2, 3)));
  // A team whose fifth member is absent still finishes on its four present.
  check('45d: a Tổ of 4 present + 1 absent finishes at 4 answers, not 5',
    teamProgress(4, 4).isFinished === true && teamProgress(4, 4).progress === 1,
    JSON.stringify(teamProgress(4, 4)));
  check('45d: an entirely absent Tổ can never finish and divides by 1',
    teamProgress(0, 0).isFinished === false && teamProgress(0, 0).denominator === 1,
    JSON.stringify(teamProgress(0, 0)));
  // SPEED_QUIZ keeps the explicit target score as the denominator.
  const speedProgress = computeTeamProgress({
    gameMode: 'SPEED_QUIZ', acceptedCount: 20, activeMembersCount: 1, targetScore: 20 });
  check('45d: SPEED_QUIZ completes on the explicit target_score, ignoring headcount',
    speedProgress.isFinished === true && speedProgress.progress === 1
      && speedProgress.denominator === 20,
    JSON.stringify(speedProgress));

  // --- 45e. the components are wired to these rules ---------------------
  const plannerSrc45 = readFileSync(
    new URL('../web/src/components/tree/TreeRosterPlanner.tsx', import.meta.url), 'utf8');
  const modalSrc45 = readFileSync(
    new URL('../web/src/components/tree/CreateTreeSessionModal.tsx', import.meta.url), 'utf8');
  const projectorSrc45 = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');

  check('45e: the modal seeds the config from buildInitialAssignments (not a balance)',
    modalSrc45.includes('buildInitialAssignments(loaded)')
      && !modalSrc45.includes('balanceTeamAssignments(loaded'),
    'the modal must seed the natural teams on load');
  check('45e: the planner\'s balance button is the only caller of balanceTeamAssignments',
    plannerSrc45.includes('balanceTeamAssignments(members, config.absent_ids, config.assignments)'),
    'the explicit balance handler is missing');
  check('45e: the modal binds target_score to brainstormAutoTarget when in BRAINSTORM',
    modalSrc45.includes('brainstormAutoTarget')
      && modalSrc45.includes("if (gameMode === 'BRAINSTORM') setTargetScore(brainstormAutoTarget)"),
    'the auto target sync is missing');
  check('45e: the target score is a SPEED_QUIZ-only field (BRAINSTORM hides it)',
    modalSrc45.includes("id=\"targetScoreInput\"")
      && modalSrc45.includes('isSpeedQuiz && (')
      && modalSrc45.includes('parseInt(event.target.value, 10) || 20'),
    'the SPEED_QUIZ-only target input is missing');
  check('45e: the projector normalises vitality per team via computeTeamProgress',
    projectorSrc45.includes('computeTeamProgress({')
      && projectorSrc45.includes('activeMembersCount: activeMembersPerTeam[team] ?? 0'),
    'the per-team denominator is missing from the projector');
  check('45e: the projector derives activeMembersPerTeam from the participant config',
    projectorSrc45.includes('countActiveMembersPerTeam(session.roster, session.participant_config)'),
    'the projector must exclude absentees from the denominator');

  /* --- 46. group_number priority & brainstorm target UI (9.3) ------------ */
  // Two Phase 9.3 fixes: (1) `buildInitialAssignments` must read `group_number`
  // BEFORE the legacy `team_number`, so a class partitioned 12/12/12/10 by the
  // roster's groups is preserved exactly — reading `team_number` first would
  // yield 12/12/11/11 whenever the legacy arena values disagree; (2) the target
  // score is a SPEED_QUIZ-only field, hidden entirely in BRAINSTORM (the value is
  // still derived and saved silently to satisfy the DB CHECK).
  step(46, 'group_number priority in assignments + brainstorm target score UI');

  // --- 46a. a 46-member class partitioned 12/12/12/10 by group_number -----
  // `group_number` 1..4 maps onto Tổ 1..4; the `team_number` values deliberately
  // CONFLICT (legacy: everyone still carries team 4, or a stale 1..3), so any
  // implementation that reads `team_number` first collapses to 12/12/11/11 or
  // worse.
  const GROUP_PLAN = [
    { group: 1, count: 12, legacyTeam: 4 },
    { group: 2, count: 12, legacyTeam: 4 },
    { group: 3, count: 12, legacyTeam: 3 },
    { group: 4, count: 10, legacyTeam: 4 },
  ];
  const groupPlanMembers = [];
  GROUP_PLAN.forEach(({ group, count, legacyTeam }) => {
    for (let i = 0; i < count; i += 1) {
      groupPlanMembers.push({
        id: `g${group}m${i}`,
        team_number: legacyTeam,
        group_number: group,
      });
    }
  });
  check('46a: the fixture holds 46 members', groupPlanMembers.length === 46,
    String(groupPlanMembers.length));

  const groupAssignments = buildInitialAssignments(groupPlanMembers);
  const groupCounts = countActiveMembersPerTeam(
    groupPlanMembers, { absent_ids: [], assignments: groupAssignments });
  check('46a: buildInitialAssignments yields 12/12/12/10 from group_number (NOT 12/12/11/11)',
    groupCounts[1] === 12 && groupCounts[2] === 12
      && groupCounts[3] === 12 && groupCounts[4] === 10,
    JSON.stringify(groupCounts));
  check('46a: the four Tổ sum to the class size (46)',
    groupCounts[1] + groupCounts[2] + groupCounts[3] + groupCounts[4] === 46,
    JSON.stringify(groupCounts));
  // If `team_number` had won, Tổ 4 would have held 34 (everyone with legacy 4).
  check('46a: the conflicting legacy team_number was ignored for every member',
    groupAssignments.g1m0 === 1 && groupAssignments.g2m0 === 2
      && groupAssignments.g3m0 === 3 && groupAssignments.g4m0 === 4,
    JSON.stringify({
      g1: groupAssignments.g1m0, g2: groupAssignments.g2m0,
      g3: groupAssignments.g3m0, g4: groupAssignments.g4m0,
    }));

  // --- 46b. Tổ 4 (10 members) reaches 100% at exactly 10 answers ----------
  const target46 = brainstormTargetScore(groupCounts);
  check('46b: the auto brainstorm target is the largest Tổ (12)',
    target46 === 12, String(target46));
  const team4Progress = computeTeamProgress({
    gameMode: 'BRAINSTORM',
    acceptedCount: 10,
    activeMembersCount: 10,
    targetScore: target46,
  });
  check('46b: Tổ 4 with 10 present reaches 100% when 10 have answered',
    team4Progress.progress === 1 && team4Progress.isFinished === true
      && team4Progress.denominator === 10,
    JSON.stringify(team4Progress));
  check('46b: Tổ 4 at 9/10 is NOT finished',
    computeTeamProgress({
      gameMode: 'BRAINSTORM', acceptedCount: 9, activeMembersCount: 10, targetScore: target46,
    }).isFinished === false,
    'a Tổ one answer short must not finish');
  // A larger Tổ completes on ITS OWN headcount, independent of Tổ 4's.
  const team1Progress = computeTeamProgress({
    gameMode: 'BRAINSTORM', acceptedCount: 12, activeMembersCount: 12, targetScore: target46,
  });
  check('46b: Tổ 1 with 12 present finishes at 12, not at the 10 of Tổ 4',
    team1Progress.isFinished === true && team1Progress.denominator === 12,
    JSON.stringify(team1Progress));

  // --- 46c. the target-score field is SPEED_QUIZ-only ---------------------
  const modalSrc46 = readFileSync(
    new URL('../web/src/components/tree/CreateTreeSessionModal.tsx', import.meta.url), 'utf8');
  const projectorSrc46 = readFileSync(
    new URL('../web/src/components/tree/TreeProjector.tsx', import.meta.url), 'utf8');
  const lobbySrc46 = readFileSync(
    new URL('../web/src/components/tree/TreeLobby.tsx', import.meta.url), 'utf8');
  const spaSrc46 = readFileSync(new URL('../student/app.js', import.meta.url), 'utf8');

  check('46c: the modal renders the target input only inside `{isSpeedQuiz && (...)}`',
    modalSrc46.includes('{isSpeedQuiz && (')
      && modalSrc46.includes('id="targetScoreInput"'),
    'the target input is not gated on SPEED_QUIZ');
  check('46c: BRAINSTORM renders no target-score read-only badge',
    !modalSrc46.includes('Tự động theo sĩ số tổ'),
    'the BRAINSTORM target badge must be removed');
  check('46c: BRAINSTORM still derives and saves target_score silently',
    modalSrc46.includes("if (gameMode === 'BRAINSTORM') setTargetScore(brainstormAutoTarget)")
      && modalSrc46.includes('target_score: targetScore'),
    'the silent save path is missing');
  check('46c: the projector labels progress as `đã nộp` in BRAINSTORM, `điểm` in SPEED_QUIZ',
    projectorSrc46.includes('đã nộp') && projectorSrc46.includes('điểm')
      && projectorSrc46.includes("const isBrainstorm = session.game_mode === 'BRAINSTORM'"),
    'the mode-aware progress label is missing');
  check('46c: the lobby renders no target-score badge',
    !lobbySrc46.includes('target_score'),
    'the lobby must not surface a target score');
  check('46c: the SPA shows the target only for SPEED_QUIZ',
    spaSrc46.includes("? `⚡ Đua tốc độ · Mục tiêu ${session.targetScore} điểm`")
      && spaSrc46.includes(": '💡 Bão não từ khóa'"),
    'the SPA mode badge must not show a target in BRAINSTORM');

  /* --- 47. procedural 3D tree engine & simulator sandbox (Phase 10.0) ---- */
  step(47, 'procedural 3D tree engine and interactive simulator sandbox');

  const { TEAM_3D_PALETTES, captureCanvasSnapshot } = await import(
    new URL('../web/src/lib/tree3d.ts', import.meta.url).href
  );

  // --- 47a. TEAM_3D_PALETTES has 4 distinct team palettes with valid hex colors ---
  check('47a: TEAM_3D_PALETTES has 4 team palettes',
    [1, 2, 3, 4].every((t) => !!TEAM_3D_PALETTES[t]),
    JSON.stringify(Object.keys(TEAM_3D_PALETTES)));

  const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
  for (const team of [1, 2, 3, 4]) {
    const pal = TEAM_3D_PALETTES[team];
    check(`47a: team ${team} trunk is valid hex`, HEX_COLOR_REGEX.test(pal.trunk), pal.trunk);
    check(`47a: team ${team} trunkDark is valid hex`, HEX_COLOR_REGEX.test(pal.trunkDark), pal.trunkDark);
    check(`47a: team ${team} foliageBase is valid hex`, HEX_COLOR_REGEX.test(pal.foliageBase), pal.foliageBase);
    check(`47a: team ${team} foliageHighlight is valid hex`, HEX_COLOR_REGEX.test(pal.foliageHighlight), pal.foliageHighlight);
    check(`47a: team ${team} dew is valid hex`, HEX_COLOR_REGEX.test(pal.dew), pal.dew);
    check(`47a: team ${team} pedestalGlow is valid hex`, HEX_COLOR_REGEX.test(pal.pedestalGlow), pal.pedestalGlow);
    check(`47a: team ${team} goldenAura is valid hex`, HEX_COLOR_REGEX.test(pal.goldenAura), pal.goldenAura);
  }

  // Ensure palettes are distinct across teams
  const dewColors = [1, 2, 3, 4].map((t) => TEAM_3D_PALETTES[t].dew);
  const uniqueDewColors = new Set(dewColors);
  check('47a: all 4 teams have distinct dew drop colors', uniqueDewColors.size === 4, JSON.stringify(dewColors));

  // --- 47b. captureCanvasSnapshot exists and creates valid download anchors ---
  check('47b: captureCanvasSnapshot is a callable function', typeof captureCanvasSnapshot === 'function', typeof captureCanvasSnapshot);

  let clicked = false;
  let createdTag = '';
  let anchorProps = {};
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (tag) => {
      createdTag = tag;
      return {
        set download(val) { anchorProps.download = val; },
        get download() { return anchorProps.download; },
        set href(val) { anchorProps.href = val; },
        get href() { return anchorProps.href; },
        click: () => { clicked = true; }
      };
    }
  };

  const mockCanvas = {
    toDataURL: (mime) => `data:${mime};base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`
  };

  captureCanvasSnapshot(mockCanvas, 'arena-3d-test.png');
  check('47b: captureCanvasSnapshot created an anchor element', createdTag === 'a', createdTag);
  check('47b: download filename is set correctly', anchorProps.download === 'arena-3d-test.png', anchorProps.download);
  check('47b: download href contains image/png data url', anchorProps.href.startsWith('data:image/png;base64,'), anchorProps.href);
  check('47b: download anchor click was triggered', clicked === true, String(clicked));
  globalThis.document = prevDoc;

  // --- 47c. Legacy 2D TreeCanvas.tsx is completely untouched ---
  const legacy2DSrc = readFileSync(
    new URL('../web/src/components/tree/TreeCanvas.tsx', import.meta.url), 'utf8');
  check('47c: legacy TreeCanvas.tsx still uses TreeRenderer', legacy2DSrc.includes('TreeRenderer'), 'TreeRenderer missing');
  check('47c: legacy TreeCanvas.tsx does not import @react-three/fiber', !legacy2DSrc.includes('@react-three/fiber'), 'contains R3F');
  check('47c: legacy TreeCanvas.tsx does not import three', !legacy2DSrc.includes("from 'three'") && !legacy2DSrc.includes('from "three"'), 'contains three');
  check('47c: legacy TreeCanvas.tsx preserves exportImage method', legacy2DSrc.includes('exportImage'), 'exportImage missing');

  // --- 47d. Procedural 3D Tree and Arena Stage architecture checks ---
  const tree3DSrc = readFileSync(
    new URL('../web/src/components/tree/three/ProceduralTree3D.tsx', import.meta.url), 'utf8');
  const stage3DSrc = readFileSync(
    new URL('../web/src/components/tree/three/ArenaStage3D.tsx', import.meta.url), 'utf8');
  const simPageSrc = readFileSync(
    new URL('../web/src/app/tree/simulator/page.tsx', import.meta.url), 'utf8');

  check('47d: ProceduralTree3D is marked use client', tree3DSrc.includes("'use client'"), 'missing use client');
  check('47d: ProceduralTree3D uses useFrame and Math.sin for harmonic sway without clock deprecation',
    tree3DSrc.includes('useFrame') && tree3DSrc.includes('Math.sin') && tree3DSrc.includes('state.clock.elapsedTime'),
    'missing useFrame/Math.sin/elapsedTime');
  check('47d: ProceduralTree3D renders volumetric cylinder and faceted icosahedron geometries',
    tree3DSrc.includes('cylinderGeometry') && tree3DSrc.includes('icosahedronGeometry'), 'missing geometries');
  check('47d: ProceduralTree3D implements golden latch aura and runic base ring',
    tree3DSrc.includes('isGoldenLatch') && tree3DSrc.includes('ringGeometry'), 'missing golden latch aura');

  check('47d: ArenaStage3D enables shadows with PCFShadowMap and in-scene background color for clean snapshots',
    stage3DSrc.includes('PCFShadowMap') && stage3DSrc.includes('attach="background"') && stage3DSrc.includes('preserveDrawingBuffer: true'),
    'missing PCFShadowMap/background/preserveDrawingBuffer');
  check('47d: ArenaStage3D renders floating island diorama with atmospheric fog and sparkles',
    stage3DSrc.includes('<fog') && stage3DSrc.includes('<Sparkles') && stage3DSrc.includes('cylinderGeometry'),
    'missing diorama/fog/sparkles');
  check('47d: ArenaStage3D configures 4 symmetric tree positions',
    stage3DSrc.includes('[-6.3, 0, 0]') && stage3DSrc.includes('[6.3, 0, 0]'), 'missing 4 tree positions');

  check('47d: Simulator page uses dynamic import with ssr: false for Canvas safety',
    simPageSrc.includes('dynamic(') && simPageSrc.includes('ssr: false'), 'missing dynamic ssr:false');
  check('47d: Simulator page includes 4 range sliders and action triggers',
    simPageSrc.includes('type="range"') && simPageSrc.includes('handleSliderChange') && simPageSrc.includes('handleAddDew'),
    'missing sliders/actions');
  check('47d: Simulator page includes snapshot trigger with captureCanvasSnapshot',
    simPageSrc.includes('captureCanvasSnapshot') && simPageSrc.includes('handleSnapshot'), 'missing snapshot handler');

  /* --- teardown --------------------------------------------------------- */
  await teacher.removeChannel(channel);
  await teacher.from('exams').delete().eq('code', EXAM.code); // cascades
  await teacher.from('exams').delete().eq('code', SCHED_EXAM.code);
  await teacher.from('exams').delete().eq('code', EDIT_EXAM.code);
  await teacher.from('exams').delete().eq('code', HARD_DEL_EXAM.code);
  await teacher.from('exams').delete().eq('code', SOFT_DEL_EXAM.code);
  await teacher.from('exams').delete().eq('code', PRACTICE_EXAM.code);
  await teacher.from('exams').delete().eq('code', PIN_EXAM.code);
  await teacher.from('exams').delete().eq('code', CLASS_EXAM.code);
  // Phase 6.3 — roster-picker fixtures. The empty-roster exam is deleted by its
  // random code; the rest are named constants. `filter(Boolean)` keeps a failed
  // insert (undefined code) from serialising a bogus `null` into the IN list.
  await teacher.from('exams').delete().in('code', [
    ROSTER_EXAM.code,
    ROSTER_TRASH_EXAM.code,
    ROSTER_CLOSED_EXAM.code,
    ROSTER_NOT_STARTED_EXAM.code,
    ROSTER_ENDED_EXAM.code,
    rosterEmptyExam.data?.code,
  ].filter(Boolean));
  // The class outlives its exams; delete it explicitly (members cascade).
  await teacher.from('classes').delete().eq('id', classId);
  await teacher.from('classes').delete().eq('id', webClassId);
  // Phase 8.9/8.10 — the constant-named rosters seeded by Steps 2, 32b and 41.
  // Deleted by NAME because a failed insert leaves `canClassId`/`gateClassId`
  // undefined and the rows must not survive into the next run.
  await teacher.from('classes').delete().in('name', [STUDENT.className, CAN_CLASS]);
  // Phase 8.11 — Step 43's scaffold is deleted in-step; this is the safety net
  // for an aborted run (the name carries a random suffix, so match the prefix).
  await teacher.from('classes').delete().like('name', 'E2E-GRP-%');
  // Phase 9.1 — Step 44's scaffold, same safety net (tree_sessions cascade).
  await teacher.from('classes').delete().like('name', 'E2E-LOBBY-%');

  console.log(`\n${'='.repeat(74)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) console.log(`Failed: ${failures.join(' | ')}`);
  console.log('='.repeat(74));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFATAL:', error);
  process.exit(1);
});
