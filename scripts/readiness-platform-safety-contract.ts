import fs from "node:fs";
import path from "node:path";

const readinessPath = path.resolve("src/server/routes/readiness.routes.ts");
const source = fs.readFileSync(readinessPath, "utf8");

const checks: Array<[string, boolean]> = [
  [
    "production readiness requires Supabase target",
    source.includes('databaseTargetValue === "supabase"'),
  ],
  [
    "production readiness requires pinned Supabase project ref",
    source.includes("databaseBindingValue.projectRefPinned === true"),
  ],
  [
    "production readiness requires DATABASE_URL to match pinned Supabase project ref",
    source.includes("databaseBindingValue.projectRefMatched === true"),
  ],
  [
    "runtime readiness derives direct Supabase project ref",
    source.includes('host.match(/^db\\.([a-z0-9-]+)\\.supabase\\.(?:co|com)$/)'),
  ],
  [
    "runtime readiness derives Session pooler project ref from username",
    source.includes('/\\.pooler\\.supabase\\.(?:co|com)$/.test(host)') &&
      source.includes('const separator = username.lastIndexOf(".")'),
  ],
  [
    "readiness reports project pin state without exposing the project ref value",
    source.includes("projectRefPinned: databaseBindingValue.projectRefPinned") &&
      source.includes("projectRefMatched: databaseBindingValue.projectRefMatched") &&
      !source.includes("projectRef: expectedProjectRef"),
  ],
  [
    "failure readiness preserves Supabase project binding diagnostics",
    source.split("projectRefPinned: databaseBindingValue.projectRefPinned").length - 1 >= 2 &&
      source.split("projectRefMatched: databaseBindingValue.projectRefMatched").length - 1 >= 2,
  ],
  [
    "production readiness requires a verified deployment revision",
    source.includes("deployment.revisionVerified === true"),
  ],
  [
    "platform readiness participates in productionMinimumReady",
    /productionMinimumReady\s*=([\s\S]*?)productionPlatformReady/.test(source),
  ],
  [
    "non-production remains usable without Railway/Supabase enforcement",
    source.includes("!productionEnvironment ||"),
  ],
  [
    "readiness reports production environment state",
    source.includes("productionEnvironment,"),
  ],
  [
    "readiness reports whether Supabase is required",
    source.includes("supabaseRequired: productionEnvironment"),
  ],
  [
    "readiness reports whether exact Supabase project pin is required",
    source.includes("supabaseProjectPinRequired: productionEnvironment"),
  ],
  [
    "readiness reports whether Railway revision is required",
    source.includes("railwayRevisionRequired: productionEnvironment"),
  ],
  [
    "readiness reports platform ready state",
    source.includes("ready: productionPlatformReady && (!productionEnvironment || phaseWriteSafetyReady)"),
  ],
  [
    "database binding is computed once for consistent reporting",
    source.includes("const databaseBindingValue = databaseBinding();") &&
      source.includes("const databaseTargetValue = databaseBindingValue.target;"),
  ],
  [
    "database target report uses the checked value",
    source.includes("target: databaseTargetValue"),
  ],
  [
    "failure responses never claim platform readiness",
    source.includes("ready: false"),
  ],
  [
    "deployment revision requires a full 40-character Git SHA",
    source.includes("revisionVerified: /^[0-9a-f]{40}$/i.test(revision)"),
  ],
  [
    "short Git SHA readiness remains forbidden",
    !source.includes("revisionVerified: /^[0-9a-f]{7,40}$/i.test(revision)"),
  ],
  [
    "readiness reports the hard one-product canary limit",
    source.includes("catalogCanaryMaxRows: 1"),
  ],
  [
    "readiness does not advertise a configurable wider canary",
    !source.includes("process.env.CATALOG_AUDIT_CANARY_MAX_ROWS || 1"),
  ],
  [
    "readiness only trusts official Supabase hostname suffixes",
    source.includes('endsWith(".supabase.com")') && source.includes('endsWith(".supabase.co")'),
  ],
  [
    "readiness forbids substring-only Supabase hostname detection",
    !source.includes('hostname.includes("supabase")'),
  ],
  [
    "production readiness requires write safety",
    source.includes("(!productionEnvironment || phaseWriteSafetyReady)"),
  ],
  [
    "production write safety requires catalog dry run",
    source.includes("catalogAuditDryRunConfigured;") &&
      source.includes('enabled("CATALOG_AUDIT_DRY_RUN")'),
  ],
  [
    "production write safety requires all broad write and autostart gates closed",
    source.includes("!runtimeWriteGateEnabled") &&
      source.includes("!inventoryAutostartConfigured") &&
      source.includes("!jobRecoveryConfigured") &&
      source.includes("!jobRecoveryShopifyWritesConfigured") &&
      source.includes("!sheetImportAutostartConfigured") &&
      source.includes("!configuration.catalogWriteGateEnabled") &&
      source.includes("!configuration.catalogSheetWriteGateEnabled"),
  ],
  [
    "readiness exposes recovered-job Shopify write gate explicitly",
    source.includes('enabled(\n    "SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED",\n  )') &&
      source.includes("jobRecoveryShopifyWritesConfigured,"),
  ],
  [
    "readiness only reports job recovery enabled when all three write gates are open",
    source.includes("jobRecoveryEnabled:\n      runtimeWriteGateEnabled &&\n      jobRecoveryConfigured &&\n      jobRecoveryShopifyWritesConfigured"),
  ],
  [
    "readiness never reports two-gate recovered-job writes as enabled",
    !source.includes("jobRecoveryEnabled: runtimeWriteGateEnabled && jobRecoveryConfigured,"),
  ],
  [
    "readiness exposes write safety state for monitoring",
    source.includes("writeSafetyReady: phaseWriteSafetyReady"),
  ],
  [
    "readiness declares safe mode mandatory in production",
    source.includes("safeModeRequired: productionEnvironment"),
  ],
  [
    "readiness inspects a bounded recent catalog audit window",
    source.includes("prisma.importBatch.findMany") &&
      source.includes('where: { target: "catalog_audit" }') &&
      source.includes("take: 10"),
  ],
  [
    "rollout monitoring distinguishes dry run from canary",
    source.includes("latestDryRun") &&
      source.includes("latestCanary") &&
      source.includes("run?.dryRun === true") &&
      source.includes("run?.dryRun === false"),
  ],
  [
    "rollout monitoring extracts only exact Shopify Product GIDs",
    source.includes('/^gid:\\/\\/shopify\\/Product\\/\\d+$/.test(id)') &&
      source.includes("shopifyProductIds"),
  ],
  [
    "rollout monitoring exposes a single unambiguous Shopify product identity",
    source.includes("shopifyProductId: shopifyProductIds.length === 1 ? shopifyProductIds[0] : null"),
  ],
  [
    "rollout monitoring exposes exact persisted dry-run batch provenance for canaries",
    source.includes("const dryRunBatchId = String(provenance?.dryRunBatchId") &&
      source.includes("dryRunBatchId,"),
  ],
  [
    "rollout monitoring exposes persisted provenance Shopify identity",
    source.includes("provenanceShopifyProductId") &&
      source.includes("provenance?.shopifyProductId"),
  ],
  [
    "canary provenance is valid only when dry-run batch exists and product identities agree",
    source.includes("canaryProvenanceValid") &&
      source.includes("dryRunBatchId &&") &&
      source.includes("provenanceShopifyProductId === shopifyProductIds[0]"),
  ],
  [
    "dry runs never fabricate canary provenance validity",
    source.includes("summary.dryRun === false") &&
      source.includes(": null;"),
  ],
  [
    "rollout monitoring only marks a strict one-product clean dry run as canary ready",
    source.includes("isCanaryReadyDryRun") &&
      source.includes('run.status === "COMPLETED"') &&
      source.includes("run.uniqueProductsProcessed === 1") &&
      source.includes("run.verified === 1") &&
      source.includes("run.missing === 0") &&
      source.includes("run.ambiguous === 0") &&
      source.includes("run.errors === 0"),
  ],
  [
    "canary-ready dry run requires one exact persisted Shopify product identity",
    source.includes("run.shopifyProductIds.length === 1"),
  ],
  [
    "rollout readiness never treats sheet-writing runs as canary-ready dry runs",
    source.includes("run.writeSheet === false"),
  ],
  [
    "database failure response exposes an explicitly non-ready rollout state",
    source.includes("latestDryRunCanaryReady: false") &&
      source.includes("latestDryRun: null") &&
      source.includes("latestCanary: null"),
  ],
  [
    "readiness uses the same canary dry-run freshness configuration as the canary gate",
    source.includes("CATALOG_AUDIT_CANARY_DRY_RUN_MAX_AGE_MINUTES || 30") &&
      source.includes("Math.min(120, Math.max(1, Math.floor(parsed)))"),
  ],
  [
    "stale dry runs cannot be reported as canary ready",
    source.includes("ageMinutes <= maxAgeMinutes") &&
      source.includes("isCanaryReadyDryRun(latestDryRun, canaryDryRunMaxAge)"),
  ],
  [
    "readiness exposes dry-run age and expiry for rollout monitoring",
    source.includes("latestDryRunAgeMinutes") &&
      source.includes("latestDryRunMaxAgeMinutes: canaryDryRunMaxAge") &&
      source.includes("latestDryRunExpired"),
  ],
  [
    "database failure response does not fabricate fresh dry-run state",
    source.includes("latestDryRunAgeMinutes: null") &&
      source.includes("latestDryRunExpired: false"),
  ],
  [
    "post-canary readiness requires exact persisted Shopify read-back",
    source.includes("latestCanary.readbackVerified === true") &&
      source.includes("latestCanaryReadbackVerified"),
  ],
  [
    "post-canary readiness requires dry-run to canary identity continuity",
    source.includes("latestCanary.dryRunBatchId === latestDryRun.id") &&
      source.includes("latestCanary.shopifyProductId === latestDryRun.shopifyProductId"),
  ],
  [
    "post-canary broad readiness remains queue-clean fail-closed",
    source.includes("postCanaryWriteSafetyReady") &&
      source.includes("pendingJobs === 0") &&
      source.includes("runningJobs === 0") &&
      source.includes("staleRunningJobs === 0") &&
      source.includes("recentFailedJobs === 0"),
  ],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  for (const [name] of failed) {
    console.error(`FAIL: ${name}`);
  }
  process.exit(1);
}

for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}
console.log(
  JSON.stringify(
    {
      assertions: checks.length,
      exactSupabaseProjectBindingObserved: true,
      recoveredJobShopifyWriteGateObserved: true,
      exactCanaryProductIdentityObserved: true,
      exactDryRunToCanaryProvenanceObserved: true,
      databaseWrites: 0,
      shopifyMutations: 0,
      googleSheetWrites: 0,
    },
    null,
    2,
  ),
);
