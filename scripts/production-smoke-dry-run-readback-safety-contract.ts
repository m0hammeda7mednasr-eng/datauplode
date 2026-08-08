import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/production-smoke.yml", "utf8");
const verifier = readFileSync("scripts/production-smoke-dry-run-readback.ts", "utf8");

const assertions: Array<[string, boolean]> = [
  [
    "production smoke captures its output for persisted-batch verification",
    /npm run smoke:production 2>&1 \| tee production-smoke\.log/.test(workflow),
  ],
  [
    "production smoke runs the dry-run persistence read-back verifier",
    /production-smoke-dry-run-readback\.ts production-smoke\.log/.test(workflow),
  ],
  [
    "read-back extracts the exact dry-run batch ID emitted by smoke",
    verifier.includes('matchAll(/"batchId"\\s*:\\s*"([^\"]+)"/g)'),
  ],
  [
    "read-back requires a full expected Git SHA",
    verifier.includes('/^[0-9a-f]{40}$/i.test(expectedRevision)'),
  ],
  [
    "read-back queries live readiness after the dry run",
    verifier.includes('/api/ready'),
  ],
  [
    "read-back rejects a Railway revision change",
    verifier.includes('Railway revision changed during dry run'),
  ],
  [
    "read-back requires Supabase as the live database target",
    verifier.includes('database.target !== "supabase"'),
  ],
  [
    "read-back requires the persisted readiness batch to equal the smoke batch",
    verifier.includes('persistedBatchId !== dryRunBatchId'),
  ],
  [
    "read-back requires readiness to mark the persisted dry run canary-ready",
    verifier.includes('rollout.latestDryRunCanaryReady !== true'),
  ],
  [
    "read-back rejects expired persisted dry runs",
    verifier.includes('rollout.latestDryRunExpired !== false'),
  ],
  [
    "read-back requires exactly one verified product and no missing ambiguous or errors",
    verifier.includes('Number(latestDryRun.uniqueProductsProcessed) !== 1') &&
      verifier.includes('Number(latestDryRun.verified) !== 1') &&
      verifier.includes('Number(latestDryRun.missing) !== 0') &&
      verifier.includes('Number(latestDryRun.ambiguous) !== 0') &&
      verifier.includes('Number(latestDryRun.errors) !== 0'),
  ],
  [
    "read-back performs no Shopify or Sheet mutation",
    !/updateVariantsBulk|productVariantsBulkUpdate|writeSheet\s*:\s*true|CATALOG_AUDIT_WRITE_TOKEN/.test(verifier),
  ],
];

const failed = assertions.filter(([, ok]) => !ok);
for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

if (failed.length > 0) {
  console.error(`Production dry-run read-back safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Production dry-run read-back safety contract passed: ${assertions.length}/${assertions.length}`);
