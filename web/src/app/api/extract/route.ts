import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getExtractorEndpoint, getExtractorInternalSecret } from '@/lib/env';

/**
 * Server-side proxy for the Cloudflare Worker extractor.
 *
 * Why a proxy instead of a direct browser -> Worker call:
 *   EXTRACTOR_INTERNAL_SECRET is a server-only secret (no NEXT_PUBLIC_ prefix),
 *   by design — it must never reach the browser bundle. The Worker validates it
 *   in the X-Internal-Secret header, so exactly one trusted hop is required.
 *
 * The route is reachable only by an authenticated teacher (middleware + an
 * explicit getUser() check below keeps API callers from getting an HTML
 * redirect instead of a JSON error).
 */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function fail(message: string, code: string, status: number) {
  return NextResponse.json(
    { success: false, engine_used: null, count: 0, data: [], error: { code, message } },
    { status },
  );
}

/**
 * Accepts only plausible model identifiers.
 *
 * The value is interpolated into an outbound URL, so a permissive allow-list is
 * the right shape: reject anything that is not a simple `<vendor>/<model>` or
 * `<model>` slug. This blocks path traversal, query injection and header abuse
 * while still permitting arbitrary custom model IDs (Phase 5.3 §2).
 */
function sanitizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 100) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) ? trimmed : null;
}

export async function POST(request: Request) {
  // 1. Require a teacher session.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return fail('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'UNAUTHORIZED', 401);
  }

  // 2. Validate the extractor configuration.
  const endpoint = getExtractorEndpoint();
  if (!endpoint) {
    return fail('Chưa cấu hình NEXT_PUBLIC_EXTRACTOR_API_URL.', 'NOT_CONFIGURED', 500);
  }

  // 3. Forward the multipart body. Parsing the form twice is wasteful, so the
  //    original stream is passed through once via request.formData().
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('Yêu cầu phải là multipart/form-data với trường "file".', 'BAD_UPLOAD', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail('Thiếu tệp .docx trong trường "file".', 'NO_FILE', 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail('Tệp vượt giới hạn 50MB.', 'TOO_LARGE', 413);
  }

  const search = new URL(request.url).searchParams;
  const modeParam = search.get('mode');
  const mode = modeParam === 'rule' || modeParam === 'ai' ? modeParam : 'auto';

  // Model selection (Phase 5.3): accept it from the query string or the
  // multipart field, validate the shape, then forward to the Worker.
  const model = sanitizeModel(search.get('model') ?? form.get('model'));

  // 4. Call the Worker with the secret attached.
  const upstream = new FormData();
  upstream.append('file', file, file.name);
  if (model) upstream.append('model', model);

  const headers: Record<string, string> = {};
  const secret = getExtractorInternalSecret();
  if (secret) headers['X-Internal-Secret'] = secret;

  const upstreamQuery = new URLSearchParams({ mode });
  if (model) upstreamQuery.set('model', model);

  let workerResponse: Response;
  try {
    workerResponse = await fetch(`${endpoint}?${upstreamQuery.toString()}`, {
      method: 'POST',
      headers,
      body: upstream,
    });
  } catch (error) {
    return fail(
      `Không kết nối được máy chủ trích xuất: ${(error as Error).message}`,
      'UPSTREAM_UNREACHABLE',
      502,
    );
  }

  // 5. Relay the Worker payload verbatim (already matches ExtractionResponse).
  const body = await workerResponse.text();
  return new NextResponse(body, {
    status: workerResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
