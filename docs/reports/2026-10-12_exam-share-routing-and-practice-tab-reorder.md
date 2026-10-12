# Change Report: Fix Exam Share Routing & Reorder Practice / Official Exam Tabs (Phase 10.5)

- **Date:** 2026-10-12
- **Scope:** Major Change
- **Author/Agent:** Antigravity Pair Programmer
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** 
  1. Fix exam share link routing so opening a shared exam link lands the user directly on the student test-taking interface / roster selection instead of redirecting them into the Tree of Knowledge Arena room (`/tree/[id]`).
  2. Swap UI tabs on the student landing screen so "Tự ôn luyện" (Practice Mode) sits on the left (Index 0 / First Tab) and "Phòng thi chính thức" (Official Exam Session) sits on the right (Index 1 / Second Tab), with intuitive default active state and left-to-right reading flow.
- **Root Cause / Motivation:** 
  - In `student/app.js`, `loadTreeFromUrl()` checked `params.get('code') || params.get('session') || params.get('tree')`. Because exam share links carry `?code=${exam.code}`, `loadTreeFromUrl()` intercepted the exam code, treated it as a Tree session token, invoked `switchView('tree')`, and prematurely exited `boot()`. This routed exam test-takers to the Tree Arena room and prevented `prefillFromUrl()` from ever executing.
  - The mode tabs had "Phòng thi chính thức" hardcoded on the left as the first child and "Tự ôn luyện" on the right.

## 2. Technical Implementation Details
- **Student Routing (`student/app.js`):**
  - Updated `loadTreeFromUrl()` to read strictly Tree session identifiers (`?tree=`, `?session=`, `?tree_code=`), reserving `?code=` exclusively for exam test-taking.
  - Updated `boot()` and `prefillFromUrl()`: if an exam code (`?code=` or `?c=`) is present in the query string, the official exam tab is activated (`selectModeTab('official')`) and `prefillFromUrl()` fetches the exam roster and meta banner. When no code is present, it defaults to the practice tab (`selectModeTab('practice')`).
- **Student UI Markup (`student/index.html`):**
  - Swapped tab button order in `.mode-tabs`: Tab 0 is now `#tabPractice` ("Tự ôn luyện", `is-active`, `aria-selected="true"`), Tab 1 is now `#tabOfficial` ("Phòng thi chính thức", `aria-selected="false"`).
  - `#practicePanel` is visible by default (`mode-panel`), while `#officialPanel` starts hidden (`mode-panel hidden`) when no exam code parameter is passed.
  - Kept DOM declaration order (`#officialPanel` before `#practicePanel`) to ensure strict compatibility with top-first AST string slicing assertions in e2e tests.
- **Pages & Web Gating (`student/_redirects`, `web/src/lib/supabase/session.ts`, and public redirect routes):**
  - Created `student/_redirects` on Cloudflare Pages to map `/exam/:code`, `/take/:code`, `/exams/:code/take`, and `/exams/:code` directly to `/?code=:code`.
  - Added public test-taking redirect pages in Next.js (`web/src/app/take/[code]/page.tsx`, `web/src/app/exam/[code]/page.tsx`, `web/src/app/exams/[code]/take/page.tsx`) that resolve the student SPA base URL and redirect.
  - Whitelisted `/take/`, `/exam/`, and `/exams/:code/take` in `session.ts` so unauthenticated visitors are not blocked by the teacher auth gate.
  - Updated comment in `web/src/components/tree/TreeProjector.tsx` to reflect the clean `?tree=`/`?session=` parameter spec.

## 3. Impacted Files
- `student/app.js`: Isolated `loadTreeFromUrl()` from `?code=`; auto-switched to official mode in `prefillFromUrl()`; updated `boot()` default tab behavior.
- `student/index.html`: Swapped tab order (Practice left, Official right) and adjusted default active styling/panels.
- `student/_redirects`: Added Cloudflare Pages redirect rules for standalone exam take paths.
- `web/src/lib/supabase/session.ts`: Added public exam take routes to whitelist and unauthenticated student redirect.
- `web/src/app/take/[code]/page.tsx`: Added public Next.js redirect to student SPA.
- `web/src/app/exam/[code]/page.tsx`: Added public Next.js redirect to student SPA.
- `web/src/app/exams/[code]/take/page.tsx`: Added public Next.js redirect to student SPA.
- `web/src/components/tree/TreeProjector.tsx`: Updated `loadTreeFromUrl` comment.
- `docs/modified_files.md`: Logged Phase 10.5 changes in engineering audit ledger.

## 4. Verification & Testing
- **Test Commands Executed:**
  - `npm run typecheck` in `v2/web`: Passed (0 errors).
  - `npm run build` in `v2/web`: Passed (production build compiled successfully; verified routes `/take/[code]`, `/exam/[code]`, `/exams/[code]/take`).
  - `node tests/e2e_flow_verification.mjs`: Passed (1,044 passed, 0 failed).
- **Results:**
  - All 1,044 assertions in the complete end-to-end regression suite pass cleanly with zero regressions.
- **Rollback Strategy:**
  - Git revert the commit or restore the modified files via `git checkout HEAD~1 -- student/ web/ docs/`.
