/**
 * Engine 2 — Google AI Studio fallback (Gemini / Gemma).
 *
 * Used only when:
 *   - the caller explicitly requests mode=ai, OR
 *   - mode=auto and Engine 1 returned zero questions, OR
 *   - mode=auto and Engine 1 produced questions with no resolved answer keys.
 *
 * The response schema is constrained to the exact Phase 1 persistence contract
 * (see v2/supabase/schema.sql Section A.2 and src/types.ts).
 */

import { GoogleGenAI, Type } from '@google/genai';
import type { ExtractedQuestion, QuestionType } from '../types';
import { stripMarkers } from '../parser/xml-preprocessor';

/**
 * Hard-coded last-resort model.
 *
 * Resolution order (Phase 5.3): explicit `modelName` option -> the
 * `DEFAULT_AI_MODEL` Worker binding -> this constant.
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Resolves which model to call, applying the documented fallback priority.
 * Exported so the Worker can report the effective model in its response meta.
 */
export function resolveModelName(
  requested: string | undefined,
  envDefault: string | undefined,
): string {
  for (const candidate of [requested, envDefault]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return DEFAULT_MODEL;
}

/** Hard cap on the text handed to the model, to bound token cost and latency. */
const MAX_INPUT_CHARS = 120_000;

export class AiEngineError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_API_KEY' | 'MODEL_ERROR' | 'BAD_RESPONSE',
  ) {
    super(message);
    this.name = 'AiEngineError';
  }
}

/* -------------------------------------------------------------------------- */
/* Structured-output schema                                                   */
/* -------------------------------------------------------------------------- */

const QUESTION_TYPES: QuestionType[] = [
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'ESSAY',
];

/**
 * OpenAPI-subset schema enforced on the model.
 *
 * NOTE: `correct_answer` is declared as a STRING because Gemini's schema subset
 * cannot express a union (integer | array | string | null). The model is
 * instructed to emit a JSON-encoded value which `coerceCorrectAnswer()` decodes
 * into the precise Phase 1 JSONB shape.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      description: 'Danh sách câu hỏi theo đúng thứ tự xuất hiện trong đề.',
      items: {
        type: Type.OBJECT,
        properties: {
          position: {
            type: Type.INTEGER,
            description: 'Số thứ tự 1-based của câu hỏi.',
          },
          question_type: {
            type: Type.STRING,
            format: 'enum',
            enum: QUESTION_TYPES,
            description:
              'MULTIPLE_CHOICE cho câu trắc nghiệm; TRUE_FALSE cho câu đúng/sai 4 ý; SHORT_ANSWER cho câu trả lời ngắn; ESSAY cho câu tự luận.',
          },
          question_text: {
            type: Type.STRING,
            description: 'Nội dung câu hỏi, đã loại bỏ số thứ tự và đáp án.',
          },
          options: {
            type: Type.ARRAY,
            description:
              'MULTIPLE_CHOICE: 4 phương án A-D (chỉ nội dung). TRUE_FALSE: 4 mệnh đề a-d. SHORT_ANSWER/ESSAY: mảng rỗng.',
            items: { type: Type.STRING },
          },
          correct_answer: {
            type: Type.STRING,
            description:
              'Chuỗi JSON. MULTIPLE_CHOICE: chỉ số 0-3, ví dụ "2". TRUE_FALSE: mảng 4 phần tử "Đ"/"S", ví dụ \'["Đ","S","Đ","S"]\'. SHORT_ANSWER: chuỗi đáp án, ví dụ "3". ESSAY: "null". Dùng "null" nếu không xác định được đáp án.',
          },
          explanation: {
            type: Type.STRING,
            description: 'Lời giải/giải thích nếu có trong đề, ngược lại là chuỗi rỗng.',
          },
        },
        required: ['position', 'question_type', 'question_text', 'options', 'correct_answer'],
      },
    },
  },
  required: ['questions'],
} as const;

const SYSTEM_INSTRUCTION = `Bạn là bộ trích xuất đề thi cho hệ thống ADQS Exam.
Nhiệm vụ: đọc văn bản đề thi tiếng Việt và trả về danh sách câu hỏi có cấu trúc.

QUY TẮC BẮT BUỘC:
1. Phân loại mỗi câu vào đúng một trong bốn loại: MULTIPLE_CHOICE, TRUE_FALSE, SHORT_ANSWER, ESSAY.
2. MULTIPLE_CHOICE: options chứa đúng 4 nội dung phương án (không kèm "A.", "B.", ...). correct_answer là CHUỖI JSON của chỉ số đúng 0-3, ví dụ "2". Nếu không có đáp án, dùng "null".
3. TRUE_FALSE: options chứa đúng 4 mệnh đề a), b), c), d) đã bỏ ký hiệu đầu dòng. correct_answer là CHUỖI JSON của mảng 4 phần tử "Đ" hoặc "S", ví dụ "[\\"Đ\\",\\"S\\",\\"Đ\\",\\"S\\"]". Nếu không có đáp án, dùng "null".
4. SHORT_ANSWER: options là mảng rỗng. correct_answer là CHUỖI JSON của đáp án, ví dụ "\\"3\\"". Nếu không có, dùng "null".
5. ESSAY: options là mảng rỗng và correct_answer luôn là "null". Nhận diện câu tự luận qua từ khóa như "Tự luận", "trình bày", "phân tích", "nêu cảm nhận", "hãy viết".
6. Không tạo câu hỏi không tồn tại trong đề. Không bịa đáp án: nếu đề không nêu đáp án đúng, dùng "null".
7. position phải là số nguyên 1-based và tăng dần theo thứ tự trong đề.
8. Loại bỏ hoàn toàn số thứ tự câu và ký hiệu đáp án khỏi question_text và options.`;

/* -------------------------------------------------------------------------- */
/* Correct-answer coercion                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decode the model's JSON-encoded `correct_answer` string into the exact
 * Phase 1 JSONB shape for the given type.
 */
