/**
 * ADQS Exam v2 — DOCX extraction gateway (Cloudflare Worker).
 *
 * Route: POST /api/v1/extract?mode=rule|ai|auto
 * Header: X-Internal-Secret (validated against env.INTERNAL_SECRET)
 *
 * Route: POST /api/v1/extract-practice
 * No secret, no `mode` parameter — ALWAYS the rule engine (Phase 5.2, rule).
 *
 * Engine dispatch (Phase 2 decision, ARCHITECTURE_FREEZE.md §3.5):
 *   rule -> Engine 1 only
 *   ai   -> Engine 2 only
 *   auto -> Engine 1, then the Phase 5.6 anomaly linter decides whether to hand
 *           over to Engine 2 (reported as `engine_used: 'ai_fallback'`).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AiEngineError, extractWithAi, resolveModelName } from './ai/ai-engine';
import { DocxError, preprocessDocx } from './parser/xml-preprocessor';
import { extractWithRules } from './parser/rule-engine';
import { detectParsingAnomalies, documentDeclaresTrueFalse } from './parser/anomaly-linter';
import type { EngineUsed, ExtractionMode, ExtractedQuestion } from './types';

export interface Env {
  /** Google AI Studio key. Required only for mode=ai / auto fallback. */
  GEMINI_API_KEY?: string;
  /** Shared secret required in the X-Internal-Secret header. Unset = bypassed. */
  INTERNAL_SECRET?: string;
  /** Worker-level default model (see wrangler.toml [vars]). */
  DEFAULT_AI_MODEL?: string;
  /** Legacy alias for DEFAULT_AI_MODEL, kept for already-deployed configs. */
  GEMINI_MODEL?: string;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // keep in sync with the preprocessor

/* ========================================================================== */
/* In-Worker rate limiter (Phase 5.3 §1)                                      */
/* -------------------------------------------------------------------------- */
/* A sliding-window log per client IP, held in module scope. Cloudflare runs   */
/* many isolates and recycles them, so this is a best-effort shield — it stops */
/* a single abusive client from burning the Worker quota, without requiring    */
/* the paid WAF rate-limiting product.                                         */
/* ========================================================================== */

/** Max practice uploads allowed from one IP inside the window. */
const RATE_LIMIT_MAX = 5;
/** Window length in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Drop fully-expired buckets; bounds memory if many IPs ever hit us. */
const RATE_LIMIT_SWEEP_MS = 5 * 60_000;

/** ip -> ascending list of request timestamps (ms). */
const rateBuckets = new Map<string, number[]>();
let lastSweepAt = 0;

/** Removes every bucket whose newest hit is already outside the window. */
function sweepRateBuckets(now: number): void {
  if (now - lastSweepAt < RATE_LIMIT_SWEEP_MS) return;
  lastSweepAt = now;
  for (const [ip, timestamps] of rateBuckets) {
    const newest = timestamps[timestamps.length - 1] ?? 0;
    if (now - newest >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(ip);
  }
}

/** Resolves the caller IP behind Cloudflare. */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const direct = c.req.header('cf-connecting-ip');
  if (direct && direct.trim() !== '') return direct.trim();
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0];
    if (first && first.trim() !== '') return first.trim();
  }
  return '127.0.0.1';
}

/**
 * Records one hit for `ip` and reports whether it is within the allowance.
 * The bucket is updated in place so a rejected call still counts as an
 * attempt — otherwise a client could hammer past the limit for free.
 */
function checkRateLimit(ip: string, now: number): boolean {
  sweepRateBuckets(now);

  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateBuckets.get(ip) ?? []).filter((at) => at > cutoff);
  recent.push(now);
  rateBuckets.set(ip, recent);

  return recent.length <= RATE_LIMIT_MAX;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    service: 'docx-extractor-v2',
    endpoints: [
      'POST /api/v1/extract?mode=rule|ai|auto&model=<model-id>',
      'POST /api/v1/extract-practice',
    ],
    engines: ['rule', 'ai'],
  }),
);

app.get('/health', (c) => c.json({ success: true, status: 'ok' }));

/** Parse and validate the `mode` query parameter. */
function parseMode(raw: string | undefined): ExtractionMode {
  if (raw === 'rule' || raw === 'ai' || raw === 'auto') return raw;
  return 'auto';
}

function errorResponse(message: string, status: number, code: string) {
  return { success: false, engine_used: null, count: 0, data: [], error: { code, message } };
}

/** The Worker-level default model binding (new name wins over the legacy one). */
function envDefaultModel(env: Env): string | undefined {
  return env.DEFAULT_AI_MODEL ?? env.GEMINI_MODEL;
}

/** Reads and validates the `file` field of a multipart body. */
async function readUpload(
  file: unknown,
): Promise<
  { ok: true; archive: Uint8Array; filename: string }
  | { ok: false; status: 400 | 413; body: ReturnType<typeof errorResponse> }
