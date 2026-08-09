import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const preflightPath = 'scripts/railway-safe-mode-preflight.ts';
const databaseTargetPreflightPath = 'scripts/railway-database-target-preflight.ts';
const railwayConfigPath = 'railway.json';
const runtimeDbPath = 'src/server/db.ts';
const packagePath = 'package.json';

const preflightSource = readFileSync(preflightPath, 'utf8');
const databaseTargetPreflightSource = readFileSync(databaseTargetPreflightPath, 'utf8');
const railwayConfig = JSON.parse(readFileSync(railwayConfigPath, 'utf8'));
const runtimeDbSource = readFileSync(runtimeDbPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

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

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    SUPABASE_PROJECT_REF: 'project',
    DATABASE_URL: validSupabaseUrl,
    CATALOG_AUDIT_DRY_RUN: 'true',
    CATALOG_AUDIT_CANARY_MAX_ROWS: '1',
  };
  for (const gate of requiredClosedGates) env[gate] = 'false';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(path: string, overrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', path], {
    env: productionEnv(overrides),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

const preDeployCommand = String(railwayConfig?.deploy?.preDeployCommand || '');
const targetCheck = preDeployCommand.indexOf(
  'NODE_ENV=production npx tsx scripts/railway-database-target-preflight.ts',
);
const safeMode = preDeployCommand.indexOf(
  'NODE_ENV=production npx tsx scripts/railway-safe-mode-preflight.ts',
);
const dbDeploy = preDeployCommand.indexOf('npm run db:deploy');
const dbVerify = preDeployCommand.indexOf('NODE_ENV=production npm run db:preflight');
const runtimeStartCommand = String(railwayConfig?.deploy?.startCommand || '');
const railwayDeployScript = String(packageJson?.scripts?.['railway:deploy'] || '');

assert(
  targetCheck >= 0 && safeMode > targetCheck && dbDeploy > safeMode && dbVerify > dbDeploy,
  'Railway pre-deploy must validate the exact database target and safe mode before Prisma schema writes, then verify schema',
);
assert(
  runtimeStartCommand === 'npm run railway:deploy',
  'Railway runtime must use the controlled bootstrap script',
);
assert(
  railwayDeployScript === 'NODE_ENV=production npm start',
  'Runtime bootstrap must start Express immediately because database and safety checks already completed in pre-deploy',
);
assert(
  railwayConfig?.deploy?.healthcheckPath === '/',
  'Railway healthcheck must be a process/network liveness check independent of database readiness',
);
assert(
  railwayConfig?.deploy?.restartPolicyType === 'ON_FAILURE',
  'Railway restart policy must remain ON_FAILURE',
);
assert(
  Number(railwayConfig?.deploy?.restartPolicyMaxRetries) <= 10,
  'Railway restart retries must stay bounded',
);

for (const gate of requiredClosedGates) {
  assert(preflightSource.includes(`'${gate}'`), `preflight must require ${gate}`);
}
assert(preflightSource.includes('CATALOG_AUDIT_DRY_RUN'), 'dry run must remain mandatory');
assert(preflightSource.includes('canaryMaxRows !== 1'), 'canary must remain exactly one row');
assert(preflightSource.includes('SUPABASE_PROJECT_REF'), 'Supabase project pin must remain mandatory');
assert(preflightSource.includes('deriveSupabaseProjectRef'), 'Supabase project identity must be derived from DATABASE_URL');
assert(preflightSource.includes("port !== '5432'"), 'Session pooler must remain port 5432');
assert(preflightSource.includes("sslMode !== 'require'"), 'Supabase TLS must remain mandatory');
assert(preflightSource.includes('connectionLimit < 1 || connectionLimit > 20'), 'connection_limit must remain bounded');
assert(preflightSource.includes('poolTimeout < 1 || poolTimeout > 60'), 'pool_timeout must remain bounded');
assert(preflightSource.includes('shopifyMutationsPerformed: 0'), 'preflight must perform zero Shopify mutations');
assert(preflightSource.includes('googleSheetWritesPerformed: 0'), 'preflight must perform zero Google Sheet writes');

assert(!/url\.port\s*=\s*['"]6543['"]/.test(runtimeDbSource), 'runtime must never rewrite Supabase to port 6543');
assert(!/searchParams\.set\(['"]pgbouncer['"]/.test(runtimeDbSource), 'runtime must never add pgbouncer=true');

assert(databaseTargetPreflightSource.includes('SUPABASE_PROJECT_REF'), 'database target validator must pin project ref');
assert(databaseTargetPreflightSource.includes("port !== '5432'"), 'database target validator must reject 6543');
assert(databaseTargetPreflightSource.includes("sslMode !== 'require'"), 'database target validator must require TLS');

const safe = run(preflightPath);
assert(safe.status === 0, `fully closed production safe mode must pass; stderr=${safe.stderr.trim()}`);

for (const gate of requiredClosedGates) {
  assert(run(preflightPath, { [gate]: undefined }).status !== 0, `missing ${gate} must block deployment`);
  assert(run(preflightPath, { [gate]: 'true' }).status !== 0, `open ${gate} must block deployment`);
}

assert(run(preflightPath, { CATALOG_AUDIT_DRY_RUN: 'false' }).status !== 0, 'disabled dry run must block deployment');
assert(run(preflightPath, { CATALOG_AUDIT_CANARY_MAX_ROWS: '2' }).status !== 0, 'wide canary must block deployment');
assert(run(preflightPath, { SUPABASE_PROJECT_REF: 'different-project' }).status !== 0, 'wrong Supabase project must block deployment');
assert(
  run(preflightPath, {
    DATABASE_URL:
      'postgresql://prisma.project:password@region.pooler.supabase.com:6543/postgres?sslmode=require&connection_limit=10&pool_timeout=20',
  }).status !== 0,
  'transaction pooler must block deployment',
);
assert(
  run(databaseTargetPreflightPath, { SUPABASE_PROJECT_REF: 'different-project' }).status !== 0,
  'read-only target validator must reject wrong project',
);

console.log(
  JSON.stringify(
    {
      ok: true,
      assertions,
      preDeployOwnsDatabaseValidation: true,
      runtimeStartsImmediately: true,
      livenessIndependentOfDatabase: true,
      runtimeSessionPoolerPreserved: true,
      requiredClosedGates: requiredClosedGates.length,
      shopifyMutationsPerformed: 0,
      googleSheetWritesPerformed: 0,
    },
    null,
    2,
  ),
);
