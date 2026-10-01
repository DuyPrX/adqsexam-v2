/**
 * ADQS Exam v2 — DOCX extraction gateway (Cloudflare Worker).
 *
 * Route: POST /api/v1/extract?mode=rule|ai|auto
 * Header: X-Internal-Secret (validated against env.INTERNAL_SECRET)
 *
 * Engine dispatch (Phase 2 decision, ARCHITECTURE_FREEZE.md §3.5):
 *   rule -> Engine 1 only
 *   ai   -> Engine 2 only
 *   auto -> Engine 1, falling back to Engine 2 when it yields no questions or
 *           no resolved answer keys.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AiEngineError, extractWithAi } from './ai/ai-engine';
import { DocxError, preprocessDocx } from './parser/xml-preprocessor';
import { extractWithRules } from './parser/rule-engine';
import type { EngineUsed, ExtractionMode, ExtractedQuestion } from './types';

export interface Env {
  /** Google AI Studio key. Required only for mode=ai / auto fallback. */
  GEMINI_API_KEY?: string;
  /** Shared secret required in the X-Internal-Secret header. Unset = bypassed. */
  INTERNAL_SECRET?: string;
  /** Overridable Gemini model name (see wrangler.toml [vars]). */
  GEMINI_MODEL?: string;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // keep in sync with the preprocessor

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/', (c) =>
  c.json({
    service: 'docx-extractor-v2',
    endpoint: 'POST /api/v1/extract?mode=rule|ai|auto',
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
  try {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json(
        errorResponse('Request must be multipart/form-data with a "file" field.', 400, 'NO_FILE'),
        400,
      );
    }
    if (file.size === 0) {
      return c.json(errorResponse('Uploaded file is empty.', 400, 'EMPTY_FILE'), 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        errorResponse(
          `File is ${file.size} bytes, exceeding the ${MAX_UPLOAD_BYTES} byte limit.`,
          413,
          'TOO_LARGE',
        ),
        413,
      );
    }
    filename = file.name;
    archive = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return c.json(
      errorResponse(`Failed to read upload: ${(error as Error).message}`, 400, 'BAD_UPLOAD'),
      400,
    );
  }

  // --- 3. Preprocess (shared by both engines) ------------------------------
  let text: string;
  let correctSpanCount: number;
  try {
    const pre = preprocessDocx(archive);
    text = pre.text;
    correctSpanCount = pre.correctSpanCount;
  } catch (error) {
    if (error instanceof DocxError) {
      const status = error.code === 'TOO_LARGE' || error.code === 'INFLATED_TOO_LARGE' ? 413 : 400;
      return c.json(errorResponse(error.message, status, error.code), status as 400 | 413);
    }
    return c.json(
      errorResponse(`Unexpected preprocessing failure: ${(error as Error).message}`, 500, 'INTERNAL'),
      500,
    );
  }

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
        model: c.env.GEMINI_MODEL,
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
    const ruleResult = extractWithRules(text);
    data = ruleResult.data;
    engineUsed = 'rule';

    const needsFallback = ruleResult.question_count === 0 || !ruleResult.has_answers;
    if (needsFallback) {
      fallbackReason =
        ruleResult.question_count === 0
          ? 'rule_engine_found_no_questions'
          : 'rule_engine_unresolved_answers';
      try {
        const aiResult = await extractWithAi({
          apiKey: c.env.GEMINI_API_KEY,
          model: c.env.GEMINI_MODEL,
          text,
        });
        // Prefer the AI result only when it actually improves on Engine 1.
        if (aiResult.question_count > 0) {
          data = aiResult.data;
          engineUsed = 'ai';
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
    },
  });
});

app.notFound((c) => c.json(errorResponse(`No route for ${c.req.method} ${c.req.path}`, 404, 'NOT_FOUND'), 404));

app.onError((error, c) => {
  console.error('Unhandled worker error:', error);
  return c.json(errorResponse(`Unhandled error: ${error.message}`, 500, 'INTERNAL'), 500);
});

export default app;
