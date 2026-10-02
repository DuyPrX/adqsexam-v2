/**
 * Engine 1 — rule-based extractor (primary; zero API cost).
 *
 * Ports the proven v1 Java logic:
 *   - QuestionBlockExtractor.java  (question delimiters, PHẦN section headers)
 *   - QuestionTypeParser.java      (MCQ / True-False / Short-Answer shapes)
 *   - AnswerKeyExtractor.java      (I=MCQ, II=True/False, III=Short Answer)
 *   - QuestionParseSupport.java    (option validity heuristics)
 *
 * and adds the F4 essay recognition the v1 parser never implemented.
 *
 * INPUT HANDLING: the preprocessor emits `[CORRECT]...[/CORRECT]` around marked
 * runs. Word frequently wraps an entire answer *line*, so the marker can sit
 * immediately before a structural anchor ("[CORRECT]Câu 2. ...", "[CORRECT]D. ...").
 * Testing `^CÂU`/`^[A-D]` on such a line would fail.
 *
 * This module therefore tokenises the marked text once into:
 *   - `text` : markers removed, so every structural regex behaves normally
 *   - `mask` : mask[i] === true when text[i] was inside a [CORRECT] span
 * Both arrays are index-aligned, so a structural match found in `text` can be
 * tested against `mask` directly. `squash()` is only applied to final display
 * strings, never before a mask lookup.
 */

import { CORRECT_CLOSE, CORRECT_OPEN } from './xml-preprocessor';
import type { ExtractedQuestion, QuestionType } from '../types';

/* -------------------------------------------------------------------------- */
/* Delimiters (ported from v1)                                                */
/* -------------------------------------------------------------------------- */

/** v1 QuestionBlockExtractor.QUESTION_PATTERNS — anchored at a line start. */
const QUESTION_START = /^(?:câu\s*\d+|question\s*\d+|q\s*\d+|\d+)\s*[.):\-\/]\s*/i;

/** v1 SECTION_PATTERN — `PHẦN I`, `PHẦN II`, ... */
const SECTION_HEADER = /^PHẦN\s+(I{1,3}|IV|V|VI{0,3}|[A-C])\b\s*[.:)\-]?\s*(.*)$/i;

/**
 * Phase 5.6 — keyword-based section boundaries.
 *
 * SECTION_HEADER only recognises the roman-numeral `PHẦN I` spelling. Ministry
 * (Bộ GD&ĐT) papers — and `PART 2`-style imports — also label sections by their
 * *subject matter*. These are anchored at a line start so prose that merely
 * mentions "phần 2" mid-sentence cannot open a section.
 */
const SECTION_TRUE_FALSE_KEYWORD =
  /^(?:phần|part)\s*(?:ii|2)[\s.:]+.*?(?:đúng\s*[-/]?\s*sai|true\s*[-/]?\s*false)/i;
const SECTION_SHORT_ANSWER_KEYWORD =
  /^(?:phần|part)\s*(?:iii|3)[\s.:]+.*?(?:ngắn|điền\s*khuyết|tự\s*luận)/i;
const SECTION_MULTIPLE_CHOICE_KEYWORD =
  /^(?:phần|part)\s*(?:i|1)[\s.:]+.*?(?:trắc\s*nghiệm|nhiều\s*phương\s*án)/i;

/**
 * v1 ANSWER_PATTERN — option delimiter, A-D.
 *
 * Two delimiter forms are needed, because real papers use both layouts:
 *   (a) one option per line   ("A. ...\nB. ...\n")   -> LINE-ANCHORED form
 *   (b) all options inline    ("... là A. ... B. ...") -> INLINE form
 *
 * The line-anchored form is scanned FIRST and is strongly structural, so prose
 * such as "C.Mác" inside an option body cannot produce candidates. Only when no
 * line-anchored A→B→C→D run exists does the inline form apply; it additionally
 * requires whitespace after the delimiter, because genuine delimiters are
 * followed by a space ("C. Phu-ri-ê") whereas abbreviations are not ("C.Mác").
 */
