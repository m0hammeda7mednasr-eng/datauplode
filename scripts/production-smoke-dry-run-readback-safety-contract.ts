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
    /"batchId"\\s\*:\\s\*"\(\[\^"\]\+\)"/.test(verifier) || /matchAll\(\/"batchId"/.test(verifier),
  ],
  [
    "read-back requires a full expected Git SHA",
    /\^\[0-9a-f\]\{40\}\$/i.test(verifier),
  ],
  [
    "read-back queries live readiness after the dry run",
    /\/api\/ready/.test(verifier),
  ],
  [
    "read-back rejects a Railway revision change",
    /Railway revision changed during dry run/.test(verifier),
  ],
  [
    "read-back requires Supabase as the live database target",
    /database\.target !== "supabase"/.test(verifier),
  ],
  [
    "read-back requires the persisted readiness batch to equal the smoke batch",
    /persistedBatchId !== dryRunBatchId/.test(verifier),
  ],
  [
    "read-back requires readiness to mark the persisted dry run canary-ready",
    /latestDryRunCanaryReady !== true/.test(verifier),
  ],
  [
    "read-back rejects expired persisted dry runs",
    /latestDryRunExpired !== false/.test(verifier),
  ],
  [
    "read-back requires exactly one verified product and no missing ambiguous or errors",
    /uniqueProductsProcessed\) !== 1/.test(verifier) &&
      /verified\) !== 1/.test(verifier) &&
      /missing\) !== 0/.test(verifier) &&
      /ambiguous\) !== 0/.test(verifier) &&
      /errors\) !== 0/.test(verifier),
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
