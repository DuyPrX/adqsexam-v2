# Change Report: Tree of Knowledge — Schema, Realtime & Similarity RPC

- **Date:** 2026-10-05
- **Scope:** Major Change
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Backend for the "Cây tri thức" activity: two tables
  (`tree_sessions` linked to `classes`, `tree_submissions`), a `pg_trgm`-based
  similarity gate, a student RPC (`submit_tree_answer`) enforcing a minimum word
  count and a duplication ceiling, and Realtime so the tree grows live.
- **Root Cause / Motivation:** The activity is a new interactive surface with no
  existing schema. The design goal is that the tree accumulates **distinct**
  ideas, so an answer that merely restates something already submitted is
  rejected rather than drawn as another fruit. That makes text similarity a
  correctness requirement, not a nicety — hence the DB-level enforcement rather
  than a client-side check.

## 2. Technical Implementation Details

### Three defects in the supplied DDL, each proven locally before writing code

**(1) The RLS policy could never have worked — `permission denied`.**
The draft's `tree_submissions` SELECT policy used an inline
`EXISTS (SELECT 1 FROM public.tree_sessions s WHERE s.id = tree_submissions.session_id)`.
A policy predicate is evaluated **as the querying role**, and `anon` holds no
privilege on `tree_sessions` (Section B revokes it). Reproduced against the local
stack:

```
=== VARIANT 1: spec policy (inline EXISTS on the RLS parent) ===
ERROR:  permission denied for table parent
```

So the *entire* "students can see the tree" feature would have failed at
runtime with a database permission error. Fixed with a `SECURITY DEFINER` helper
`tree_session_is_public(uuid)` that runs as the table owner and therefore sees
past both the table ACL and the parent's RLS (Variant 2 returned the row
correctly). The helper is `stable` and returns `false` — never NULL — for an
unknown id.

**(2) `pg_trgm` schema placement is environment-dependent.**
`create extension pg_trgm` installs into whichever schema is first on the
installer's `search_path`. On this stack `pgcrypto` already lives in
`extensions`, yet `pg_trgm` landed in `public` — exactly the ambiguity that makes
this fragile. Two call sites depend on the location:
- `similarity()` inside the RPC, whose `search_path` is pinned to
  `public, pg_temp` — a probe confirmed it does **not** resolve there when the
  extension is in `extensions`;
- the `gin_trgm_ops` operator class in `CREATE INDEX`, which resolves against the
  current `search_path` at build time.

Worse, `create extension if not exists` is a **no-op** when a prior script already
installed it elsewhere, so `with schema extensions` alone does not guarantee the
location. Fixed with an unconditional `alter extension pg_trgm set schema
extensions` (idempotent) and by schema-qualifying every call site
(`extensions.similarity`, `extensions.gin_trgm_ops`). The failure mode here was
runtime-only (`undefined_function`), which no create-time test would have caught.

**(3) `real` vs `numeric` comparison.**
The draft declared `v_max_sim REAL` and compared it to `max_similarity
NUMERIC(3,2)`. The comparison resolves via an implicit cast but compares
differently-typed values; retyped `v_max_sim` as `numeric`.

### Implementation notes
- **`submit_tree_answer(uuid, varchar, varchar, text)`** is the single student
  write path. Returns a jsonb envelope (`{success, code, ...}`) rather than
  `RAISE`ing, matching `get_exam_roster` / `verify_and_acquire_session` so the
  client has one error shape. Codes: `SESSION_NOT_FOUND`, `SESSION_INACTIVE`,
  `SESSION_EXPIRED`, `IDENTITY_REQUIRED`, `MIN_WORDS_NOT_MET`,
  `SIMILARITY_EXCEEDED`.
- **Similarity excludes the caller's own row** (`student_code <>`). Without that,
  a student editing their answer would be compared against their own previous
  text and could never improve it.
- **Resubmission preserves `fruit_index`.** `ON CONFLICT (session_id,
  student_code) DO UPDATE` rewrites the text/word count but not the ordinal, so a
  student's fruit keeps its place on the tree instead of jumping to the end.
- **`IDENTITY_REQUIRED`** is an addition beyond the draft: a blank/whitespace
  student code would otherwise interact with the UNIQUE constraint in confusing
  ways.
- **`make_interval(mins => …)`** replaces the draft's
  `(integer || ' minutes')::interval`, removing a dependency on integer→text
  casting and a locale-independent interval parser.
