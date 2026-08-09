import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const wrapper = fs.readFileSync(path.join(root, 'src/server/oneTimeSheet1Reconcile.ts'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'src/server/sheet1ReconcileRecovery.ts'), 'utf8');
const railwayEnv = fs.readFileSync(path.join(root, '.env.railway.example'), 'utf8');
const productionEnv = fs.readFileSync(path.join(root, '.env.production.example'), 'utf8');

function exactRevisionGate(source: string) {
  return (
    /SYNC_RUNTIME_WRITE_ENABLED/.test(source) &&
    /SYNC_FIRST5_RECONCILE_ENABLED/.test(source) &&
    /SYNC_FIRST5_RECONCILE_REVISION/.test(source) &&
    /RAILWAY_GIT_COMMIT_SHA/.test(source) &&
    /\^\[0-9a-f\]\{40\}\$/.test(source) &&
    /deployed === authorized/.test(source)
  );
}

const checks: Array<[string, boolean]> = [
  ['first-five worker requires exact deployed revision authorization', exactRevisionGate(wrapper)],
  ['deployment takeover requires exact deployed revision authorization', exactRevisionGate(recovery)],
  ['worker blocks before start when exact revision authorization is absent or mismatched', /if \(!firstFiveReconcileWritesEnabled\(\)\)[\s\S]*return;[\s\S]*startFirstFiveSheetsReconcile\(port\)/.test(wrapper)],
  ['takeover blocks before SyncJob reads and writes when exact revision authorization is absent or mismatched', /if \(!firstFiveReconcileWritesEnabled\(\)\)[\s\S]*return;[\s\S]*prisma\.syncJob\.findMany/.test(recovery)],
  ['Railway template leaves broad reconcile gate closed', /^SYNC_FIRST5_RECONCILE_ENABLED=false$/m.test(railwayEnv)],
  ['Railway template leaves revision authorization blank', /^SYNC_FIRST5_RECONCILE_REVISION=$/m.test(railwayEnv)],
  ['production template leaves broad reconcile gate closed', /^SYNC_FIRST5_RECONCILE_ENABLED=false$/m.test(productionEnv)],
  ['production template leaves revision authorization blank', /^SYNC_FIRST5_RECONCILE_REVISION=$/m.test(productionEnv)],
  ['worker does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(wrapper)],
  ['recovery does not classify 403 as stock', !/403[^\n]{0,120}(out.?of.?stock|stockStatus)/i.test(recovery)],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}: ${name}`);
}

if (failed.length) {
  console.error(`First-five reconcile revision safety contract failed: ${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`First-five reconcile revision safety contract passed: ${checks.length}/${checks.length} checks.`);
console.log('Shopify mutations executed by this contract: 0');
console.log('Google Sheet writes executed by this contract: 0');
console.log('Database writes executed by this contract: 0');
