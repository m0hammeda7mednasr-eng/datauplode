import fs from "node:fs";
import path from "node:path";

const middlewarePath = path.resolve("src/server/middleware/catalogAuditSafety.ts");
const smokePath = path.resolve("scripts/production-smoke.ts");
const source = fs.readFileSync(middlewarePath, "utf8");
const smoke = fs.readFileSync(smokePath, "utf8");

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
    source.includes('batch.target !== "catalog_audit"') &&
      source.includes('batch.status !== "COMPLETED"'),
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
