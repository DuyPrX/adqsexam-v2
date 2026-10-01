import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preprocessDocx } from '../src/parser/xml-preprocessor';
import { extractWithRules } from '../src/parser/rule-engine';

const archive = new Uint8Array(readFileSync(resolve('../../sample/test2.docx')));
console.log(`Archive: ${archive.byteLength} bytes (inflates to 555 KB XML)\n`);

for (let i = 0; i < 50; i++) {
  extractWithRules(preprocessDocx(archive).text);
}

function bench(label: string, fn: () => void, iterations = 300): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const perRun = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  console.log(`${label.padEnd(38)} ${perRun.toFixed(2)} ms/run`);
  return perRun;
}

let text = '';
bench('preprocessDocx (unzip + stream + mark)', () => {
  text = preprocessDocx(archive).text;
});
bench('extractWithRules (Engine 1)', () => {
  extractWithRules(text);
});
const total = bench('END TO END (preprocess + rule engine)', () => {
  extractWithRules(preprocessDocx(archive).text);
});

console.log('\n--- Cloudflare CPU budget ---');
console.log(`Measured: ${total.toFixed(2)} ms  |  Budget: 10 ms  |  ${total <= 10 ? 'PASS' : 'OVER BUDGET'}`);
console.log('(Node V8; workerd startup excluded. Wall-clock via wrangler dev was ~60ms,');
console.log(' dominated by isolate boot + network, not CPU.)');
