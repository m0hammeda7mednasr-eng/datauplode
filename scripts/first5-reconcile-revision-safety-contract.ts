import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const wrapper = fs.readFileSync(path.join(root, 'src/server/oneTimeSheet1Reconcile.ts'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'src/server/sheet1ReconcileRecovery.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'src/server/firstFiveSheetsReconcile.ts'), 'utf8');
const railwayEnv = fs.readFileSync(path.join(root, '.env.railway.example'), 'utf8');
const productionEnv = fs.readFileSync(path.join(root, '.env.production.example'), 'utf8');

function isolatedRailwayGate(source: string) {
  return (
    /NODE_ENV/.test(source) &&
    /RAILWAY_ENVIRONMENT/.test(source) &&
    /RAILWAY_PUBLIC_DOMAIN/.test(source) &&
    /RAILWAY_GIT_BRANCH/.test(source) &&
    /stabilize-supabase-railway/.test(source) &&
    /SYNC_RUNTIME_WRITE_ENABLED/.test(source) &&
    /SYNC_FIRST5_RECONCILE_ENABLED/.test(source) &&
    /SYNC_FIRST5_RECONCILE_REVISION/.test(source) &&
    /SYNC_FIRST5_RECONCILE_DISABLED/.test(source)
  );
}

function exactRevisionGate(source: string) {
  return (
    /RAILWAY_GIT_COMMIT_SHA/.test(source) &&
    /SOURCE_VERSION/.test(source) &&
    /GIT_COMMIT_SHA/.test(source) &&
    /\^\[0-9a-f\]\{40\}\$/.test(source) &&
    /revision === authorizedRevision/.test(source)
  );
}

const checks: Array<[string, boolean]> = [
  ['first-five worker is isolated to Railway production branch and explicit write gates', isolatedRailwayGate(wrapper)],
  ['deployment takeover uses the same isolated Railway production write gates', isolatedRailwayGate(recovery)],
  ['first-five worker requires exact 40-character deployed revision authorization', exactRevisionGate(wrapper)],
  ['deployment takeover requires exact 40-character deployed revision authorization', exactRevisionGate(recovery)],
  ['worker blocks before startup when any authorization gate is closed', /if \(!isolatedFirstFiveWorkerEnabled\(\)\)[\s\S]*return;[\s\S]*startFirstFiveSheetsReconcile\(port\)/.test(wrapper)],
  ['takeover blocks before SyncJob access when any authorization gate is closed', /if \(!isolatedFirstFiveWorkerEnabled\(\)\)[\s\S]*return;[\s\S]*prisma\.syncJob\.findMany/.test(recovery)],
  ['worker explicitly requires global runtime write authorization', /enabled\("SYNC_RUNTIME_WRITE_ENABLED"\)/.test(wrapper)],
  ['takeover explicitly requires global runtime write authorization', /enabled\("SYNC_RUNTIME_WRITE_ENABLED"\)/.test(recovery)],
  ['worker explicitly requires dedicated first-five authorization', /enabled\("SYNC_FIRST5_RECONCILE_ENABLED"\)/.test(wrapper)],
  ['takeover explicitly requires dedicated first-five authorization', /enabled\("SYNC_FIRST5_RECONCILE_ENABLED"\)/.test(recovery)],
  ['isolated worker retains an emergency kill switch', /!enabled\("SYNC_FIRST5_RECONCILE_DISABLED"\)/.test(wrapper)],
  ['Railway template keeps dedicated first-five write gate closed', /^SYNC_FIRST5_RECONCILE_ENABLED=false$/m.test(railwayEnv)],
  ['Railway template keeps first-five revision authorization blank', /^SYNC_FIRST5_RECONCILE_REVISION=$/m.test(railwayEnv)],
  ['production template keeps dedicated first-five write gate closed', /^SYNC_FIRST5_RECONCILE_ENABLED=false$/m.test(productionEnv)],
  ['production template keeps first-five revision authorization blank', /^SYNC_FIRST5_RECONCILE_REVISION=$/m.test(productionEnv)],
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