- **Realtime.** `tree_submissions` is added to the `supabase_realtime`
  publication (guarded — `add table` raises 42710 when already a member) and set
  to `replica identity full`, because clients filter on `session_id` (a non-key
  column) and resubmissions arrive as UPDATEs; with the default identity those
  events would be silently dropped.
- **Constraints.** `max_similarity` is CHECKed to `(0, 1]` — `0` would reject
  every answer, since a text is always 100% similar to itself. `min_words` and
  `time_limit_minutes` must be positive. `class_id` is `ON DELETE RESTRICT` so a
  shared class roster cannot cascade into destroying activity data.

## 3. Impacted Files
- `supabase/migrations/20261005120000_tree_of_knowledge_core.sql` (**new**): the
  extension, both tables, indexes, RLS + the predicate helper, the RPC, grants,
  and the Realtime publication.
- `supabase/schema.sql`: §extension block, §A.9/§A.10 tables, §A.7 indexes,
  §B RLS + helper + table hardening, §C.16 RPC, §D grants, §D.2 publication.
- `tests/e2e_flow_verification.mjs`: Step 28 (35 assertions) + header doc.

## 4. Verification & Testing
- **Test Commands Executed:**
  - Migration applied via `docker exec -i supabase_db_v2 psql …` — exit 0, then
    re-applied to prove idempotency (exit 0).
  - `schema.sql` applied end-to-end to `postgres` — exit 0.
  - Behavioural probes for trigram scores and the RLS variants (see §2).
  - `node v2/tests/e2e_flow_verification.mjs`.
- **Results:** `RESULT: 367 passed, 0 failed` (was 332; **+35** from Step 28).
  Step 28 covers: a 5-member class + session fixture; `min_words` rejection with
  both counts and a whitespace-padding case; first accepted answer →
  `fruit_index = 1`; identical **and** one-word-edit (0.946) answers both
  rejected as `SIMILARITY_EXCEEDED` with a percentage, and rejected attempts
  provably not growing the tree; a genuinely different answer (0.202) accepted →
  `fruit_index = 2`; resubmission reusing the same `submission_id` and keeping
  `fruit_index = 1`; ordinals 1 and 2 with no gap; **anon reading the tree
  through the SECURITY DEFINER policy** while being denied `tree_sessions`
  directly (the assertion that would have failed with the draft policy); closed
  / unknown / expired / blank-identity error branches; the `class_id` RESTRICT
  rule and the `(session_id, student_code)` UNIQUE (both probed over SQL, since
  PostgREST cannot reach `pg_catalog` and `authenticated` has no INSERT policy on
  the table by design); and Realtime publication membership plus `replica
  identity full`.
- **Rollback Strategy:** `drop table public.tree_submissions, public.tree_sessions
  cascade; drop function public.submit_tree_answer(uuid, varchar, varchar, text);
  drop function public.tree_session_is_public(uuid);` and
  `alter publication supabase_realtime drop table public.tree_submissions;`.
  Reverting the commit alone leaves the tables, which are additive and unused by
  any other feature. `pg_trgm` can stay installed harmlessly.

## 5. Notable Deviations
1. **The RLS policy uses a SECURITY DEFINER helper** instead of the draft's
   inline `EXISTS` — the draft form is a hard runtime failure (§2, defect 1).
2. **`extensions.` schema qualification throughout**, plus an unconditional
   `alter extension … set schema` — the draft's unqualified `similarity()` /
   `gin_trgm_ops` work only by accident of the local `search_path` (§2, defect 2).
3. **`EXAM_ENDED`-style code naming:** the draft used `SESSION_EXPIRED` for the
   time-limit branch, which this schema already uses consistently, so it was
   kept as-is. (`get_exam_roster` used `EXAM_EXPIRED` for the analogous case.)
4. **`IDENTITY_REQUIRED` added** (not in the draft) so a blank identity fails
   explicitly instead of hitting the UNIQUE constraint obliquely.
5. **A known race left in place, deliberately.** `max(fruit_index) + 1` is not
   atomic, so two simultaneous first-submissions could tie on the same ordinal.
   The UNIQUE constraint still prevents duplicate students; only the ordinal
   could tie, which is cosmetic on a classroom tree. Adding a serialisable lock
   would cost more than the defect is worth, so it is documented in the
   migration rather than silently accepted. Also worth noting: `max_similarity`
   is declared `NOT NULL` (the draft allowed NULL, which the RPC's `>` comparison
   would treat as "always pass") — making it `NOT NULL` removes that ambiguity.