export function coerceCorrectAnswer(
  raw: unknown,
  type: QuestionType,
): number | string[] | string | null {
  if (type === 'ESSAY') return null;

  // Accept a real number / array directly (defensive: some models ignore the
  // string-encoding instruction even under a schema).
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return type === 'MULTIPLE_CHOICE' ? clampIndex(Number(raw)) : String(raw);
  }
  if (Array.isArray(raw)) {
    return type === 'TRUE_FALSE' ? normalizeTrueFalse(raw) : null;
  }
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  if (text === '' || text.toLowerCase() === 'null' || text.toLowerCase() === 'n/a') return null;

  if (type === 'MULTIPLE_CHOICE') {
    // "2" or "\"2\""
    const unquoted = unquote(text);
    const numeric = Number(unquoted);
    if (Number.isFinite(numeric) && Number.isInteger(numeric)) return clampIndex(numeric);
    // Tolerate a letter form ("C") even though the contract is an index.
    const letter = /^[A-D]$/i.exec(unquoted);
    if (letter) return letter[0].toUpperCase().charCodeAt(0) - 65;
    return null;
  }

  if (type === 'TRUE_FALSE') {
    const decoded = tryJsonParse(text);
    if (Array.isArray(decoded)) return normalizeTrueFalse(decoded);
    return null;
  }

  // SHORT_ANSWER: a JSON string, or a bare token.
  const decoded = tryJsonParse(text);
  if (typeof decoded === 'string') return decoded.trim() === '' ? null : decoded.trim();
  if (typeof decoded === 'number') return String(decoded);
  const unquoted = unquote(text);
  return unquoted === '' ? null : unquoted;
}

function clampIndex(value: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 3) return null;
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeTrueFalse(values: unknown[]): string[] | null {
  const mapped: string[] = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text === '') return null;
    const lower = text.toLowerCase();
    if (lower.startsWith('đ') || lower === 'd' || lower === 'true' || lower === 't') {
      mapped.push('Đ');
    } else if (lower.startsWith('s') || lower === 'false' || lower === 'f') {
      mapped.push('S');
    } else {
      return null;
    }
  }
  return mapped.length === 0 ? null : mapped;
}

