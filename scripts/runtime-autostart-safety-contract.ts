import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const queue = fs.readFileSync(path.join(root, 'src/server/services/queue.ts'), 'utf8');
const oneTimeSheetImport = fs.readFileSync(path.join(root, 'src/server/oneTimeSheetImport.ts'), 'utf8');
const firstFiveWrapper = fs.readFileSync(path.join(root, 'src/server/oneTimeSheet1Reconcile.ts'), 'utf8');
const firstFiveRecovery = fs.readFileSync(path.join(root, 'src/server/sheet1ReconcileRecovery.ts'), 'utf8');
const firstFiveWorker = fs.readFileSync(path.join(root, 'src/server/firstFiveSheetsReconcile.ts'), 'utf8');
const railwayEnvExample = fs.readFileSync(path.join(root, '.env.railway.example'), 'utf8');
const productionEnvExample = fs.readFileSync(path.join(root, '.env.production.example'), 'utf8');

function hasClosedGlobalGates(envExample: string): boolean {
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

function startupPrefixBeforeGlobalSafeModeReturn(): string | null {
  const listenIndex = server.indexOf('httpServer.listen(PORT, HOST, () => {');
  if (listenIndex < 0) return null;
  const gateIndex = server.indexOf('if (!runtimeWritesEnabled())', listenIndex);
  if (gateIndex < 0) return null;
  const returnIndex = server.indexOf('return;', gateIndex);
  if (returnIndex < 0) return null;
  return server.slice(listenIndex, returnIndex);
}

const startupPrefix = startupPrefixBeforeGlobalSafeModeReturn();

const checks: Array<[string, boolean]> = [
  ['global runtime write gate defaults closed', /function runtimeWritesEnabled\(\)[\s\S]*SYNC_RUNTIME_WRITE_ENABLED/.test(server)],
  ['pricing-rule seed remains behind global runtime gate', /function pricingRuleSeedEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)[\s\S]*SYNC_PRICING_RULE_SEED_ENABLED/.test(server)],
  ['job recovery remains behind runtime and explicit recovery gates', /function jobRecoveryEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)[\s\S]*jobRecoveryConfigured\(\)[\s\S]*jobRecoveryShopifyWritesEnabled\(\)/.test(server)],
  ['inventory monitor remains behind global runtime gate', /function inventoryAutostartEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)[\s\S]*SYNC_INVENTORY_AUTOSTART/.test(server)],
  ['legacy sheet import remains behind global runtime gate', /function sheetImportAutostartEnabled\(\)[\s\S]*runtimeWritesEnabled\(\)[\s\S]*SYNC_SHEET_IMPORT_AUTOSTART_ENABLED/.test(server)],
  ['global background jobs return before startup in safe mode', /if \(!runtimeWritesEnabled\(\)\)[\s\S]*return;[\s\S]*Runtime sync writes ENABLED/.test(server)],
  ['isolated first-five worker is invoked before global safe-mode return', Boolean(startupPrefix) && startupPrefix!.includes('startOneTimeSheet1Reconcile(PORT)')],
  ['isolated first-five takeover is invoked before global safe-mode return', Boolean(startupPrefix) && startupPrefix!.includes('prepareSheet1ReconcileDeploymentTakeover()')],
  ['isolated first-five wrapper independently restricts Railway production branch', /function isolatedFirstFiveWorkerEnabled\(\)[\s\S]*NODE_ENV[\s\S]*RAILWAY_ENVIRONMENT[\s\S]*RAILWAY_GIT_BRANCH[\s\S]*stabilize-supabase-railway/.test(firstFiveWrapper)],
  ['isolated first-five recovery uses same production branch restriction', /function isolatedFirstFiveWorkerEnabled\(\)[\s\S]*NODE_ENV[\s\S]*RAILWAY_ENVIRONMENT[\s\S]*RAILWAY_GIT_BRANCH[\s\S]*stabilize-supabase-railway/.test(firstFiveRecovery)],
  ['isolated first-five worker has kill switch', /SYNC_FIRST5_RECONCILE_DISABLED/.test(firstFiveWrapper)],
  ['isolated first-five worker does not open global runtime write gate', !/SYNC_RUNTIME_WRITE_ENABLED/.test(firstFiveWrapper)],
  ['isolated first-five recovery does not open global runtime write gate', !/SYNC_RUNTIME_WRITE_ENABLED/.test(firstFiveRecovery)],
  ['isolated worker is existing-products-only', /No existing ACTIVE Shopify product could be matched safely\. No product was created\./.test(firstFiveWorker)],
  ['isolated worker has no Shopify product-create mutation call', !/ShopifyService\.createProduct\s*\(|\bproductCreate\s*\(/.test(firstFiveWorker)],
  ['isolated worker never enables rebuild mode', !/rebuildProducts\s*:\s*true/.test(firstFiveWorker)],
  ['isolated worker requires Shopify read-back verification', /Shopify read-back did not match expected price\/SKU\/inventory values/.test(firstFiveWorker)],
  ['isolated worker only writes inventory for explicit source stock state', /stockStatus === "out_of_stock"[\s\S]*stockStatus === "in_stock"[\s\S]*return null/.test(firstFiveWorker)],
  ['legacy sheet importer independently checks runtime and import gates', /SYNC_RUNTIME_WRITE_ENABLED[\s\S]*SYNC_SHEET_IMPORT_AUTOSTART_ENABLED/.test(oneTimeSheetImport)],
  ['queue recovery includes Shopify-mutating job types and stays gated', /PUBLISH_TO_SHOPIFY[\s\S]*REPUBLISH_TO_SHOPIFY[\s\S]*SYNC_PRODUCT[\s\S]*SYNC_INVENTORY/.test(queue)],
  ['Railway example keeps all global write gates closed', hasClosedGlobalGates(railwayEnvExample)],
  ['production example keeps all global write gates closed', hasClosedGlobalGates(productionEnvExample)],
  ['catalog dry run stays enabled in Railway example', /^CATALOG_AUDIT_DRY_RUN=true$/m.test(railwayEnvExample)],
  ['catalog canary stays one row in Railway example', /^CATALOG_AUDIT_CANARY_MAX_ROWS=1$/m.test(railwayEnvExample)],
  ['403 is not interpreted as stock in first-five worker', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(firstFiveWorker)],
  ['no legacy mutating startup call occurs before global safe-mode return', Boolean(startupPrefix) &&
    !startupPrefix!.includes('seedDefaultPricingRules()') &&
    !startupPrefix!.includes('QueueService.recoverInterruptedJobs()') &&
    !startupPrefix!.includes('QueueService.startInventoryMonitor()') &&
    !startupPrefix!.includes('startOneTimeSheetImport(PORT)')],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);

if (failed.length) {
  console.error(`Runtime autostart safety contract failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`Runtime autostart safety contract passed: ${checks.length}/${checks.length} checks.`);
console.log('Database writes executed by this contract: 0');
console.log('Shopify mutations executed by this contract: 0');
console.log('Google Sheet writes executed by this contract: 0');
