# Change Report: Teacher-Only RPC Grant Hardening (Phase 8.5 addendum)

- **Date:** 2026-10-06
- **Scope:** Major Change (database security / ACL)
- **Author/Agent:** TraeCode Agent
- **Status:** Verified

## 1. Context & Rationale
- **Objective:** Remove the stale `anon` EXECUTE grant from the five pre-existing
  teacher-only RPCs, so the privilege table matches the documented "teacher-only"
  intent.
- **Root Cause:** Phase 6.1 established (verified locally) that
  `revoke all … from public` does **not** strip `anon`'s grant, because Supabase's
  database default privileges grant EXECUTE to `anon` **directly** and an explicit
  grant survives a PUBLIC revoke. The fix was applied to `import_class_to_exam`
  only; five pre-existing teacher-only functions were left carrying the grant and
  were flagged for follow-up in
  `docs/roadmaps/ROADMAP_phase6.1_classes_and_pin_auth.md` (D-C).
- **Risk being closed:** the five functions are **not exploitable as written** —
  each rejects an anonymous caller inside its body via `auth.uid()`. The hazard is
  latent: the ACL advertised a privilege the design does not intend, so any future
  edit that weakened a body check would silently expose the function to `anon`.

## 2. Technical Implementation Details
- **Affected functions (signatures unchanged — no DROP/overload handling needed):**
  `update_exam_questions_safe(varchar, jsonb)`, `delete_exam(varchar)`,
  `restore_exam(varchar)`, `purge_expired_exams()`,
  `recalculate_exam_scores(varchar)`.
- **Change:** `revoke all on function … from anon;` for each, then an explicit
  `grant execute … to authenticated;` so the intent is self-documenting.
- **Migration:** `supabase/migrations/20261006010000_harden_teacher_rpc_grants.sql`
  — pure `revoke`/`grant`, idempotent (revoking an absent privilege is a no-op),
  applied locally with `ON_ERROR_STOP=1`.
- **`schema.sql`:** §D updated alongside `import_class_to_exam` so a fresh
  `db reset` produces the same ACL as the migration path.

## 3. Impacted Files
- `supabase/migrations/20261006010000_harden_teacher_rpc_grants.sql`: **New.**
- `supabase/schema.sql`: §D — five `from anon` revokes + explanatory comment.
- `tests/e2e_flow_verification.mjs`: Step 32a gained two assertions.
- `docs/roadmaps/ROADMAP_phase6.1_classes_and_pin_auth.md`: D-C marked resolved.

## 4. Verification & Testing
- **Commands:**
  - `Get-Content -Raw -Encoding UTF8 supabase/migrations/20261006010000_harden_teacher_rpc_grants.sql | docker exec -i supabase_db_v2 psql -U postgres -d postgres -v ON_ERROR_STOP=1`
  - a `has_function_privilege` sweep over the six teacher-only RPCs.
  - `node v2/tests/e2e_flow_verification.mjs`.
- **Results:**
  - Migration: 5 × `REVOKE`, 5 × `GRANT`, exit 0.
  - Privilege sweep: all five report `anon=false auth=true`;
    `import_class_to_exam` unchanged at `anon=false auth=true`.
  - Full suite: **632 passed, 0 failed** (630 baseline → **+2**).
  - New e2e assertions (Step 32a): none of the five is anon-executable, and all
    five remain executable by `authenticated` — so the grant cannot silently
    return on a future migration.
- **Rollback:** re-grant to anon (`grant execute … to anon`); no data or signature
  change, so rollback is risk-free.
