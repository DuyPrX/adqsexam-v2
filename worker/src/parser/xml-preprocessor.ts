/**
 * DOCX → marked-up text preprocessor.
 *
 * Responsibilities:
 *   1. Zip-bomb-hardened extraction of `word/document.xml` only.
 *   2. Streaming OOXML scan producing normalized text in document order.
 *   3. F5 "superset" correctness tagging: a run is marked [CORRECT] when it is
 *      Bold (w:b) OR Underlined (w:u) OR Red (w:color in {FF*, EE*, C0*, c00000, red}).
 *
 * Ports the semantics of the v1 Java reference
 * `backend/src/main/java/com/docxsaas/service/DocxTextProcessor.java`
 * (the superset implementation, per ARCHITECTURE_FREEZE.md F5).
 *
 * WHY A HAND-WRITTEN SCANNER (not fast-xml-parser's DOM):
 * Benchmark on `sample/test2.docx` (44 KB, 555 KB inflated XML):
 *   fflate unzip .................  2.0 ms
 *   fast-xml-parser (any mode) ... 37.6 ms   <-- 89% of total CPU
 *   single-pass regex scan .......  0.14 ms
 * The Cloudflare Worker CPU budget is 10 ms, so materialising a full object tree
 * is not affordable. The ROADMAP prescribes exactly this ("Fast regex + XML
 * stream parsing") and <50ms is only reachable via a streaming scan that never
 * allocates a node per element. This scanner is therefore the Engine 1 design,
 * not a micro-optimisation.
 */

import { unzipSync } from 'fflate';

/** Hard limit on the uploaded archive (compressed). */
export const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
/** Hard limit on any single inflated entry. */
export const MAX_INFLATED_BYTES = 128 * 1024 * 1024; // 128 MB

/** Marker emitted around a run that carries a correctness signal. */
export const CORRECT_OPEN = '[CORRECT]';
export const CORRECT_CLOSE = '[/CORRECT]';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const MAIN_DOCUMENT_PART = 'word/document.xml';

export class DocxError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_A_ZIP'
      | 'TOO_LARGE'
      | 'MISSING_DOCUMENT'
      | 'INFLATED_TOO_LARGE'
      | 'MALFORMED_XML',
  ) {
    super(message);
    this.name = 'DocxError';
  }
}

/* -------------------------------------------------------------------------- */
/* Layer 1 — archive                                                          */
/* -------------------------------------------------------------------------- */

function assertZipMagic(bytes: Uint8Array): void {
  if (bytes.length < 4) {
    throw new DocxError('File is too small to be a DOCX archive.', 'NOT_A_ZIP');
  }
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (bytes[i] !== ZIP_MAGIC[i]) {
      throw new DocxError('Missing PK\\x03\\x04 signature — not a DOCX/ZIP file.', 'NOT_A_ZIP');
    }
  }
}

/**
 * Inflate only `word/document.xml`.
 *
 * Zip-bomb defence: fflate invokes the filter for every central-directory entry
 * *before* inflating it, so an oversized target is rejected without ever being
 * decompressed. Because every other entry is filtered out, the single-entry cap
 * doubles as the total-inflation cap.
 */
export function extractDocumentXml(archive: Uint8Array): string {
  if (archive.byteLength > MAX_COMPRESSED_BYTES) {
    throw new DocxError(
      `Archive is ${archive.byteLength} bytes, exceeding the ${MAX_COMPRESSED_BYTES} byte limit.`,
      'TOO_LARGE',
    );
  }
  assertZipMagic(archive);

  let oversize = -1;
  let found = false;

  const files = unzipSync(archive, {
    filter: (file) => {
      if (file.name !== MAIN_DOCUMENT_PART) return false;
      found = true;
      if (file.originalSize > MAX_INFLATED_BYTES) {
        oversize = file.originalSize;
        return false; // never inflate a bomb
      }
      return true;
    },
  });

  if (oversize >= 0) {
    throw new DocxError(
      `word/document.xml inflates to ${oversize} bytes, exceeding the ${MAX_INFLATED_BYTES} byte limit.`,
      'INFLATED_TOO_LARGE',
    );
  }
  if (!found) {
    throw new DocxError('DOCX is missing word/document.xml.', 'MISSING_DOCUMENT');
  }

  const entry = files[MAIN_DOCUMENT_PART];
  if (!entry || entry.byteLength === 0) {
    throw new DocxError('word/document.xml is empty or unreadable.', 'MISSING_DOCUMENT');
  }

  return new TextDecoder('utf-8').decode(entry);
}

/* -------------------------------------------------------------------------- */
/* Layer 2 — streaming OOXML scan                                             */
/* -------------------------------------------------------------------------- */

/**
 * Matches either a complete tag or a run of text between tags.
 * Quoted attribute values are consumed atomically so a `>` inside an attribute
 * cannot terminate the tag early.
 */
