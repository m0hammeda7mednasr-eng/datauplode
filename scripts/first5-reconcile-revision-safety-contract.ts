import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const wrapper = fs.readFileSync(path.join(root, 'src/server/oneTimeSheet1Reconcile.ts'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'src/server/sheet1ReconcileRecovery.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'src/server/firstFiveSheetsReconcile.ts'), 'utf8');

function isolatedRailwayGate(source: string) {
  return (
    /NODE_ENV/.test(source) &&
    /RAILWAY_ENVIRONMENT/.test(source) &&
    /RAILWAY_PUBLIC_DOMAIN/.test(source) &&
    /RAILWAY_GIT_BRANCH/.test(source) &&
    /stabilize-supabase-railway/.test(source) &&
    /SYNC_FIRST5_RECONCILE_DISABLED/.test(source)
  );
}

const checks: Array<[string, boolean]> = [
  ['first-five worker is isolated to Railway production branch', isolatedRailwayGate(wrapper)],
  ['deployment takeover uses the same isolated Railway production branch gate', isolatedRailwayGate(recovery)],
  ['worker blocks before startup outside the isolated production gate', /if \(!isolatedFirstFiveWorkerEnabled\(\)\)[\s\S]*return;[\s\S]*startFirstFiveSheetsReconcile\(port\)/.test(wrapper)],
  ['takeover blocks before SyncJob mutation outside the isolated production gate', /if \(!isolatedFirstFiveWorkerEnabled\(\)\)[\s\S]*return;[\s\S]*prisma\.syncJob\.findMany/.test(recovery)],
  ['isolated worker does not depend on the global runtime write gate', !/SYNC_RUNTIME_WRITE_ENABLED/.test(wrapper)],
  ['isolated takeover does not depend on the global runtime write gate', !/SYNC_RUNTIME_WRITE_ENABLED/.test(recovery)],
  ['isolated worker has an emergency kill switch', /!enabled\("SYNC_FIRST5_RECONCILE_DISABLED"\)/.test(wrapper)],
  ['worker only updates existing Shopify products', /No existing ACTIVE Shopify product could be matched safely\. No product was created\./.test(worker)],
  ['worker contains no Shopify product create mutation call', !/ShopifyService\.createProduct\s*\(|\bproductCreate\s*\(/.test(worker)],
  ['worker contains no product rebuild mode', !/rebuildProducts\s*:\s*true/.test(worker)],
  ['worker requires Shopify read-back verification', /Shopify read-back did not match expected price\/SKU\/inventory values/.test(worker)],
  ['worker does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(worker)],
  ['wrapper does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(wrapper)],
  ['recovery does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(recovery)],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);
}

if (failed.length) {
  console.error(`First-five isolated reconcile safety contract failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`First-five isolated reconcile safety contract passed: ${checks.length}/${checks.length} checks.`);
console.log('Shopify mutations executed by this contract: 0');
console.log('Google Sheet writes executed by this contract: 0');
console.log('Database writes executed by this contract: 0');