const OPTION_LINE_ANCHORED = /(?:^|\n)[ \t]*([A-D])\s*[.):\-\/]\s*/g;
const OPTION_INLINE = /(?:^|\s)([A-D])\s*[.):\-\/]\s+/g;

/**
 * v1 SUB_QUESTION_PATTERN — true/false sub-item delimiter, lowercase a-d.
 *
 * Kept line-anchored exactly as v1 had it: unlike A-D, the letters a-d occur
 * constantly inside ordinary prose, so allowing inline matches here would
 * generate false True/False blocks.
 */
const SUB_ITEM_AT_LINE_START = /(?:^|\n)[ \t]*([a-d])\s*[).\/]\s*/g;

/**
 * Phase 5.6 §2 — the same delimiter, additionally accepting uppercase A-D.
 *
 * Ministry (Bộ GD&ĐT) True/False sections label the four statements `A.`–`D.`.
 * This variant is used ONLY while a True/False section is active: outside one,
 * an uppercase A-D run is far more likely to be truncated MCQ options, which
 * must not be relabelled as sub-items.
 */
const SUB_ITEM_ANY_CASE_AT_LINE_START = /(?:^|\n)[ \t]*([a-dA-D])\s*[).\/]\s*/g;

/**
 * Phase 5.6 §3 — trailing True/False answer block.
 *
 * Ministry papers frequently omit inline Đ/S marks and instead print a single
 * key line such as "ĐÁP ÁN: A. Đúng B. Sai C. Đúng D. Đúng". Captured groups
 * 1-4 are the four verdicts in A→D order.
 */
const TF_ANSWER_KEY_BLOCK =
  /(?:đáp\s*án|đáp\s*án\s*tham\s*khảo)[\s:]*\n?\s*A[\s.:]+(đúng|sai|đ|s)[\s\t,;]+B[\s.:]+(đúng|sai|đ|s)[\s\t,;]+C[\s.:]+(đúng|sai|đ|s)[\s\t,;]+D[\s.:]+(đúng|sai|đ|s)/i;

/** Canonicalise a captured verdict token to the frozen "Đ" | "S" vocabulary. */
function toTrueFalseKey(value: string): 'Đ' | 'S' {
  return value.trim().toLowerCase().startsWith('đ') ? 'Đ' : 'S';
}

/**
 * Remove a trailing answer block from display text (Phase 5.6 §3).
 *
 * The key must never reach `question_text` or `options`: those strings are sent
 * to the student SPA, and leaking "ĐÁP ÁN: A. Đúng …" would hand over the entire
 * answer key. Only the marker and its key line are dropped — an inline
 * "đáp án:" belonging to a *different* construct is left untouched.
 */
