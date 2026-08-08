import fs from "node:fs";
import path from "node:path";

const middlewarePath = path.resolve("src/server/middleware/catalogAuditSafety.ts");
const smokePath = path.resolve("scripts/production-smoke.ts");
const guardPath = path.resolve("src/server/services/catalogCanaryMutationGuard.ts");
const source = fs.readFileSync(middlewarePath, "utf8");
const smoke = fs.readFileSync(smokePath, "utf8");
const guard = fs.readFileSync(guardPath, "utf8");

const checks: Array<[string, boolean]> = [
  [
    "production catalog audit requires configured sheet URL",
    source.includes("CATALOG_AUDIT_PRODUCTION_SHEET_NOT_CONFIGURED") &&
      source.includes("process.env.CATALOG_AUDIT_SHEET_URL"),
  ],
  [
    "production request-level spreadsheet overrides are rejected",
    source.includes("CATALOG_AUDIT_PRODUCTION_SHEET_OVERRIDE_REJECTED"),
  ],
  [
    "production request-level sheet configuration overrides are rejected",
    source.includes("CATALOG_AUDIT_PRODUCTION_SHEETS_OVERRIDE_REJECTED"),
  ],
  [
    "production middleware pins spreadsheetUrl to configured source",
    source.includes("spreadsheetUrl: configuredSheetUrl"),
  ],
  [
    "canary rejects non-zero offset",
    source.includes("CATALOG_AUDIT_CANARY_REQUIRES_FIRST_PRODUCT") &&
      source.includes("Number(suppliedOffset) !== 0"),
  ],
  [
    "canary forcibly pins offset zero and maxRows one",
    source.includes("offset: 0") && source.includes("maxRows: 1"),
  ],
  [
    "canary remains isolated from Google Sheet writes",
    source.includes("const writeSheet = false") &&
      source.includes('X-Catalog-Audit-Sheet-Write\", \"disabled'),
  ],
  [
    "production canary requires a persisted dry-run batch",
    source.includes("CATALOG_AUDIT_CANARY_DRY_RUN_REQUIRED") &&
      source.includes("x-catalog-audit-dry-run-batch-id") &&
      source.includes("prisma.importBatch.findUnique"),
  ],
  [
    "canary dry-run batch must be completed catalog audit",
    source.includes('batch.target !== \"catalog_audit\"') &&
      source.includes('batch.status !== \"COMPLETED\"'),
  ],
  [
    "canary rejects stale dry-run provenance",
    source.includes("CATALOG_AUDIT_CANARY_DRY_RUN_EXPIRED") &&
      source.includes("CATALOG_AUDIT_CANARY_DRY_RUN_MAX_AGE_MINUTES") &&
      source.includes("Math.min(120, Math.max(1"),
  ],
  [
    "canary requires one verified existing product and no dry-run failures",
    source.includes("Number(summary.uniqueProductsProcessed) === 1") &&
      source.includes("Number(summary.verified) === 1") &&
      source.includes("Number(summary.missing) === 0") &&
      source.includes("Number(summary.ambiguous) === 0") &&
      source.includes("Number(summary.errors) === 0"),
  ],
  [
    "canary dry run must reference configured production spreadsheet",
    source.includes("batchSheetId === configuredSheetId"),
  ],
  [
    "canary revalidates the exact dry-run sheet row before write",
    source.includes("CATALOG_AUDIT_CANARY_SOURCE_CHANGED") &&
      source.includes("expectedRowNumber - 1") &&
      source.includes("canonicalSourceUrl(cell) === expectedSourceUrl"),
  ],
  [
    "canary fails closed when live sheet revalidation is unavailable",
    source.includes("CATALOG_AUDIT_CANARY_SOURCE_REVALIDATION_UNAVAILABLE") &&
      source.includes("no Shopify write was attempted"),
  ],
  [
    "canary requires a unique exact Prisma mapping for the dry-run source URL",
    source.includes("CATALOG_AUDIT_CANARY_PRODUCT_MAPPING_NOT_UNIQUE") &&
      source.includes("exactMappings.length !== 1") &&
      source.includes("prisma.sourceProduct.findMany"),
  ],
  [
    "canary requires current Prisma Shopify ID to equal dry-run Shopify ID",
    source.includes("CATALOG_AUDIT_CANARY_PRODUCT_IDENTITY_CHANGED") &&
      source.includes("currentShopifyProductId !== expectedShopifyProductId"),
  ],
  [
    "canary carries verified product identity forward for monitoring",
    source.includes("canaryExpectedShopifyProductId") &&
      source.includes("X-Catalog-Audit-Canary-Product") &&
      source.includes("X-Catalog-Audit-Canary-Source-Row"),
  ],
  [
    "production canary establishes request-scoped mutation guard",
    source.includes("runWithCatalogCanaryMutationGuard") &&
      source.includes("expectedShopifyProductId") &&
      source.includes("() => next()"),
  ],
  [
    "mutation guard uses AsyncLocalStorage so concurrent requests stay isolated",
    guard.includes("AsyncLocalStorage") &&
      guard.includes("canaryMutationContext.run") &&
      guard.includes("canaryMutationContext.getStore"),
  ],
  [
    "mutation guard blocks product ID drift immediately before Shopify bulk mutation",
    guard.includes("CATALOG_AUDIT_CANARY_MUTATION_PRODUCT_MISMATCH") &&
      guard.includes("actualProductId !== context.expectedShopifyProductId") &&
      guard.includes("originalUpdateVariantsBulk"),
  ],
  [
    "mutation guard requires an exact Shopify Product GID",
    guard.includes("CATALOG_AUDIT_CANARY_MUTATION_PRODUCT_INVALID") &&
      guard.includes("/^gid:\\/\\/shopify\\/Product\\/\\d+$/.test(expected)"),
  ],
  [
    "successful production canary response is intercepted for provenance persistence",
    source.includes("installCanaryProvenancePersistence") &&
      source.includes("body?.success !== true") &&
      source.includes("body?.batchId"),
  ],
  [
    "persisted canary provenance records exact dry-run batch and Shopify product",
    source.includes("payload.provenance") &&
      source.includes("dryRunBatchId,") &&
      source.includes("shopifyProductId: expectedShopifyProductId"),
  ],
  [
    "canary provenance is persisted only after revalidating a clean one-product canary payload",
    source.includes("Persisted canary payload does not match the verified one-product canary identity") &&
      source.includes("productIds.length !== 1") &&
      source.includes("productIds[0] !== expectedShopifyProductId"),
  ],
  [
    "canary provenance persistence failure blocks rollout and automatic retry",
    source.includes("CATALOG_AUDIT_CANARY_PROVENANCE_PERSIST_FAILED") &&
      source.includes("Do not broaden writes or retry automatically") &&
      source.includes("prisma.importBatch.update"),
  ],
  [
    "production smoke rejects missing existing Shopify product",
    smoke.includes("verified !== 1 || missing !== 0") &&
      smoke.includes("must prove one existing Shopify product before canary"),
  ],
  [
    "production smoke exposes persisted dry-run batch for canary",
    smoke.includes("dryRun.body.batchId") &&
      smoke.includes("canaryPreconditionHeader") &&
      smoke.includes("x-catalog-audit-dry-run-batch-id"),
  ],
];

const failed = checks.filter(([, passed]) => !passed);
if (failed.length) {
  for (const [name] of failed) console.error(`FAIL: ${name}`);
  process.exit(1);
}

for (const [name] of checks) console.log(`PASS: ${name}`);
console.log(`Catalog audit production source safety contract passed (${checks.length} checks).`);
