import fs from "node:fs";

const queueGuard = fs.readFileSync("src/server/services/catalogCanaryQueueGuard.ts", "utf8");
const mutationGuard = fs.readFileSync("src/server/services/catalogCanaryMutationGuard.ts", "utf8");

const checks: Array<[string, boolean]> = [
  [
    "queue guard counts pending jobs",
    queueGuard.includes('status: "pending"') && queueGuard.includes("pending"),
  ],
  [
    "queue guard counts running jobs",
    queueGuard.includes('status: "running"') && queueGuard.includes("running"),
  ],
  [
    "queue guard counts stale running jobs with bounded threshold",
    queueGuard.includes("SYNC_JOB_STALE_RUNNING_MINUTES") &&
      queueGuard.includes("staleRunning") &&
      queueGuard.includes("startedAt: { lt: staleCutoff }"),
  ],
  [
    "queue guard counts recent failed jobs with bounded threshold",
    queueGuard.includes("SYNC_JOB_RECENT_FAILURE_MINUTES") &&
      queueGuard.includes("recentFailed") &&
      queueGuard.includes('status: "failed"'),
  ],
  [
    "queue quiescence requires all four risk counters to be zero",
    queueGuard.includes("state.pending === 0") &&
      queueGuard.includes("state.running === 0") &&
      queueGuard.includes("state.staleRunning === 0") &&
      queueGuard.includes("state.recentFailed === 0"),
  ],
  [
    "mutation guard rechecks queue immediately before Shopify bulk mutation",
    mutationGuard.includes("await verifyCatalogCanaryQueueQuiescence()") &&
      mutationGuard.indexOf("await verifyCatalogCanaryQueueQuiescence()") <
        mutationGuard.indexOf("return originalUpdateVariantsBulk"),
  ],
  [
    "mutation guard fails closed when queue verification is unavailable",
    mutationGuard.includes("CATALOG_AUDIT_CANARY_QUEUE_CHECK_UNAVAILABLE") &&
      mutationGuard.includes("no write was attempted") &&
      mutationGuard.includes("statusCode: 503"),
  ],
  [
    "mutation guard blocks non-quiescent queue before write",
    mutationGuard.includes("CATALOG_AUDIT_CANARY_QUEUE_NOT_QUIESCENT") &&
      mutationGuard.includes("catalogCanaryQueueIsQuiescent(queueState)") &&
      mutationGuard.includes("statusCode: 409"),
  ],
  [
    "queue check remains scoped to canary mutation context",
    mutationGuard.includes("const context = canaryMutationContext.getStore()") &&
      mutationGuard.includes("if (context)"),
  ],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
if (failed.length) {
  console.error(`Catalog canary queue mutation safety contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Catalog canary queue mutation safety contract passed: ${checks.length}/${checks.length}`);