function stripAnswerKeyBlock(value: string): string {
  if (!/đáp\s*án/i.test(value)) return value;
  return value
    .replace(TF_ANSWER_KEY_BLOCK, ' ')
    .replace(/đáp\s*án\s*(?:tham\s*khảo)?\s*[:;]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** v1 explanation marker (QuestionTypeParser.extractMCQ). */
const EXPLANATION_PATTERN =
  /(?:hướng dẫn giải|lời giải chi tiết|lời giải|giải thích|lý do|giải)\s*[:\-.]?\s*/i;

/** F4 essay keywords — absent from v1, added per ARCHITECTURE_FREEZE.md F4. */
const ESSAY_KEYWORDS =
  /(?:tự\s*luận|câu\s*hỏi\s*tự\s*luận|trình\s*bày|hãy\s*viết|viết\s*một\s*đoạn|nêu\s*cảm\s*nhận|phân\s*tích\s*và\s*chứng\s*minh|em\s*hãy)/i;

/* -------------------------------------------------------------------------- */
/* Marked-text tokenisation                                                   */
/* -------------------------------------------------------------------------- */

interface MarkedText {
  /** Text with all [CORRECT] markers removed. */
  text: string;
  /** mask[i] is true when text[i] originated inside a [CORRECT] span. */
  mask: boolean[];
}

/**
 * Strip markers while recording, per remaining character, whether it was inside
 * a marked span. O(n) single pass.
 */
function tokenize(marked: string): MarkedText {
  let text = '';
  const mask: boolean[] = [];
  let inside = false;
  let i = 0;

  while (i < marked.length) {
    if (marked.startsWith(CORRECT_OPEN, i)) {
      inside = true;
      i += CORRECT_OPEN.length;
      continue;
    }
    if (marked.startsWith(CORRECT_CLOSE, i)) {
      inside = false;
      i += CORRECT_CLOSE.length;
      continue;
    }
    text += marked[i];
    mask.push(inside);
    i++;
  }

  return { text, mask };
}

/** Slice both arrays consistently. */
function sliceMarked(source: MarkedText, start: number, end: number): MarkedText {
  return {
    text: source.text.slice(start, end),
    mask: source.mask.slice(start, end),
  };
}

/** Fraction of non-whitespace characters that were marked. */
function markedFraction(source: MarkedText): number {
  let total = 0;
  let marked = 0;
  for (let i = 0; i < source.text.length; i++) {
    const char = source.text[i] as string;
    if (char.trim() === '') continue;
    total++;
    if (source.mask[i] === true) marked++;
  }
  return total === 0 ? 0 : marked / total;
}

/** Collapse whitespace for display. */
function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Block segmentation                                                         */
/* -------------------------------------------------------------------------- */

type SectionKind = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'ESSAY' | 'UNKNOWN';

interface Block {
  section: SectionKind;
  /** Marker-free, whitespace-preserving lines. */
  lines: string[];
  /** Marker-free text with '\n' between lines. */
  text: string;
  /** Correctness mask aligned with `text`. */
  mask: boolean[];
}

/**
 * Map a roman-numeral section to a type.
 *
 * ARCHITECTURE NOTE: v1 (AnswerKeyExtractor.parseSectionType) mapped only
 * I→MCQ, II→TRUE_FALSE, III→SHORT_ANSWER with no ESSAY branch — essays were
 * unreachable via parsing (F4). v2 additionally recognises ESSAY through the
 * section *title* ("PHẦN IV. Tự luận") and per-block structural heuristics.
 */
function resolveSection(roman: string, title: string): SectionKind {
  if (ESSAY_KEYWORDS.test(title)) return 'ESSAY';
  switch (roman.toUpperCase()) {
    case 'I':
      return 'MCQ';
    case 'II':
      return 'TRUE_FALSE';
    case 'III':
      return 'SHORT_ANSWER';
    case 'IV':
    case 'V':
    case 'VI':
      return 'ESSAY';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Phase 5.6 §1 — resolve a section from a section-opening *line*.
 *
 * Returns null when the line does not open a section. The roman-numeral
 * `PHẦN II` spelling is tried first (it carries a title on the same line), then
 * the keyword forms (`PHẦN II. Câu trắc nghiệm đúng sai`) that Ministry papers
 * use. Both are needed: `PHẦN II. Tự luận` resolves to ESSAY via the title,
 * whereas a bare keyword line has no roman numeral at all.
 */
function detectSectionStart(clean: string): SectionKind | null {
  const roman = SECTION_HEADER.exec(clean);
  if (roman) return resolveSection(roman[1] ?? '', roman[2] ?? '');

  if (SECTION_TRUE_FALSE_KEYWORD.test(clean)) return 'TRUE_FALSE';
  if (SECTION_SHORT_ANSWER_KEYWORD.test(clean)) return 'SHORT_ANSWER';
  if (SECTION_MULTIPLE_CHOICE_KEYWORD.test(clean)) return 'MCQ';

  return null;
}

/**
 * Split the document into question blocks, tracking the active section.
 * Mirrors v1 QuestionBlockExtractor.extract().
 */
function segmentBlocks(marked: string): Block[] {
  const lines = marked.split('\n');
  const blocks: Block[] = [];

  let section: SectionKind = 'UNKNOWN';
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      const marked = current.join('\n');
      // Store BOTH the marker-free text and the aligned correctness mask.
      // Structural regexes must run against marker-free text, otherwise a
      // line-leading marker ("[CORRECT]D. ...") hides the option delimiter.
      const { text, mask } = tokenize(marked);
      blocks.push({ section, lines: current, text, mask });
      current = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/, '');
    if (line.trim() === '') continue;

    // Test structure on marker-free text.
    const clean = tokenize(line).text.trim();

    const sectionKind = detectSectionStart(clean);
    if (sectionKind !== null) {
      flush();
      section = sectionKind;
      continue;
    }

    if (QUESTION_START.test(clean)) {
      flush();
    }

    if (current.length > 0 || QUESTION_START.test(clean)) {
      current.push(line);
    }
  }
  flush();

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Option detection                                                           */
/* -------------------------------------------------------------------------- */

interface OptionSpan {
  index: number;
  /** Marked-for-display text, markers already stripped. */
  text: string;
  fraction: number;
}

interface ParsedOptions {
  /** Marked text of the question stem. */
  stem: MarkedText;
  options: OptionSpan[];
}

/**
 * Collect candidate delimiters, then return the first strict A→B→C→D run.
 * Requires all four letters in order, which is what separates genuine options
 * from stray letter-dot sequences inside prose.
 */
function collectOptionRun(
  text: string,
  pattern: RegExp,
): Array<{ start: number; end: number; letter: string }> | null {
  const candidates: Array<{ start: number; end: number; letter: string }> = [];

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const lead = match[0].length - match[0].replace(/^[\s\n]/, '').length;
    candidates.push({
      start: match.index + lead,
      end: match.index + match[0].length,
      letter: (match[1] ?? '').toUpperCase(),
    });
  }

  for (let i = 0; i < candidates.length; i++) {
    let length = 0;
    for (let j = i; j < candidates.length && length < 4; j++) {
      if ((candidates[j] as { letter: string }).letter !== String.fromCharCode(65 + length)) break;
      length++;
    }
    if (length === 4) return candidates.slice(i, i + 4);
  }

  return null;
}

/**
 * Locate the four option spans A-D.
 *
 * Pass 1 (line-anchored) is strongly structural and handles the common
 * one-option-per-line layout. Pass 2 (inline, whitespace-required) handles the
 * "…là A. … B. … C. … D. …" layout while ignoring abbreviations like "C.Mác".
 * A partial run (fewer than 4 letters) is accepted only from pass 1 when it
 * starts at position 0 — i.e. the block genuinely begins with option A.
 */
function findOptions(body: MarkedText): ParsedOptions | null {
  let run = collectOptionRun(body.text, OPTION_LINE_ANCHORED);

  if (run === null) {
    run = collectOptionRun(body.text, OPTION_INLINE);
  }

  if (run === null) {
    // Truncated question: A,B,C with no D, laid out one per line.
    const partial = collectPartialRun(body.text, OPTION_LINE_ANCHORED);
    if (partial !== null) run = partial;
  }

  if (run === null || run.length < 2) return null;

  const first = run[0] as { start: number; end: number; letter: string };
  const stem = sliceMarked(body, 0, first.start);
  const options: OptionSpan[] = [];

  for (let i = 0; i < run.length; i++) {
    const span = run[i] as { start: number; end: number; letter: string };
    const nextStart = i + 1 < run.length ? (run[i + 1] as { start: number }).start : body.text.length;
    const content = sliceMarked(body, span.end, nextStart);
    const text = squash(content.text);
    if (text === '') continue;

    // The correctness marker may cover the option body ("[CORRECT]D. foo[/CORRECT]")
    // or only the delimiter letter ("[CORRECT]C.[/CORRECT] Lý Bí."). Both are
    // genuine keys, so take the stronger of the two signals.
    const bodyFraction = markedFraction(content);
    const delimiterFraction = markedFraction(sliceMarked(body, span.start, span.end));

    options.push({ index: i, text, fraction: Math.max(bodyFraction, delimiterFraction) });
  }

  return options.length >= 2 ? { stem, options } : null;
}

/** First line-anchored A,B,C[,D] sequence, accepting a short trailing run. */
function collectPartialRun(
  text: string,
  pattern: RegExp,
): Array<{ start: number; end: number; letter: string }> | null {
  const candidates: Array<{ start: number; end: number; letter: string }> = [];

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const lead = match[0].length - match[0].replace(/^[\s\n]/, '').length;
    candidates.push({
      start: match.index + lead,
      end: match.index + match[0].length,
      letter: (match[1] ?? '').toUpperCase(),
    });
  }

  if (candidates.length < 2) return null;
  const first = candidates[0] as { start: number; letter: string };
  if (first.start !== 0 || first.letter !== 'A') return null;

  let length = 0;
  for (let j = 0; j < candidates.length && length < 4; j++) {
    if ((candidates[j] as { letter: string }).letter !== String.fromCharCode(65 + length)) break;
    length++;
  }

  return length >= 2 ? candidates.slice(0, length) : null;
}

/**
 * Resolve which option is correct.
 *
 * Primary signal is the F5 [CORRECT] span. Because Word sometimes underlines or
 * colours only part of an option, a mostly-marked span also counts.
 */
function resolveCorrectIndex(options: OptionSpan[]): number {
  const fully = options.filter((option) => option.fraction >= 0.5);
  if (fully.length >= 1) return (fully[0] as OptionSpan).index;

  const partial = options.filter((option) => option.fraction > 0);
  if (partial.length === 1) return (partial[0] as OptionSpan).index;

  return -1;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

/** Strip a leading question number: "Câu 5. foo" -> "foo". */
function stripQuestionNumber(value: string): string {
  return value.replace(/^\s*(?:câu|question|q)?\s*\d+\s*[.):\-\/]\s*/i, '');
}

function buildMcq(block: Block, position: number): ExtractedQuestion | null {
  const parsed = findOptions({ text: block.text, mask: block.mask });
  if (!parsed) return null;

  const stemText = squash(stripQuestionNumber(parsed.stem.text));
  if (stemText.length < 3) return null;

  let explanation: string | null = null;
  const last = parsed.options[parsed.options.length - 1] as OptionSpan;
  const explanationMatch = EXPLANATION_PATTERN.exec(last.text);
  if (explanationMatch && explanationMatch.index > 0) {
    explanation = squash(last.text.slice(explanationMatch.index + explanationMatch[0].length));
    last.text = squash(last.text.slice(0, explanationMatch.index));
    if (explanation === '') explanation = null;
  }

  const correctIndex = resolveCorrectIndex(parsed.options);
  const optionTexts = parsed.options.map((option) => option.text);
  while (optionTexts.length < 4) optionTexts.push('');

  return {
    position,
    question_type: 'MULTIPLE_CHOICE',
    question_text: stemText,
    options: optionTexts,
    // Integer index 0..3 — the Phase 1 contract (v2/supabase/schema.sql A.2).
    correct_answer: correctIndex >= 0 ? correctIndex : null,
    explanation,
  };
}

/**
 * Collect the first four a/b/c/d (or A/B/C/D) sub-item delimiters, skipping any
 * that fall inside a trailing answer block.
 *
 * @param anyCase also accept uppercase A-D (Phase 5.6 §2, True/False sections).
 */
function collectSubItemStarts(
  body: MarkedText,
  anyCase = false,
): Array<{ start: number; end: number }> {
  const pattern = anyCase ? SUB_ITEM_ANY_CASE_AT_LINE_START : SUB_ITEM_AT_LINE_START;
  const keyMatch = TF_ANSWER_KEY_BLOCK.exec(body.text);
  const keyStart = keyMatch ? keyMatch.index : -1;
  const keyEnd = keyMatch ? keyMatch.index + keyMatch[0].length : -1;

  const starts: Array<{ start: number; end: number }> = [];

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body.text)) !== null) {
    const delimStart = match.index + (match[0].startsWith('\n') ? 1 : 0);
    // Never treat the answer-block line as a statement.
    if (keyStart >= 0 && delimStart >= keyStart && delimStart < keyEnd) continue;
    starts.push({ start: delimStart, end: match.index + match[0].length });
    if (starts.length === 4) break;
  }

  return starts;
}

