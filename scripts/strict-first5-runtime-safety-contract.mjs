import fs from 'node:fs';

const file = 'src/server/firstFiveSheetsReconcile.ts';
const source = fs.readFileSync(file, 'utf8');

const checks = [
  ['supplier helper exists', source.includes('function sourceVendor(url: string)')],
  ['fallback uses exact vendor identity', source.includes('vendorExact')],
  ['fallback uses exact normalized title identity', source.includes('titleExact')],
  ['fallback requires source/SKU identity', source.includes('identityExact')],
  ['fallback requires all three independent signals', source.includes('vendorExact && entry.titleExact && entry.identityExact')],
  ['weak score threshold is removed', !source.includes('score >= 20')],
  ['single-candidate auto-accept is removed', !/candidates\.length\s*===\s*1[\s\S]{0,220}return/.test(source)],
  ['Max multi-color guard exists', source.includes('Max product has multiple Shopify colors')],
  ['403 is not classified as out-of-stock', !/403[\s\S]{0,180}(out[- ]?of[- ]?stock|sold[- ]?out)/i.test(source)],
];

let failures = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failures += 1;
}

console.log(`Strict first-five runtime safety: ${checks.length - failures}/${checks.length} checks passed.`);
if (failures) {
  console.error('Fail closed: first-five runtime is not safe enough for canary writes.');
  process.exit(1);
}
