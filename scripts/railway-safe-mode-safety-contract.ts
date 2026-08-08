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

const validSupabaseUrl =
  'postgresql://prisma.project:password@region.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20';

let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`Railway safe-mode contract failed: ${message}`);
}

function runPreflight(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    SUPABASE_PROJECT_REF: 'project',
    DATABASE_URL: validSupabaseUrl,
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
assert(preflightSource.includes("endsWith('.supabase.com')"), 'Supabase .com host suffix must be allowlisted');
assert(preflightSource.includes("endsWith('.supabase.co')"), 'Supabase .co host suffix must be allowlisted');
assert(!preflightSource.includes("host.includes('supabase')"), 'substring-only Supabase hostname checks must remain forbidden');
assert(preflightSource.includes('SUPABASE_PROJECT_REF'), 'dedicated Supabase project pin must be mandatory before deployment');
assert(preflightSource.includes('deriveSupabaseProjectRef'), 'preflight must derive project identity from DATABASE_URL');
assert(preflightSource.includes('projectRef !== expectedProjectRef'), 'DATABASE_URL project identity must exactly match the configured project pin');
assert(preflightSource.includes("port !== '5432'"), 'Supabase Session pooler must use port 5432');
assert(preflightSource.includes("sslMode !== 'require'"), 'Supabase database URL must require TLS');
assert(preflightSource.includes('connectionLimit < 1 || connectionLimit > 20'), 'connection_limit must remain bounded');
assert(preflightSource.includes('poolTimeout < 1 || poolTimeout > 60'), 'pool_timeout must remain bounded');
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

const missingProjectPin = runPreflight({ SUPABASE_PROJECT_REF: undefined });
assert(missingProjectPin.status !== 0, 'missing SUPABASE_PROJECT_REF must block deployment before schema changes');

const wrongProjectPin = runPreflight({ SUPABASE_PROJECT_REF: 'different-project' });
assert(wrongProjectPin.status !== 0, 'mismatched Supabase project pin must block deployment before schema changes');

const directHostCorrectProject = runPreflight({
  SUPABASE_PROJECT_REF: 'project',
  DATABASE_URL: 'postgresql://postgres:password@db.project.supabase.co:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
});
assert(directHostCorrectProject.status === 0, 'direct Supabase host must support exact project-ref verification');

const directHostWrongProject = runPreflight({
  SUPABASE_PROJECT_REF: 'project',
  DATABASE_URL: 'postgresql://postgres:password@db.other.supabase.co:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
});
assert(directHostWrongProject.status !== 0, 'direct Supabase host for another project must block deployment');

const missingDatabase = runPreflight({ DATABASE_URL: undefined });
assert(missingDatabase.status !== 0, 'missing DATABASE_URL must block deployment');

const nonSupabase = runPreflight({
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
});
assert(nonSupabase.status !== 0, 'non-Supabase production database must block deployment');

const spoofedSupabaseSubstring = runPreflight({
  DATABASE_URL: 'postgresql://user:pass@supabase.attacker.example.com:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
});
assert(spoofedSupabaseSubstring.status !== 0, 'hostname containing supabase outside an official suffix must block deployment');

const transactionPooler = runPreflight({
  DATABASE_URL: 'postgresql://prisma.project:password@region.pooler.supabase.com:6543/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
});
assert(transactionPooler.status !== 0, 'Supabase transaction pooler port 6543 must block deployment');

const missingTls = runPreflight({
  DATABASE_URL: 'postgresql://prisma.project:password@region.pooler.supabase.com:5432/postgres?connection_limit=10&pool_timeout=20',
});
assert(missingTls.status !== 0, 'Supabase database without sslmode=require must block deployment');

const unsafeConnectionLimit = runPreflight({
  DATABASE_URL: 'postgresql://prisma.project:password@region.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=50&pool_timeout=20',
});
assert(unsafeConnectionLimit.status !== 0, 'unsafe Supabase connection_limit must block deployment');

const unsafePoolTimeout = runPreflight({
  DATABASE_URL: 'postgresql://prisma.project:password@region.pooler.supabase.com:5432/postgres?sslmode=require&connection_limit=10&pool_timeout=120',
});
assert(unsafePoolTimeout.status !== 0, 'unsafe Supabase pool_timeout must block deployment');

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
  safeModePassCases: 2,
  blockedDeploymentCases: requiredClosedGates.length * 2 + 13,
  supabaseDeploymentGuards: 11,
  preSchemaProjectPinVerified: true,
  shopifyMutationsPerformed: 0,
  googleSheetWritesPerformed: 0,
}, null, 2));
