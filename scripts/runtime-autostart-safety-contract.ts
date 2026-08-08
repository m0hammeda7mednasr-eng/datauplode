import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const serverPath = path.join(root, 'server.ts');
const queuePath = path.join(root, 'src/server/services/queue.ts');
const railwayEnvExamplePath = path.join(root, '.env.railway.example');
const productionEnvExamplePath = path.join(root, '.env.production.example');

const server = fs.readFileSync(serverPath, 'utf8');
const queue = fs.readFileSync(queuePath, 'utf8');
const railwayEnvExample = fs.readFileSync(railwayEnvExamplePath, 'utf8');
const productionEnvExample = fs.readFileSync(productionEnvExamplePath, 'utf8');

function hasClosedProductionGates(envExample: string): boolean {
  return [
    'SYNC_RUNTIME_WRITE_ENABLED=false',
    'SYNC_PRICING_RULE_SEED_ENABLED=false',
    'SYNC_INVENTORY_AUTOSTART=false',
    'SYNC_JOB_RECOVERY_ENABLED=false',
    'SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false',
    'SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false',
    'CATALOG_AUDIT_WRITE_ENABLED=false',
    'CATALOG_AUDIT_SHEET_WRITE_ENABLED=false',
  ].every(line => envExample.split(/\r?\n/).includes(line));
}

function startupPrefixBeforeSafeModeReturn(): string | null {
  const listenIndex = server.indexOf('httpServer.listen(PORT, HOST, () => {');
  if (listenIndex < 0) return null;

  const gateIndex = server.indexOf('if (!runtimeWritesEnabled())', listenIndex);
  if (gateIndex < 0) return null;

  const returnIndex = server.indexOf('return;', gateIndex);
  if (returnIndex < 0) return null;

  return server.slice(listenIndex, returnIndex);
}

const startupPrefix = startupPrefixBeforeSafeModeReturn();

const checks: Array<[string, boolean]> = [
  ['runtime write gate defaults closed', /function runtimeWritesEnabled\(\)[\s\S]*envFlag\("SYNC_RUNTIME_WRITE_ENABLED"\)/.test(server)],
  ['pricing-rule seed requires runtime write gate', /function pricingRuleSeedEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_PRICING_RULE_SEED_ENABLED"\)/.test(server)],
  ['job recovery configured flag is explicit', /function jobRecoveryConfigured\(\)[\s\S]*envFlag\("SYNC_JOB_RECOVERY_ENABLED"\)/.test(server)],
  ['job recovery Shopify-write flag is explicit', /function jobRecoveryShopifyWritesEnabled\(\)[\s\S]*envFlag\("SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED"\)/.test(server)],
  ['job recovery requires runtime, recovery, and Shopify-write gates', /function jobRecoveryEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)[\s\S]*jobRecoveryConfigured\(\)[\s\S]*jobRecoveryShopifyWritesEnabled\(\)/.test(server)],
  ['inventory autostart requires runtime write gate', /function inventoryAutostartEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_INVENTORY_AUTOSTART"\)/.test(server)],
  ['sheet import autostart requires runtime write gate', /function sheetImportAutostartEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_SHEET_IMPORT_AUTOSTART_ENABLED"\)/.test(server)],
  ['server returns before background jobs in safe mode', /if \(!runtimeWritesEnabled\(\)[\s\S]*return;[\s\S]*Runtime sync writes ENABLED/.test(server)],
  ['pricing-rule seed call is guarded', /if \(pricingRuleSeedEnabled\(\)[\s\S]*seedDefaultPricingRules\(\)/.test(server)],
  ['recovery call is guarded by composite recovery gate', /if \(jobRecoveryEnabled\(\)[\s\S]*QueueService\.recoverInterruptedJobs\(\)/.test(server)],
  ['recovery has explicit blocked path for Shopify write gate', /Interrupted-job recovery blocked: SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false/.test(server)],
  ['inventory monitor call is guarded', /if \(inventoryAutostartEnabled\(\)[\s\S]*QueueService\.startInventoryMonitor\(\)/.test(server)],
  ['sheet import call is guarded', /if \(sheetImportAutostartEnabled\(\)[\s\S]*startOneTimeSheetImport\(PORT\)/.test(server)],
  ['all write gates are closed in Railway example', hasClosedProductionGates(railwayEnvExample)],
  ['Railway recovery Shopify-write gate defaults closed', /^SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false$/m.test(railwayEnvExample)],
  ['catalog dry run remains enabled in Railway example', /^CATALOG_AUDIT_DRY_RUN=true$/m.test(railwayEnvExample)],
  ['canary remains limited to one row in Railway example', /^CATALOG_AUDIT_CANARY_MAX_ROWS=1$/m.test(railwayEnvExample)],
  ['all write gates are closed in production example', hasClosedProductionGates(productionEnvExample)],
  ['production recovery Shopify-write gate defaults closed', /^SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED=false$/m.test(productionEnvExample)],
  ['production example uses Supabase session pooler port 5432', /^DATABASE_URL=.*pooler\.supabase\.com:5432\//m.test(productionEnvExample)],
  ['production example requires sslmode=require', /^DATABASE_URL=.*[?&]sslmode=require(?:&|$)/m.test(productionEnvExample)],
  ['production example does not use transaction pooler port 6543', !/^DATABASE_URL=.*:6543\//m.test(productionEnvExample)],
  ['catalog dry run remains enabled in production example', /^CATALOG_AUDIT_DRY_RUN=true$/m.test(productionEnvExample)],
  ['canary remains limited to one row in production example', /^CATALOG_AUDIT_CANARY_MAX_ROWS=1$/m.test(productionEnvExample)],
  ['queue recovery includes Shopify-mutating job types that justify the second gate', /const recoverableTypes = \[[\s\S]*'PUBLISH_TO_SHOPIFY'[\s\S]*'REPUBLISH_TO_SHOPIFY'[\s\S]*'SYNC_PRODUCT'[\s\S]*'SYNC_INVENTORY'/.test(queue)],
  ['queue recovery does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(queue)],
  ['queue inventory monitor has an explicit disable path', /SYNC_INVENTORY_AUTOSTART === 'false'/.test(queue)],
  ['safe-mode message requires dry run, canary, and read-back', /only after live dry run, canary, and read-back succeed/i.test(server)],
  ['startup safe-mode scope is discoverable', startupPrefix !== null],
  ['no startup write call occurs before the safe-mode return', Boolean(startupPrefix) &&
    !startupPrefix!.includes('seedDefaultPricingRules()') &&
    !startupPrefix!.includes('QueueService.recoverInterruptedJobs()') &&
    !startupPrefix!.includes('QueueService.startInventoryMonitor()') &&
    !startupPrefix!.includes('startOneTimeSheetImport(PORT)')],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);
}

if (failed.length > 0) {
  console.error(`Runtime autostart safety contract failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`Runtime autostart safety contract passed: ${checks.length}/${checks.length} checks.`);
console.log('Database writes executed by this contract: 0');
console.log('Shopify mutations executed by this contract: 0');
console.log('Google Sheet writes executed by this contract: 0');