/**
 * True/False builder.
 *
 * Two key layouts are supported (Phase 5.6):
 *   (a) inline marks — "a) [CORRECT]Đ[/CORRECT] 2 + 2 = 4";
 *   (b) a trailing answer block — "ĐÁP ÁN: A. Đúng B. Sai C. Đúng D. Đúng".
 * Layout (b) is what the Ministry papers ship when the sub-items carry no
 * formatting at all, and the block must be stripped from the output so the key
 * never leaks into the student's view.
 *
 * Sub-items may be lowercase `a)` or uppercase `A.` (Phase 5.6 §2).
 * When neither key form is present the array stays null, which drives the
 * mode=auto AI fallback.
 */
function buildTrueFalse(block: Block, position: number): ExtractedQuestion | null {
  const body: MarkedText = { text: block.text, mask: block.mask };

  const keyMatch = TF_ANSWER_KEY_BLOCK.exec(body.text);
  // Inside a declared True/False section the statements may be labelled A-D.
  const starts = collectSubItemStarts(body, block.section === 'TRUE_FALSE');

  if (starts.length < 2) return null;

  const first = starts[0] as { start: number; end: number };
  const stemText = stripAnswerKeyBlock(
    squash(stripQuestionNumber(sliceMarked(body, 0, first.start).text)),
  );

  const statements: string[] = [];
  const answers: Array<'Đ' | 'S' | ''> = [];

  for (let i = 0; i < starts.length; i++) {
    const span = starts[i] as { start: number; end: number };
    const nextStart =
      i + 1 < starts.length ? (starts[i + 1] as { start: number }).start : body.text.length;
    const segment = sliceMarked(body, span.end, nextStart);

    // Find a marked boolean token inside this sub-item.
    let answer: 'Đ' | 'S' | '' = '';
    const tokenPattern = /(đúng|sai|đ|s)(?![a-zA-Zà-ỹ])/gi;
    let token: RegExpExecArray | null;
    while ((token = tokenPattern.exec(segment.text)) !== null) {
      const at = token.index;
      if (segment.mask[at] !== true) continue;
      const value = (token[1] ?? '').toLowerCase();
      answer = value.startsWith('đ') ? 'Đ' : 'S';
      break;
    }

    let statement = squash(segment.text);
    if (answer !== '') {
      // Remove the resolved key token from the statement text.
      statement = squash(statement.replace(/^(?:đúng|sai|đ|s)\b[.:)\-]?\s*/i, ''));
    }

    statements.push(stripAnswerKeyBlock(statement));
    answers.push(answer);
  }

  if (statements.length < 2) return null;

  // Prefer inline marks; fall back to the trailing block (Phase 5.6 §3).
  const inlineResolved = answers.every((answer) => answer !== '');
  const trailingKeys = keyMatch
    ? ([
        toTrueFalseKey(keyMatch[1] ?? ''),
        toTrueFalseKey(keyMatch[2] ?? ''),
        toTrueFalseKey(keyMatch[3] ?? ''),
        toTrueFalseKey(keyMatch[4] ?? ''),
      ] as Array<'Đ' | 'S'>)
    : null;

  let correctAnswer: Array<'Đ' | 'S'> | null = null;
  if (inlineResolved) correctAnswer = answers as Array<'Đ' | 'S'>;
  else if (trailingKeys !== null) correctAnswer = trailingKeys;

  return {
    position,
    question_type: 'TRUE_FALSE',
    question_text: stemText,
    options: statements,
    // Array of Đ/S keys, one per sub-item — Phase 1 contract (schema A.2).
    correct_answer: correctAnswer,
    explanation: null,
  };
}

