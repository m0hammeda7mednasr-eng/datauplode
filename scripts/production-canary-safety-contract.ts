import fs from "node:fs";

const workflowPath = ".github/workflows/production-canary.yml";
const workflow = fs.readFileSync(workflowPath, "utf8");

const checks: Array<[string, boolean]> = [
  ["manual workflow only", workflow.includes("workflow_dispatch:") && !workflow.includes("push:\n")],
  ["exact deployed revision required", workflow.includes("canary_revision:") && workflow.includes("required: true")],
  ["exact dry-run batch required", workflow.includes("dry_run_batch_id:") && workflow.includes("CANARY_DRY_RUN_BATCH_ID")],
  ["Railway target comes from repository secret", workflow.includes("RAILWAY_SMOKE_BASE_URL: ${{ secrets.RAILWAY_SMOKE_BASE_URL }}")],
  ["write token comes from repository secret", workflow.includes("CATALOG_AUDIT_WRITE_TOKEN: ${{ secrets.CATALOG_AUDIT_WRITE_TOKEN }}")],
  ["full 40-character revision enforced", workflow.includes("^[0-9a-f]{40}$")],
  ["HTTPS Railway target required", workflow.includes("RAILWAY_SMOKE_BASE_URL must be configured and use HTTPS")],
  ["checkout pinned to requested canary revision", workflow.includes("ref: ${{ inputs.canary_revision }}")],
  ["live readiness checked before canary", workflow.includes("readiness-before.json") && workflow.includes("/api/ready")],
  ["live database must be Supabase", workflow.includes("body?.database?.target !== 'supabase'")],
  ["exact Railway revision checked before canary", workflow.includes("actualRevision !== expectedRevision")],
  ["platform write safety required", workflow.includes("body?.platform?.writeSafetyReady !== true")],
  ["runtime broad-write gate remains disabled", workflow.includes("runtimeWriteGateEnabled !== false")],
  ["inventory autostart remains disabled", workflow.includes("inventoryAutostartEnabled !== false")],
  ["catalog write gate explicitly required", workflow.includes("catalogWriteGateEnabled !== true")],
  ["Google Sheet write gate remains disabled", workflow.includes("catalogSheetWriteGateEnabled !== false")],
  ["canary max rows exactly one", workflow.includes("catalogCanaryMaxRows) !== 1")],
  ["queue must be quiescent", ["pending", "running", "staleRunning", "recentFailed"].every((name) => workflow.includes(`'${name}'`))],
  [
    "latest persisted dry run must equal requested batch",
    workflow.includes("String(dryRun.id || '').trim() !== expectedDryRun") &&
      workflow.includes("does not match requested batch"),
  ],
  ["dry run must currently be canary ready", workflow.includes("latestDryRunCanaryReady !== true") && workflow.includes("latestDryRunExpired === true")],
  ["dry run must prove exactly one existing product", workflow.includes("dryRun.uniqueProductsProcessed) !== 1") && workflow.includes("dryRun.verified) !== 1")],
  ["dry run product identity must be exact Shopify GID", workflow.includes("gid:\\/\\/shopify\\/Product\\/\\d+")],
  ["canary request forces dryRun false", workflow.includes("\"dryRun\":false")],
  ["canary request forces Sheet write false", workflow.includes("\"writeSheet\":false")],
  ["canary request forces offset zero", workflow.includes("\"offset\":0")],
  ["canary request forces maxRows one", workflow.includes("\"maxRows\":1")],
  ["canary supplies write authorization header", workflow.includes("x-catalog-audit-write-token")],
  ["canary supplies exact dry-run provenance header", workflow.includes("x-catalog-audit-dry-run-batch-id")],
  ["automatic retry after write attempt is explicitly disabled", workflow.includes("No retry is performed automatically") && !workflow.includes("retry-max") && !workflow.includes("max-attempts")],
  ["canary response must return persisted batch", workflow.includes("Canary response did not return a persisted batchId")],
  ["canary response must remain one clean product", workflow.includes("Canary response is not a clean one-product verification")],
  ["canary response provenance must match dry run", workflow.includes("Canary response provenance does not match the authorizing dry-run batch")],
  ["canary response product must be exact Shopify GID", workflow.includes("Canary response provenance does not contain an exact Shopify Product GID")],
  ["Supabase persisted canary read-back occurs after write", workflow.includes("readiness-after.json")],
  ["persisted canary batch equality required", workflow.includes("Exact canary batch is not persisted as latestCanary")],
  ["persisted canary provenance validity required", workflow.includes("canary.canaryProvenanceValid !== true")],
  ["persisted dry-run to canary equality required", workflow.includes("Persisted canary is not tied to the exact authorizing dry run")],
  ["persisted Shopify product equality required", workflow.includes("Persisted canary product identity changed")],
  ["broader writes remain blocked pending Shopify read-back", workflow.includes("Shopify read-back required before any broader write")],
  ["403 remains blocked or unknown", workflow.includes("403/CAPTCHA/timeout classification: blocked/unknown, never out-of-stock")],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

if (failures.length > 0) {
  console.error(`Production canary safety contract failed: ${failures.length}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`Production canary safety contract passed: ${checks.length}/${checks.length} checks.`);
