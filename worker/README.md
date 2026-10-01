# ADQS Exam v2 — DOCX Extractor Worker

Cloudflare Worker implementing the **dual-engine** DOCX exam extractor (PHASE 2).

```
POST /api/v1/extract?mode=rule|ai|auto
Header: X-Internal-Secret: <INTERNAL_SECRET>
Body  : multipart/form-data, field name "file"
```

Response:

```json
{
  "success": true,
  "engine_used": "rule",
  "count": 98,
  "data": [ { "position": 1, "question_type": "MULTIPLE_CHOICE", "...": "..." } ],
  "meta": {
    "filename": "test2.docx",
    "mode": "rule",
    "correct_spans_detected": 198,
    "has_answers": true,
    "fallback_reason": null
  }
}
```

---

## 1. Setup

```powershell
cd v2/worker
npm install
```

Secrets are read from the Worker environment and are **never** committed.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | only for `mode=ai` / `auto` fallback | Google AI Studio key |
| `INTERNAL_SECRET` | production | Must match the `X-Internal-Secret` header. Unset ⇒ check bypassed (local dev) |
| `GEMINI_MODEL` | no | Overrides the default `gemini-2.5-flash` |

Local development — create `worker/.dev.vars` (git-ignored):

```ini
GEMINI_API_KEY=""
INTERNAL_SECRET="local-dev-secret"
```

Production:

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INTERNAL_SECRET
```

---

## 2. Run locally

```powershell
npm run dev          # wrangler dev, default http://127.0.0.1:8787
```

## 3. Test with a sample file

PowerShell 5.1 has no `-Form`, so use `curl.exe` (shipped with Windows 10+):

```powershell
# Rule engine (no API cost)
curl.exe -X POST "http://127.0.0.1:8787/api/v1/extract?mode=rule" `
  -H "X-Internal-Secret: local-dev-secret" `
  -F "file=@..\..\sample\test2.docx"

# Save the JSON response for inspection
curl.exe -s -X POST "http://127.0.0.1:8787/api/v1/extract?mode=rule" `
  -H "X-Internal-Secret: local-dev-secret" `
  -F "file=@..\..\sample\test2.docx" -o response.json
```

| `mode` | Behaviour |
|---|---|
| `rule` | Engine 1 only — zero API cost |
| `ai` | Engine 2 only; `503` when `GEMINI_API_KEY` is unset |
| `auto` | Engine 1, falling back to Engine 2 when it finds **no questions** or **no resolved answer keys**. If the AI call fails, Engine 1's result is returned with the reason in `meta.fallback_reason` |

## 4. Verify

```powershell
npm run build            # tsc --noEmit (Definition of Done)
npm run verify:sample    # end-to-end over ../../sample/test2.docx
npm run verify:sample -- path\to\other.docx
```

`verify:sample` reports question counts, the per-type breakdown, answer coverage,
the MCQ answer distribution, `coerceCorrectAnswer` assertions, and a check that no
`[CORRECT]` marker ever leaks into the output.

---

## 5. Architecture

```
src/
  index.ts                    Hono gateway: CORS, secret gate, mode dispatch
  types.ts                    Persistence contract (mirrors supabase/schema.sql)
  parser/xml-preprocessor.ts  fflate unzip + zip-bomb guards + F5 [CORRECT] tagging
  parser/rule-engine.ts       Engine 1: block segmentation + MCQ/TF/Short/Essay
  ai/ai-engine.ts             Engine 2: @google/genai structured output
scripts/
  verify-sample.ts            Verification harness
  bench.ts                    CPU budget benchmark
```

### Output contract (must match PHASE 1)

| Field | Notes |
|---|---|
| `position` | 1-based ordinal → `question_bank.position` |
| `question_type` | `MULTIPLE_CHOICE` \| `TRUE_FALSE` \| `SHORT_ANSWER` \| `ESSAY` |
| `question_text` | Stem, question number and answer markers stripped |
| `options` | MCQ: 4 options. TRUE_FALSE: the four a–d statements. Otherwise `[]` |
| `correct_answer` | MCQ: **integer 0–3**. TRUE_FALSE: `["Đ","S","Đ","S"]`. SHORT_ANSWER: string. ESSAY: `null` |
| `explanation` | Populated from `hướng dẫn giải` / `lời giải` / `giải thích` when present |

### Performance notes

Measured on `sample/test2.docx` (44 KB → 555 KB XML, 98 questions):

| Stage | Time |
|---|---|
| fflate unzip (single entry) | 2.0 ms |
| XML → marked text | 6.2 ms |
| Engine 1 | 3.3 ms |
| **End to end** | **~9.2 ms** (budget 10 ms) |

`fast-xml-parser` was benchmarked and **rejected**: materialising a DOM cost
**37.6 ms** (89% of total CPU) versus **0.14 ms** for a single-pass regex scan.
`parser/xml-preprocessor.ts` therefore uses a hand-written streaming scanner, as
the ROADMAP prescribes ("Fast regex + XML *stream* parsing").

### Known limits

- **Zip-bomb guards**: ≤50 MB compressed, ≤128 MB inflated for `word/document.xml`,
  `PK\x03\x04` magic-byte validation, and only that one entry is ever inflated.
- **Answer-key tables are not parsed.** Truth of the sub-item answers can only come
  from inline marked `Đ`/`S` tokens. Exams whose keys live in a separate answer-key
  table yield `correct_answer: null` and are routed to Engine 2 by `mode=auto`.
- **Font colour `auto`/`none` and theme colours are never treated as correctness
  signals**, so default black text cannot be mistaken for a marked answer.
- Word sometimes marks only the option delimiter (`[CORRECT]C.[/CORRECT] Lý Bí.`);
  this is handled by taking the stronger of the body and delimiter marking ratios.
