# ADQS EXAM V2 - SPECIFICATION & ROADMAP

## 1. TARGET ARCHITECTURE
The objective of ADQS Exam v2 is to decouple the monolithic Java Spring Boot
backend into an ultra-low latency, zero-maintenance, 100% serverless ecosystem
with zero fixed infrastructure costs.

The v1 repository (backend/, web-frontend/, student/, deploy/) is frozen as an
immutable, READ-ONLY business reference.

### System Topology:
- Student Client (Cloudflare Pages):
  - Whitelist Authentication (Student Code + Full Name + Class)
  - Session Concurrency Lock (20s Heartbeat via RPC)
  - Browser-lock Anti-Cheat (F11 Fullscreen, Tab Blur Tracking)
  --> Connects directly to Supabase via RPC
- Supabase PostgreSQL:
  - Multi-tenant tables with RLS (auth.uid() = user_id)
  - Atomic RPCs: verify_and_acquire_session, submit_exam_result
  - Supabase Realtime Channels for live proctoring & score updates
- Teacher Web (Next.js 16 on Vercel):
  - DOCX Upload with Dual-Engine Switch
  - Visual Preview & Inline Question Editor
  - Client-side exam shuffle & SheetJS Excel exporter
  --> Sends files to Cloudflare Worker for parsing
  --> Persists records directly to Supabase
- Core Extractor (Cloudflare Worker):
  - Fast unzip (fflate) and XML parsing (fast-xml-parser)
  - Engine 1: Pure Rule-Based Parser (<10ms CPU, $0 cost)
  - Engine 2: Fallback via Google AI Studio API (Gemini / Gemma)

---

## 2. IMMUTABLE ARCHITECTURAL INVARIANTS (F1 - F5, D1 - D4)

1. Zero Client-Side Answer Leakage (F1, F2, D1):
   - Answer keys (correct_answer, correctIndex, explanation) must NEVER reach
     the student browser during an active assessment.
   - Student test payload is fetched via get_student_exam_payload, which
     strips all correct answer fields.

2. Server-Authoritative Scoring (F3):
   - Client-calculated scores are completely rejected.
   - Evaluation is executed strictly within PostgreSQL via submit_exam_result
     (SECURITY DEFINER):
     * Multiple Choice (MCQ): 1.0 point per match.
     * True/False (4 sub-items): 4=1.0, 3=0.5, 2=0.25, 1=0.1.
     * Short Answer: Normalized string match (trim, lowercase, comma-to-dot).
     * Essay: 0 auto-points, flags record with needs_grading = true.

3. Dual-Engine Extraction Strategy:
   - Do NOT send every document to the AI API.
   - Engine 1 (Rule-Based): Fast regex + XML stream parsing. Handles 80-90%
     of standard formats in <50ms with 0 API tokens.
   - Engine 2 (AI Fallback): Google AI Studio API. Triggered only when
     mode=ai or when Engine 1 yields 0 questions or missing answers.

4. Semantic Tagging Superset (F5):
   - The parser wraps text runs in [CORRECT]...[/CORRECT] if marked by:
     Bold (w:b) OR Underline (w:u) OR Red Hex (FF*, EE*, C0*, c00000, red).

5. Essay Question Detection (F4):
   - The parser must classify un-optioned blocks or sections with keywords
     ("Tự luận", "Câu hỏi tự luận") as ESSAY.

6. Concurrency & Tab Reload Tolerance:
   - Active sessions are refreshed every 20s (60s expiration).
   - Reloading the page (F5) re-submits the stored session_token, extending
     the active session instead of locking the student out.
   - A different device attempting login while active is rejected.

7. Multi-Tenancy & Data Types:
   - Teacher tables (exams, question_bank) require:
     user_id UUID REFERENCES auth.users(id) with RLS enforced.
   - correct_answer must use JSONB to support scalar strings and boolean maps.

---

## 3. DECOMMISSIONED V1 COMPONENTS
The following legacy features are permanently pruned:
- Server-side OpenHTMLtoPDF rendering & embedded Tinos fonts.
- Server-side OMR bubble sheet generator and multi-variant DOCX generator.
- PortalIntegrationService (VnEdu/SMAS sync replaced by client-side SheetJS).
- Local loopback operations API, local Nginx, and Cloudflare Tunnel configs.