/** Extract a marked short-answer value from a block, if any. */
function resolveShortAnswer(body: MarkedText): string | null {
  const lines = body.text.split('\n');
  const masks = splitMaskByLine(body);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineMask = masks[i] ?? [];
    let markedText = '';
    for (let j = 0; j < line.length; j++) {
      if (lineMask[j] === true) markedText += line[j];
    }
    const value = squash(markedText);
    if (value !== '') return value;
  }

  const explicit = /đáp\s*án\s*[:\-]\s*([^\n]+)/i.exec(body.text);
  if (explicit?.[1]) {
    const value = squash(explicit[1]);
    if (value !== '') return value;
  }

  return null;
}

/** Re-split a mask array along '\n' boundaries to match `text.split('\n')`. */
function splitMaskByLine(body: MarkedText): boolean[][] {
  const result: boolean[][] = [];
  let current: boolean[] = [];
  for (let i = 0; i < body.text.length; i++) {
    if (body.text[i] === '\n') {
      result.push(current);
      current = [];
    } else {
      current.push(body.mask[i] === true);
    }
  }
  result.push(current);
  return result;
}

function buildShortAnswer(block: Block, position: number): ExtractedQuestion {
  const body: MarkedText = { text: block.text, mask: block.mask };
  const answer = resolveShortAnswer(body);
  const withoutAnswer = body.text
    .split('\n')
    .filter((line) => !/đáp\s*án\s*[:\-]/i.test(line))
    .join(' ');

  return {
    position,
    question_type: 'SHORT_ANSWER',
    question_text: squash(stripQuestionNumber(withoutAnswer)),
    options: [],
    correct_answer: answer,
    explanation: null,
  };
}

