/**
 * Verification harness — runs both engines' non-networked path over a real DOCX.
 *
 * Usage (from v2/worker):
 *   npm run verify:sample
 *
 * Bundle+runs via esbuild so it can import the Worker sources directly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preprocessDocx, stripMarkers } from '../src/parser/xml-preprocessor';
import { extractWithRules } from '../src/parser/rule-engine';
import { coerceCorrectAnswer } from '../src/ai/ai-engine';
import type { ExtractedQuestion } from '../src/types';

const samplePath = resolve(process.argv[2] ?? '../../sample/test2.docx');

function describe(question: ExtractedQuestion): string {
  const answer =
    question.correct_answer === null
      ? 'null'
      : Array.isArray(question.correct_answer)
        ? JSON.stringify(question.correct_answer)
        : JSON.stringify(question.correct_answer);

  const lines = [
    `  #${question.position} [${question.question_type}] answer=${answer}`,
    `     Q: ${question.question_text.slice(0, 110)}`,
  ];
  question.options.forEach((option, index) => {
    const letter = String.fromCharCode(65 + index);
    lines.push(`     ${letter}. ${option.slice(0, 100)}`);
  });
  return lines.join('\n');
}

const archive = new Uint8Array(readFileSync(samplePath));

console.log(`=== Input: ${samplePath} (${archive.byteLength} bytes) ===\n`);

// --- Stage 1: preprocessing -------------------------------------------------
const pre = preprocessDocx(archive);
console.log('--- xml-preprocessor ---');
console.log(`text length        : ${pre.text.length}`);
console.log(`[CORRECT] spans    : ${pre.correctSpanCount}`);
console.log(`paragraphs         : ${pre.text.split('\n').length}`);
console.log('\n--- first 900 chars of marked-up text ---');
console.log(pre.text.slice(0, 900));

// --- Stage 2: rule engine ---------------------------------------------------
const rules = extractWithRules(pre.text);
console.log('\n--- rule-engine (Engine 1) ---');
console.log(`question_count     : ${rules.question_count}`);
console.log(`has_answers        : ${rules.has_answers}`);

const byType = rules.data.reduce<Record<string, number>>((acc, question) => {
  acc[question.question_type] = (acc[question.question_type] ?? 0) + 1;
  return acc;
}, {});
console.log(`by type            : ${JSON.stringify(byType)}`);

const withAnswers = rules.data.filter((question) => question.correct_answer !== null).length;
console.log(`with answers       : ${withAnswers} / ${rules.question_count}`);

for (const question of rules.data.slice(0, 6)) {
  console.log('\n' + describe(question));
}

// --- Stage 3: answer distribution sanity check ------------------------------
const mcq = rules.data.filter((question) => question.question_type === 'MULTIPLE_CHOICE');
const distribution = mcq.reduce<Record<string, number>>((acc, question) => {
  const key = String(question.correct_answer);
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nMCQ answer distribution (index -> count): ${JSON.stringify(distribution)}`);

// --- Stage 4: coerceCorrectAnswer unit checks -------------------------------
console.log('\n--- coerceCorrectAnswer ---');
const cases: Array<[unknown, Parameters<typeof coerceCorrectAnswer>[1], unknown]> = [
  ['"2"', 'MULTIPLE_CHOICE', 2],
  ['2', 'MULTIPLE_CHOICE', 2],
  ['"C"', 'MULTIPLE_CHOICE', 2],
  ['"null"', 'MULTIPLE_CHOICE', null],
  ['["Đ","S","Đ","S"]', 'TRUE_FALSE', ['Đ', 'S', 'Đ', 'S']],
  ['["D","S","d","s"]', 'TRUE_FALSE', ['Đ', 'S', 'Đ', 'S']],
  ['"3"', 'SHORT_ANSWER', '3'],
  ['"3,5"', 'SHORT_ANSWER', '3,5'],
  ['"null"', 'ESSAY', null],
];

let failures = 0;
for (const [raw, type, expected] of cases) {
  const actual = coerceCorrectAnswer(raw, type);
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${type.padEnd(16)} ${JSON.stringify(raw)} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

// --- Stage 5: no-answer-leak assertion --------------------------------------
const leaked = rules.data.some((question) => {
  const haystack = question.question_text + ' ' + question.options.join(' ');
  return haystack.includes('[CORRECT]') || haystack.includes('[/CORRECT]');
});
console.log(`\nmarker leakage into output : ${leaked ? 'FAIL' : 'PASS (clean)'}`);

console.log(`\n=== ${failures === 0 ? 'ALL COERCION CHECKS PASSED' : `${failures} COERCION CHECK(S) FAILED`} ===`);

if (failures > 0 || leaked) process.exitCode = 1;
