import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve('scripts/run-sheet1-live-reconcile.mjs');
const source = fs.readFileSync(scriptPath, 'utf8');

function requireText(text: string, message: string) {
  if (!source.includes(text)) {
    throw new Error(message);
  }
}

function forbidText(text: string, message: string) {
  if (source.includes(text)) {
    throw new Error(message);
  }
}

requireText(
  "const allowFullReconcile = String(process.env.ALLOW_FULL_RECONCILE || '').toLowerCase() === 'true';",
  'Broad reconcile must require an explicit script-level ALLOW_FULL_RECONCILE opt-in.',
);
requireText(
  "if (!allowFullReconcile)",
  'runFull must fail closed unless the explicit broad-reconcile opt-in is enabled.',
);
requireText(
  'automatic retry is disabled',
  'Broad reconcile transport failures must declare that automatic mutation retry is disabled.',
);
requireText(
  'Stop and verify persisted/Shopify/Sheet read-back before any manual recovery.',
  'Uncertain mutation outcomes must require read-back before recovery.',
);
requireText(
  "body: { dryRun: false, writeSheet: true, rowNumbers },",
  'The contract must remain anchored to the broad Sheet write mutation path.',
);
forbidText(
  'for (let attempt = 1; attempt <= 2; attempt += 1)',
  'Broad live mutation requests must never be automatically retried.',
);
forbidText(
  'if (attempt < 2) await sleep(5000)',
  'Broad live mutation requests must not sleep and retry after an uncertain outcome.',
);

const runFullStart = source.indexOf('async function runFull(plan)');
const runFullEnd = source.indexOf('\nawait ensureIssue();', runFullStart);
if (runFullStart < 0 || runFullEnd < 0) {
  throw new Error('Unable to isolate runFull for mutation safety validation.');
}
const runFull = source.slice(runFullStart, runFullEnd);
const broadMutationCount = (runFull.match(/writeSheet:\s*true/g) || []).length;
if (broadMutationCount !== 1) {
  throw new Error(`runFull must contain exactly one broad write call site; found ${broadMutationCount}.`);
}

console.log('Sheet 1 live reconcile retry safety contract passed.');
