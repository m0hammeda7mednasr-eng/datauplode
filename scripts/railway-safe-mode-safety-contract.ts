import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const preflightPath = 'scripts/railway-safe-mode-preflight.ts';
const railwayConfigPath = 'railway.json';
const preflightSource = readFileSync(preflightPath, 'utf8');
const railwayConfigSource = readFileSync(railwayConfigPath, 'utf8');
const railwayConfig = JSON.parse(railwayConfigSource);

const requiredClosedGates = [
  'SYNC_RUNTIME_WRITE_ENABLED',
  'SYNC_INVENTORY_AUTOSTART',
  'SYNC_JOB_RECOVERY_ENABLED',
  'SYNC_SHEET_IMPORT_AUTOSTART_ENABLED',
  'CATALOG_AUDIT_WRITE_ENABLED',
  'CATALOG_AUDIT_SHEET_WRITE_ENABLED',
] as const;

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`Railway safe-mode contract failed: ${message}`);
}

function runPreflight(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    CATALOG_AUDIT_DRY_RUN: 'true',
    CATALOG_AUDIT_CANARY_MAX_ROWS: '1',
  };

  for (const gate of requiredClosedGates) env[gate] = 'false';
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return spawnSync(process.execPath, ['--import', 'tsx', preflightPath], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

const preDeployCommand = String(railwayConfig?.deploy?.preDeployCommand || '');
assert(
  preDeployCommand.startsWith('NODE_ENV=production npx tsx scripts/railway-safe-mode-preflight.ts &&'),
  'Railway must execute the production safe-mode preflight before any database deployment command',
);
assert(
  preDeployCommand.includes('npm run db:deploy:verified'),
  'Railway must retain verified Prisma deployment after the safe-mode preflight',
);
assert(railwayConfig?.deploy?.healthcheckPath === '/api/ready', 'Railway healthcheck must use /api/ready');
assert(
  railwayConfig?.deploy?.restartPolicyType === 'ON_FAILURE',
  'Railway restart policy must not restart successful processes indefinitely',
);
assert(
  Number(railwayConfig?.deploy?.restartPolicyMaxRetries) <= 10,
  'Railway restart retries must stay bounded at 10 or fewer',
);

for (const gate of requiredClosedGates) {
  assert(preflightSource.includes(`'${gate}'`), `preflight must require ${gate}`);
}
assert(preflightSource.includes("canaryMaxRows !== 1"), 'canary must remain limited to exactly one row');
assert(preflightSource.includes('CATALOG_AUDIT_DRY_RUN'), 'catalog audit dry-run must be mandatory');
assert(preflightSource.includes('shopifyMutationsPerformed: 0'), 'preflight report must declare zero Shopify mutations');
assert(preflightSource.includes('googleSheetWritesPerformed: 0'), 'preflight report must declare zero Google Sheet writes');

const safe = runPreflight({});
assert(safe.status === 0, `fully closed safe mode must pass; stderr=${safe.stderr.trim()}`);

for (const gate of requiredClosedGates) {
  const missing = runPreflight({ [gate]: undefined });
  assert(missing.status !== 0, `missing ${gate} must block deployment`);

  const open = runPreflight({ [gate]: 'true' });
  assert(open.status !== 0, `open ${gate} must block deployment`);
}

const invalidGate = runPreflight({ SYNC_RUNTIME_WRITE_ENABLED: 'maybe' });
assert(invalidGate.status !== 0, 'unknown write-gate values must block deployment');

const dryRunOff = runPreflight({ CATALOG_AUDIT_DRY_RUN: 'false' });
assert(dryRunOff.status !== 0, 'disabled catalog dry-run must block deployment');

const canaryTooWide = runPreflight({ CATALOG_AUDIT_CANARY_MAX_ROWS: '2' });
assert(canaryTooWide.status !== 0, 'canary wider than one row must block deployment');

const nonProduction = spawnSync(process.execPath, ['--import', 'tsx', preflightPath], {
  env: { ...process.env, NODE_ENV: 'development' },
  encoding: 'utf8',
  timeout: 15_000,
});
assert(nonProduction.status === 0, 'non-production local development must remain unblocked');

console.log(JSON.stringify({
  ok: true,
  assertions,
  testedClosedGates: requiredClosedGates.length,
  safeModePassCases: 1,
  blockedDeploymentCases: requiredClosedGates.length * 2 + 3,
  shopifyMutationsPerformed: 0,
  googleSheetWritesPerformed: 0,
}, null, 2));