> {
  if (!(file instanceof File)) {
    return {
      ok: false,
      status: 400,
      body: errorResponse('Request must be multipart/form-data with a "file" field.', 400, 'NO_FILE'),
    };
  }
  if (file.size === 0) {
    return { ok: false, status: 400, body: errorResponse('Uploaded file is empty.', 400, 'EMPTY_FILE') };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      body: errorResponse(
        `File is ${file.size} bytes, exceeding the ${MAX_UPLOAD_BYTES} byte limit.`,
        413,
        'TOO_LARGE',
      ),
    };
  }
  return { ok: true, archive: new Uint8Array(await file.arrayBuffer()), filename: file.name };
}

/** Runs the shared DOCX preprocessor, mapping DocxError onto the wire format. */
function runPreprocess(
  archive: Uint8Array,
):
  | { ok: true; text: string; correctSpanCount: number }
  | { ok: false; status: 400 | 413 | 500; body: ReturnType<typeof errorResponse> } {
  try {
    const pre = preprocessDocx(archive);
    return { ok: true, text: pre.text, correctSpanCount: pre.correctSpanCount };
  } catch (error) {
    if (error instanceof DocxError) {
      const status = error.code === 'TOO_LARGE' || error.code === 'INFLATED_TOO_LARGE' ? 413 : 400;
      return { ok: false, status, body: errorResponse(error.message, status, error.code) };
    }
    return {
      ok: false,
      status: 500,
      body: errorResponse(`Unexpected preprocessing failure: ${(error as Error).message}`, 500, 'INTERNAL'),
    };
  }
}

app.post('/api/v1/extract', async (c) => {
  // --- 1. Internal secret check -------------------------------------------
  // Bypassed only when INTERNAL_SECRET is not configured (local development).
  const expectedSecret = c.env.INTERNAL_SECRET;
  if (expectedSecret && expectedSecret.trim() !== '') {
    const provided = c.req.header('X-Internal-Secret');
    if (provided !== expectedSecret) {
      return c.json(errorResponse('Invalid or missing X-Internal-Secret header.', 401, 'UNAUTHORIZED'), 401);
    }
  }

  const mode = parseMode(c.req.query('mode'));

  // --- 2. Read multipart body ---------------------------------------------
  let archive: Uint8Array;
  let filename = '';
  let formModel: string | undefined;
  try {
    const body = await c.req.parseBody();
    const upload = await readUpload(body['file']);
    if (!upload.ok) return c.json(upload.body, upload.status);
    archive = upload.archive;
    filename = upload.filename;
    const rawModel = body['model'];
    if (typeof rawModel === 'string' && rawModel.trim() !== '') formModel = rawModel.trim();
  } catch (error) {
    return c.json(
      errorResponse(`Failed to read upload: ${(error as Error).message}`, 400, 'BAD_UPLOAD'),
      400,
    );
  }

  // Model selection (Phase 5.3 §2): `?model=` wins, then the multipart field.
  const requestedModel = c.req.query('model')?.trim() || formModel;

  // --- 3. Preprocess (shared by both engines) ------------------------------
  const pre = runPreprocess(archive);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const { text, correctSpanCount } = pre;

  if (text.trim() === '') {
    return c.json(
      {
        success: false,
        engine_used: null,
        count: 0,
        data: [],
        error: { code: 'NO_TEXT', message: 'Document contains no extractable text.' },
      },
      200,
    );
  }

  // --- 4. Engine dispatch --------------------------------------------------
  let data: ExtractedQuestion[] = [];
  let engineUsed: EngineUsed = 'rule';
  let fallbackReason: string | null = null;

  if (mode === 'rule') {
    const result = extractWithRules(text);
    data = result.data;
    engineUsed = 'rule';
  } else if (mode === 'ai') {
    try {
      const result = await extractWithAi({
        apiKey: c.env.GEMINI_API_KEY,
        model: requestedModel,
        envModel: envDefaultModel(c.env),
        text,
      });
      data = result.data;
      engineUsed = 'ai';
    } catch (error) {
      if (error instanceof AiEngineError) {
        const status = error.code === 'NO_API_KEY' ? 503 : 502;
        return c.json(errorResponse(error.message, status, error.code), status as 502 | 503);
      }
      return c.json(errorResponse((error as Error).message, 500, 'INTERNAL'), 500);
    }
  } else {
    // mode === 'auto'
    //
    // Phase 5.6 §2: Engine 1 runs first (free, <10ms). Its output is then
    // inspected by the anomaly linter rather than the old
    // `question_count === 0 || !has_answers` check, which silently accepted
    // subtly-corrupted parses (e.g. a True/False section read as MCQ).
    const ruleResult = extractWithRules(text);
    const ruleParse = { questions: ruleResult.data };
    data = ruleResult.data;
    engineUsed = 'rule';

    const anomaly = detectParsingAnomalies(text, ruleParse);
    if (anomaly.shouldFallback) {
      fallbackReason = anomaly.reason ?? 'ANOMALY_DETECTED';
      try {
        const aiResult = await extractWithAi({
          apiKey: c.env.GEMINI_API_KEY,
          model: requestedModel,
          envModel: envDefaultModel(c.env),
          text,
        });
        // Prefer the AI result only when it actually improves on Engine 1.
        if (aiResult.question_count > 0) {
          data = aiResult.data;
          engineUsed = 'ai_fallback';
        }
      } catch (error) {
        // Auto mode degrades gracefully: keep Engine 1 output and report why.
        fallbackReason += `; ai_fallback_failed: ${(error as Error).message}`;
      }
    }
  }

  // --- 5. Response ---------------------------------------------------------
  return c.json({
    success: data.length > 0,
    engine_used: engineUsed,
    count: data.length,
    data,
    meta: {
      filename,
      mode,
      correct_spans_detected: correctSpanCount,
      has_answers: data.some((question) => question.correct_answer !== null),
      fallback_reason: fallbackReason,
      // Reported so the teacher UI can confirm which model actually ran.
      model_used: engineUsed === 'rule'
        ? null
        : resolveModelName(requestedModel, envDefaultModel(c.env)),
      // Phase 5.6: the document declares a True/False section but none was
      // parsed. Surfaced to the teacher even in mode=rule, where the linter
      // cannot act, so the UI can suggest re-running with AI.
      missed_true_false:
        documentDeclaresTrueFalse(text)
        && !data.some((question) => question.question_type === 'TRUE_FALSE'),
    },
  });
});