function buildEssay(block: Block, position: number): ExtractedQuestion {
  return {
    position,
    question_type: 'ESSAY',
    question_text: squash(stripQuestionNumber(block.text)),
    options: [],
    correct_answer: null,
    explanation: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decide the type of one block (F4).
 *
 * Order (Phase 5.6):
 *   1. A declared True/False section wins outright. Ministry Part II blocks
 *      carry `a. …`–`d. …` statements, but a formatting accident can also make
 *      them look like MCQ options — the section header is the stronger signal,
 *      so it is checked before `findOptions()`.
 *   2. Options imply MCQ.
 *   3. a/b/c/d sub-items imply True/False.
 *   4. Then the section declaration (essay / short answer).
 *   5. Then the essay keyword heuristic.
 *   6. Otherwise Short Answer (the v1 parseUnknownBlock() fallthrough).
 */
function classifyBlock(block: Block): QuestionType {
  const body: MarkedText = { text: block.text, mask: block.mask };

  if (block.section === 'TRUE_FALSE' && collectSubItemStarts(body, true).length >= 2) {
    return 'TRUE_FALSE';
  }

  if (findOptions(body) !== null) return 'MULTIPLE_CHOICE';

  SUB_ITEM_AT_LINE_START.lastIndex = 0;
  const subItems = (body.text.match(SUB_ITEM_AT_LINE_START) ?? []).length;
  if (subItems >= 2) return 'TRUE_FALSE';

  if (block.section === 'ESSAY') return 'ESSAY';
  if (block.section === 'TRUE_FALSE') return 'TRUE_FALSE';
  if (block.section === 'SHORT_ANSWER') return 'SHORT_ANSWER';

  if (ESSAY_KEYWORDS.test(block.text)) return 'ESSAY';

  return 'SHORT_ANSWER';
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export interface RuleEngineResult {
  data: ExtractedQuestion[];
  question_count: number;
  has_answers: boolean;
}

/**
 * Run Engine 1 over preprocessed DOCX text.
 *
 * @param text marked-up text from `preprocessDocx().text`
 */
export function extractWithRules(text: string): RuleEngineResult {
  const blocks = segmentBlocks(text);
  const data: ExtractedQuestion[] = [];
  let position = 1;

  for (const block of blocks) {
    const kind = classifyBlock(block);

    let question: ExtractedQuestion | null = null;
    switch (kind) {
      case 'MULTIPLE_CHOICE':
        question = buildMcq(block, position);
        break;
      case 'TRUE_FALSE':
        question = buildTrueFalse(block, position);
        break;
      case 'SHORT_ANSWER':
        question = buildShortAnswer(block, position);
        break;
      case 'ESSAY':
        question = buildEssay(block, position);
        break;
    }

    // A block shaped like MCQ but yielding no usable options degrades to the
    // v1 parseUnknownBlock() behaviour instead of being dropped.
    if (question === null && kind === 'MULTIPLE_CHOICE') {
      question = buildShortAnswer(block, position);
    }
    if (question === null) continue;
    if (question.question_text === '') continue;

    data.push(question);
    position++;
  }

  const hasAnswers = data.some((question) => question.correct_answer !== null);
  return { data, question_count: data.length, has_answers: hasAnswers };
}