---

## 4. PHASED EXECUTION ROADMAP

### PHASE 1: SUPABASE DATA ARCHITECTURE & ATOMIC RPCS
- Target: v2/supabase/schema.sql
- Deliverables:
  1. DDL: exams, question_bank, students, active_sessions, exam_results,
     proctoring_snapshots, tags.
  2. Multi-tenant RLS policies gating teacher data to auth.uid() = user_id.
  3. RPC verify_and_acquire_session (with tab-refresh tolerance).
  4. RPC record_student_heartbeat (20s pulse with telemetry).
  5. RPC get_student_exam_payload (sanitized questions, no answer keys).
  6. RPC submit_exam_result (server-side scoring per MoET rules).
- Definition of Done (DoD):
  - Script executes cleanly in Supabase SQL Editor.
  - Test SQL calls verify sanitized questions and accurate scoring.

### PHASE 2: CLOUDFLARE WORKER DUAL-ENGINE PARSER
- Target: v2/worker/
- Deliverables:
  1. Hono TypeScript worker with nodejs_compat flag.
  2. xml-preprocessor.ts: fflate in-memory unzip (<128MB cap) and fast-xml-parser
     tagging (Bold + Underline + Red hex).
  3. rule-engine.ts: Regex delimiter parser for MCQ, True/False, Short Answer,
     and Essay.
  4. ai-engine.ts: Google AI Studio API fallback with structured JSON schema.
  5. index.ts: POST /api/v1/extract route supporting mode=rule|ai|auto.
- Definition of Done (DoD):
  - CPU time stays under 10ms on standard .docx files.
  - Passes test against sample/test2.docx with rule engine.

### PHASE 3: TEACHER WEB (NEXT.JS 16 ON VERCEL)
- Target: v2/web/
- Deliverables:
  1. Next.js 16 App Router setup with @supabase/ssr and Tailwind CSS v4.
  2. UploadZone.tsx: File dropzone with Fast vs AI engine switch.
  3. ExamPreviewEditor.tsx: Editable table for questions, distractors, and keys
     before committing to exams and question_bank.
  4. shuffle.ts: Client-side Fisher-Yates shuffle.
  5. excel.ts: Roster upload and 3-sheet result export via SheetJS.
- Definition of Done (DoD):
  - Clean build (npm run build) with zero TypeScript errors.
  - End-to-end flow: Upload -> Preview/Edit -> Save to Supabase.

### PHASE 4: STUDENT EXAM SPA (CLOUDFLARE PAGES)
- Target: v2/student/
- Deliverables:
  1. Static SPA using @supabase/supabase-js (no Firebase SDK).
  2. Whitelist login modal (Exam Code, Student Code, Full Name, Class).
  3. Session token storage in localStorage for reload safety.
  4. 20s heartbeat loop detecting concurrent logins.
  5. Anti-cheat locks: F11 fullscreen, blur counter, context menu block.
  6. Direct submission to submit_exam_result RPC.
- Definition of Done (DoD):
  - Verified protection against simultaneous logins across devices.
  - Network tab inspection reveals zero answer keys during exam.

### PHASE 5: REALTIME & DEPLOYMENT
- Deliverables:
  1. Supabase Realtime subscription on teacher dashboard for active alerts.
  2. Deployment: Vercel (web), Cloudflare Pages (student), Worker (extractor).
- Definition of Done (DoD):
  - Zero-maintenance serverless stack operating at $0 fixed cost.

---

## 5. TECHNICAL RISK MATRIX

- AI Rate Limits (15 RPM Free Tier):
  - Mitigation: Default to Rule-Based Engine for >85% of requests.
- Worker CPU Limit (>10ms CPU):
  - Mitigation: Decompress only word/document.xml with fflate, skip media.
- Accidental Student Lockout on Refresh:
  - Mitigation: Store session_token in localStorage and re-verify.
- Score Tampering via Client DevTools:
  - Mitigation: Scoring isolated in PostgreSQL SECURITY DEFINER RPC.
- V1 Codebase Corruption:
  - Mitigation: Root .gitignore excludes /v2/; treat v1 as read-only.