/**
 * POST /api/v1/extract-practice  (Phase 5.2)
 *
 * Public, unauthenticated practice extraction for the student SPA.
 *
 *   - NO X-Internal-Secret: students cannot hold the teacher-side secret, and
 *     the student bundle is public. The endpoint is deliberately secret-free.
 *   - mode is FORCED to 'rule' and the `mode` query parameter is ignored, so
 *     the zero-AI-cost rule (Phase 5.2 §Business rules 4) cannot be bypassed
 *     by the caller. AiEngine is never imported into this code path.
 *   - The response intentionally INCLUDES `correct_answer` and `explanation`:
 *     practice grading is client-side, and the document is the student's own.
 *     Nothing is persisted server-side (no Supabase writes here).
 *   - Rate limited in-process (Phase 5.3 §1): 5 uploads / 60s / IP, since the
 *     endpoint is unauthenticated and otherwise trivially abusable.
 */
app.post('/api/v1/extract-practice', async (c) => {
  // --- 0. Sliding-window rate limit ---------------------------------------
  if (!checkRateLimit(clientIp(c), Date.now())) {
    return c.json(
      {
        success: false,
        engine_used: null,
        count: 0,
        data: [],
        message: 'Bạn tải file quá nhanh. Vui lòng chờ 1 phút.',
        error: {
          code: 'RATE_LIMITED',
          message: 'Bạn tải file quá nhanh. Vui lòng chờ 1 phút.',
        },
      },
      429,
    );
  }

  // --- 1. Read multipart body ---------------------------------------------
  let archive: Uint8Array;
  let filename = '';
  try {
    const body = await c.req.parseBody();
    const upload = await readUpload(body['file']);
    if (!upload.ok) return c.json(upload.body, upload.status);
    archive = upload.archive;
    filename = upload.filename;
  } catch (error) {
    return c.json(
      errorResponse(`Failed to read upload: ${(error as Error).message}`, 400, 'BAD_UPLOAD'),
      400,
    );
  }

  // --- 2. Preprocess ------------------------------------------------------
  const pre = runPreprocess(archive);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const { text, correctSpanCount } = pre;

  if (text.trim() === '') {
    return c.json(
      {
        success: false,
        engine_used: null,
        count: 0,
        data: [],
        error: { code: 'NO_TEXT', message: 'Document contains no extractable text.' },
      },
      200,
    );
  }

  // --- 3. Rule engine ONLY -------------------------------------------------
  const result = extractWithRules(text);

  return c.json({
    success: result.data.length > 0,
    engine_used: 'rule',
    count: result.data.length,
    data: result.data,
    meta: {
      filename,
      mode: 'rule',
      correct_spans_detected: correctSpanCount,
      has_answers: result.data.some((question) => question.correct_answer !== null),
      fallback_reason: null,
      missed_true_false:
        documentDeclaresTrueFalse(text)
        && !result.data.some((question) => question.question_type === 'TRUE_FALSE'),
    },
  });
});

app.notFound((c) => c.json(errorResponse(`No route for ${c.req.method} ${c.req.path}`, 404, 'NOT_FOUND'), 404));

app.onError((error, c) => {
  console.error('Unhandled worker error:', error);
  return c.json(errorResponse(`Unhandled error: ${error.message}`, 500, 'INTERNAL'), 500);
});

export default app;
