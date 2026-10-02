import type { ExtractionMode, ExtractionResponse } from './types';

/**
 * Client-side extractor: uploads a .docx to the local Next.js proxy route,
 * which forwards it to the Cloudflare Worker with the X-Internal-Secret header.
 *
 * The Worker's shared secret is deliberately NOT exposed to the browser
 * (EXTRACTOR_INTERNAL_SECRET has no NEXT_PUBLIC_ prefix), so the raw Worker URL
 * is never called directly from here. See src/app/api/extract/route.ts.
 */

/** Mirrors MAX_UPLOAD_BYTES in the Worker and the DOCX guard in v1. */
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface ExtractOptions {
  /** `auto` (default) falls back to AI when the rule engine is inconclusive. */
  mode?: ExtractionMode;
  /**
   * Explicit AI model id (Phase 5.3). Only meaningful when the AI engine runs;
   * the Worker falls back to its DEFAULT_AI_MODEL binding when omitted.
   */
  model?: string;
  signal?: AbortSignal;
}

export async function extractDocx(
  file: File,
  options: ExtractOptions = {},
): Promise<ExtractionResponse> {
  const { mode = 'auto', model, signal } = options;

  if (!file.name.toLowerCase().endsWith('.docx')) {
    throw new ExtractionError('Chỉ hỗ trợ tệp .docx', 'BAD_EXTENSION', 400);
  }
  if (file.size > MAX_DOCX_BYTES) {
    throw new ExtractionError(
      `Tệp ${(file.size / 1024 / 1024).toFixed(1)}MB vượt giới hạn 50MB.`,
      'TOO_LARGE',
      413,
    );
  }

  const form = new FormData();
  form.append('file', file);
  // The model rides in the multipart body so the proxy route can forward it
  // without having to re-serialize the request.
  if (model && model.trim() !== '') form.append('model', model.trim());

  const url = new URLSearchParams({ mode });
  if (model && model.trim() !== '') url.set('model', model.trim());

  // AI extraction can take well over a minute on a long document.
  const timeoutMs = mode === 'rule' ? 60_000 : 180_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`/api/extract?${url.toString()}`, {
      method: 'POST',
      body: form,
      signal: combined,
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') {
      throw new ExtractionError('Máy chủ trích xuất phản hồi quá chậm.', 'TIMEOUT', 504);
    }
    throw new ExtractionError(
      'Không kết nối được máy chủ trích xuất. Kiểm tra Worker đã chạy chưa.',
      'NETWORK',
      0,
    );
  }

  const payload = (await response.json().catch(() => null)) as ExtractionResponse | null;

  if (!response.ok || !payload) {
    throw new ExtractionError(
      payload?.error?.message ?? `Trích xuất thất bại (HTTP ${response.status}).`,
      payload?.error?.code ?? 'UNKNOWN',
      response.status,
    );
  }

  // The Worker returns HTTP 200 with success=false for an empty document.
  if (payload.error) {
    throw new ExtractionError(payload.error.message, payload.error.code, response.status);
  }

  return payload;
}
