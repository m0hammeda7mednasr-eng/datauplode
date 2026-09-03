import fs from 'node:fs';

const baseUrl = String(process.env.READINESS_BASE_URL || '').trim();
const expectedRevision = String(process.env.READINESS_EXPECTED_REVISION || '').trim().toLowerCase();
const responsePath = String(process.env.READINESS_RESPONSE_PATH || 'production-readiness.json').trim();

function fail(message) {
  console.error(`[readiness-probe] ${message}`);
  process.exit(2);
}

if (!/^https:\/\//i.test(baseUrl)) {
  fail('READINESS_BASE_URL must be an HTTPS Railway URL.');
}
if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
  fail('READINESS_EXPECTED_REVISION must be a full 40-character Git SHA.');
}
if (!fs.existsSync(responsePath)) {
  fail(`Readiness response file not found: ${responsePath}`);
}

let body;
try {
  body = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
} catch (error) {
  fail(`Readiness response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const actualRevision = String(body?.deployment?.revision || '').trim().toLowerCase();
const configuration = body?.configuration || {};
const jobs = body?.jobs || {};

if (body?.ok !== true) fail('Live /api/ready did not report ok=true.');
if (body?.database?.ok !== true) fail('Database readiness is not healthy.');
if (body?.database?.target !== 'supabase') fail('Production database target is not Supabase.');
if (body?.database?.projectRefPinned !== true) fail('SUPABASE_PROJECT_REF is not pinned in production.');
if (body?.database?.projectRefMatched !== true) fail('Live DATABASE_URL does not match the pinned Supabase project ref.');
if (body?.deployment?.revisionVerified !== true) fail('Railway did not expose a verified full Git revision.');
if (actualRevision !== expectedRevision) {
  fail(`Railway revision ${actualRevision || '<unknown>'} does not match expected ${expectedRevision}.`);
}
if (body?.platform?.productionEnvironment !== true) fail('Target is not reporting NODE_ENV=production.');
if (body?.platform?.writeSafetyReady !== true) fail('Production write-safety readiness is not satisfied.');
if (body?.platform?.ready !== true) fail('Production platform readiness is not satisfied.');

const mustBeFalse = [
  'runtimeWriteGateEnabled',
  'inventoryAutostartConfigured',
  'inventoryAutostartEnabled',
  'jobRecoveryConfigured',
  'jobRecoveryShopifyWritesConfigured',
  'jobRecoveryEnabled',
  'sheetImportAutostartConfigured',
  'sheetImportAutostartEnabled',
  'catalogWriteGateEnabled',
  'catalogSheetWriteGateEnabled',
];
for (const key of mustBeFalse) {
  if (configuration[key] !== false) fail(`configuration.${key} must be false before production dry run.`);
}
if (configuration.catalogAuditDryRunConfigured !== true) {
  fail('CATALOG_AUDIT_DRY_RUN must remain enabled before production dry run.');
}
if (Number(configuration.catalogCanaryMaxRows) !== 1) {
  fail('Catalog canary maximum rows must be exactly 1.');
}

for (const key of ['pending', 'running', 'staleRunning', 'recentFailed']) {
  if (Number(jobs[key]) !== 0) fail(`jobs.${key} must be 0 before production dry run; received ${String(jobs[key])}.`);
}

console.log(JSON.stringify({
  ok: true,
  revision: actualRevision,
  database: {
    target: body.database.target,
    projectRefPinned: body.database.projectRefPinned,
    projectRefMatched: body.database.projectRefMatched,
  },
  platform: {
    productionEnvironment: body.platform.productionEnvironment,
    writeSafetyReady: body.platform.writeSafetyReady,
    ready: body.platform.ready,
  },
  queue: {
    pending: Number(jobs.pending),
    running: Number(jobs.running),
    staleRunning: Number(jobs.staleRunning),
    recentFailed: Number(jobs.recentFailed),
  },
  writesPerformed: 0,
}, null, 2));