/* -------------------------------------------------------------------------- */
/* Response normalization                                                     */
/* -------------------------------------------------------------------------- */

function normalizeType(value: unknown): QuestionType {
  const upper = String(value ?? '').trim().toUpperCase();
  const match = QUESTION_TYPES.find((type) => type === upper);
  return match ?? 'SHORT_ANSWER';
}

function normalizeOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((option) => String(option ?? '').replace(/\s+/g, ' ').trim()).filter((o) => o !== '');
}

interface RawAiQuestion {
  position?: unknown;
  question_type?: unknown;
  question_text?: unknown;
  options?: unknown;
  correct_answer?: unknown;
  explanation?: unknown;
}

/** Map the validated model output onto the persisted contract. */
export function normalizeAiQuestions(raw: RawAiQuestion[]): ExtractedQuestion[] {
  const out: ExtractedQuestion[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as RawAiQuestion;
    const type = normalizeType(item.question_type);

    const questionText = String(item.question_text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (questionText === '') continue;

    const options = normalizeOptions(item.options);
    const explanationText = String(item.explanation ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    out.push({
      position: i + 1,
      question_type: type,
      question_text: questionText,
      options: type === 'MULTIPLE_CHOICE' || type === 'TRUE_FALSE' ? options : [],
      correct_answer: coerceCorrectAnswer(item.correct_answer, type),
      explanation: explanationText === '' ? null : explanationText,
    });
  }

  return out;
}

function extractJsonPayload(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export interface AiEngineOptions {
  apiKey: string | undefined;
  /** Explicit model id. Highest priority in the resolution chain. */
  model?: string;
  /** Worker binding fallback (`DEFAULT_AI_MODEL`). Lower priority than `model`. */
  envModel?: string;
  /** Marked-up text (markers are stripped before sending). */
  text: string;
}

export interface AiEngineResult {
  data: ExtractedQuestion[];
  question_count: number;
  has_answers: boolean;
}

/**
 * Run Engine 2 over the document text.
 *
 * @throws AiEngineError when the key is missing or the model call fails.
 */
export async function extractWithAi(options: AiEngineOptions): Promise<AiEngineResult> {
  const { apiKey, text } = options;
  // Priority: explicit caller model -> Worker default binding -> built-in.
  const model = resolveModelName(options.model, options.envModel);

  if (!apiKey || apiKey.trim() === '') {
    throw new AiEngineError(
      'GEMINI_API_KEY is not configured; Engine 2 cannot run.',
      'NO_API_KEY',
    );
  }

  // Markers are a parsing artifact and carry no meaning for the model.
  const plainText = stripMarkers(text).slice(0, MAX_INPUT_CHARS);

  const ai = new GoogleGenAI({ apiKey });

  let responseText: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model,
      contents: plainText,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });
    responseText = response.text;
  } catch (error) {
    throw new AiEngineError(
      `Model "${model}" call failed: ${(error as Error).message}`,
      'MODEL_ERROR',
    );
  }

  if (!responseText || responseText.trim() === '') {
    throw new AiEngineError(`Model "${model}" returned an empty response.`, 'BAD_RESPONSE');
  }

  const payload = extractJsonPayload(responseText);
  if (payload === undefined) {
    throw new AiEngineError('Model response was not valid JSON.', 'BAD_RESPONSE');
  }

  const container = payload as { questions?: unknown };
  const rawQuestions = Array.isArray(container.questions)
    ? (container.questions as RawAiQuestion[])
    : Array.isArray(payload)
      ? (payload as RawAiQuestion[])
      : null;

  if (rawQuestions === null) {
    throw new AiEngineError('Model response JSON has no "questions" array.', 'BAD_RESPONSE');
  }

  const data = normalizeAiQuestions(rawQuestions);
  const hasAnswers = data.some((question) => question.correct_answer !== null);

  return { data, question_count: data.length, has_answers: hasAnswers };
}