const TAG_OR_TEXT = /<((?:"[^"]*"|'[^']*'|[^"'>])*)>|([^<]+)/g;

/** OOXML boolean toggle semantics: absent `w:val` means ON. */
function toggleOn(value: string | null): boolean {
  if (value === null) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

/**
 * Read `w:val="..."` from a raw tag body, starting the search after the tag name.
 *
 * Called for every `w:b` / `w:u` / `w:color` in the document, so this avoids
 * allocating an attribute substring and a fresh RegExp on each call.
 */
function attrValue(inner: string, fromIndex: number): string | null {
  const quote = inner.indexOf('w:val', fromIndex);
  if (quote === -1) return null;

  // Expect: w:val <ws>* = <ws>* "<value>"
  let cursor = quote + 5;
  while (cursor < inner.length && inner.charCodeAt(cursor) === 32) cursor++;
  if (inner.charCodeAt(cursor) !== 61) return null; // '='
  cursor++;
  while (cursor < inner.length && inner.charCodeAt(cursor) === 32) cursor++;
  if (inner.charCodeAt(cursor) !== 34) return null; // '"'
  cursor++;
  const end = inner.indexOf('"', cursor);
  if (end === -1) return null;
  return inner.slice(cursor, end);
}

/**
 * F5 superset red detection: FF*, EE*, C0* families plus the literal "red".
 * Theme/automatic colours are never a correctness signal.
 */
function isRedColor(value: string | null): boolean {
  if (value === null) return false;
  const upper = value.trim().toUpperCase();
  if (upper === '' || upper === 'AUTO' || upper === 'NONE') return false;
  if (upper === 'RED') return true;
  return upper.startsWith('FF') || upper.startsWith('EE') || upper.startsWith('C0');
}

const ENTITY_PATTERN = /&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;

/** Decode the XML entities that can appear inside `w:t`. */
function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value;
  return value.replace(ENTITY_PATTERN, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
      }
    }
  });
}

/** Collapse whitespace the way the v1 processor did (`\s+` → ` `). */
function squash(value: string): string {
  return value.replace(/\s+/g, ' ');
}

interface ScanState {
  /** Emitted paragraphs / table rows. */
  pieces: string[];
  /** Text accumulated for the paragraph currently open. */
  paraOut: string;
  /** Whether a [CORRECT] span is currently open in the active paragraph. */
  spanOpen: boolean;
  /** Text accumulated for the run currently open. */
  runText: string;
  /** Nesting depth of <w:r> (guards against pPr-level rPr leaks). */
  runDepth: number;
  /** Nesting depth of <w:rPr>. */
  rPrDepth: number;
  /** Nesting depth of <w:t> (text only counts inside it). */
  textDepth: number;
  /** Nesting depth of <w:tbl>. */
  tableDepth: number;
  /** Marking flags for the run currently open. */
  bold: boolean;
  underline: boolean;
  red: boolean;
  /** Diagnostics. */
  sawBody: boolean;
  sawParagraph: boolean;
}

/** Close an open correctness span, if any. */
function closeSpan(state: ScanState): void {
  if (state.spanOpen) {
    state.paraOut += CORRECT_CLOSE;
    state.spanOpen = false;
  }
}

/**
 * Flush the current run into the paragraph buffer, coalescing consecutive marked
 * runs into a single [CORRECT]...[/CORRECT] pair.
 *
 * Coalescing matters because Word splits one visually continuous red/underlined
 * option across many runs; without it the output would be peppered with adjacent
 * empty marker pairs and the rule engine could not match option text cleanly.
 */
function flushRun(state: ScanState): void {
  const text = squash(state.runText);
  state.runText = '';

  if (text === '') return;

  const marked = state.bold || state.underline || state.red;
  const whitespaceOnly = text.trim() === '';

  if (marked && !whitespaceOnly) {
    if (!state.spanOpen) {
      state.paraOut += CORRECT_OPEN;
      state.spanOpen = true;
    }
  } else if (!(whitespaceOnly && state.spanOpen)) {
    // Whitespace between two marked runs must not split the span.
    closeSpan(state);
  }

  state.paraOut += text;
}

/** Flush the paragraph currently open into the output. */
function flushParagraph(state: ScanState): void {
  closeSpan(state);
  state.runText = '';

  const text = state.paraOut;
  state.paraOut = '';

  if (text.trim() === '') return;

  state.sawParagraph = true;
  if (state.tableDepth > 0) {
    // Keep a table row on one output line.
    state.pieces.push(text.replace(/[ \t]+$/, '') + ' ');
  } else {
    state.pieces.push(text.replace(/[ \t]+$/, ''));
  }
}

/**
 * Single-pass scan over `word/document.xml`.
 *
 * Emits the same normalized text the DOM walk produced, at ~1/250th the CPU.
 */
function scanDocument(xml: string): { pieces: string[]; sawParagraph: boolean } {
  const state: ScanState = {
    pieces: [],
    paraOut: '',
    spanOpen: false,
    runText: '',
    runDepth: 0,
    rPrDepth: 0,
    textDepth: 0,
    tableDepth: 0,
    bold: false,
    underline: false,
    red: false,
    sawBody: false,
    sawParagraph: false,
  };

  TAG_OR_TEXT.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_OR_TEXT.exec(xml)) !== null) {
    const tagBody = match[1];
    const textRun = match[2];

    // ---- text node -------------------------------------------------------
    if (textRun !== undefined) {
      if (state.runDepth > 0 && state.textDepth > 0) {
        state.runText += decodeEntities(textRun);
      }
      continue;
    }

    if (tagBody === undefined) continue;

    const closing = tagBody.startsWith('/');
    const selfClosing = tagBody.endsWith('/');
    // Strip the leading '/' (closing) and trailing '/' (self-closing) so the
    // name comparison below works for all three tag forms.
    let inner = closing ? tagBody.slice(1) : tagBody;
    if (!closing && selfClosing) inner = inner.slice(0, -1);

    // Find the end of the tag name (first whitespace).
    let cursor = 0;
    while (cursor < inner.length) {
      const code = inner.charCodeAt(cursor);
      if (code === 32 || code === 9 || code === 10 || code === 13) break;
      cursor++;
    }

    // Match on the local name so an alternative prefix still matches.
    const rawName = inner.slice(0, cursor);
    // `w:` is 2 chars; only slice when the prefix is actually present.
    const name =
      rawName.charCodeAt(0) === 119 && rawName.charCodeAt(1) === 58 ? rawName.slice(2) : rawName;

    // Attributes are only needed by a handful of tags. Deriving them lazily
    // avoids a substring allocation for the ~90% of tags that ignore them.
    switch (name) {
      case 'body':
        state.sawBody = true;
        break;

      case 'r':
        if (closing) {
          flushRun(state);
          state.runDepth = Math.max(0, state.runDepth - 1);
        } else {
          // Flags are per-run; rPr children of pPr must not leak in.
          state.runDepth++;
          state.bold = false;
          state.underline = false;
          state.red = false;
          state.runText = '';
        }
        break;

      case 'rPr':
        state.rPrDepth = closing ? Math.max(0, state.rPrDepth - 1) : state.rPrDepth + 1;
        break;

      case 'b':
        // Only honour run-level formatting (runDepth > 0); a paragraph-mark rPr
        // sits at runDepth 0 and would otherwise mark the whole document bold.
        if (!closing && state.runDepth > 0 && state.rPrDepth > 0) {
          state.bold = toggleOn(attrValue(inner, cursor));
        }
        break;

      case 'u': {
        if (!closing && state.runDepth > 0 && state.rPrDepth > 0) {
          const val = attrValue(inner, cursor);
          state.underline = val === null ? true : val.trim().toLowerCase() !== 'none';
        }
        break;
      }

      case 'color':
        if (!closing && state.runDepth > 0 && state.rPrDepth > 0) {
          state.red = isRedColor(attrValue(inner, cursor));
        }
        break;

      case 't':
        if (selfClosing) break;
        state.textDepth = closing ? Math.max(0, state.textDepth - 1) : state.textDepth + 1;
        break;

      case 'tab':
        if (state.runDepth > 0) state.runText += ' ';
        break;

      case 'br':
      case 'cr':
        if (state.runDepth > 0) state.runText += '\n';
        break;

      case 'p':
        if (closing) flushParagraph(state);
        break;

      case 'tbl':
        state.tableDepth = closing ? Math.max(0, state.tableDepth - 1) : state.tableDepth + 1;
        break;

      case 'tr':
        if (closing) state.pieces.push('|\n');
        else state.pieces.push('| ');
        break;

      case 'tc':
        if (closing && state.tableDepth > 0) state.pieces.push(' ');
        break;

      default:
        break;
    }
  }

  return { pieces: state.pieces, sawParagraph: state.sawParagraph };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export interface PreprocessedDocument {
  /** Marked-up text: paragraphs separated by \n, [CORRECT] spans preserved. */
  text: string;
  /** Count of emitted [CORRECT] spans — cheap signal that formatting was found. */
  correctSpanCount: number;
}

/**
 * Convert a DOCX archive into marked-up text.
 *
 * @throws DocxError on archive/limit/XML problems.
 */
export function preprocessDocx(archive: Uint8Array): PreprocessedDocument {
  const xml = extractDocumentXml(archive);

  if (!xml.includes('<w:document') && !xml.includes(':document')) {
    throw new DocxError('word/document.xml has no <w:document> root.', 'MALFORMED_XML');
  }

  const { pieces, sawParagraph } = scanDocument(xml);

  if (!sawParagraph && !xml.includes('<w:body') && !xml.includes(':body')) {
    throw new DocxError('word/document.xml has no <w:body>.', 'MALFORMED_XML');
  }

  const text = pieces
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const correctSpanCount = text.split(CORRECT_OPEN).length - 1;
  return { text, correctSpanCount };
}

/* -------------------------------------------------------------------------- */
/* Marker helpers (shared with the rule engine)                               */
/* -------------------------------------------------------------------------- */

/** Remove [CORRECT] markers, returning clean display text. */
export function stripMarkers(value: string): string {
  return value.split(CORRECT_OPEN).join('').split(CORRECT_CLOSE).join('');
}

/** True when the value contains at least one [CORRECT] span. */
export function hasMarker(value: string): boolean {
  return value.includes(CORRECT_OPEN);
}
