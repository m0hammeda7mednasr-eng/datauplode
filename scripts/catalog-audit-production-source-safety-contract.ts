import fs from "node:fs";
import path from "node:path";

const middlewarePath = path.resolve("src/server/middleware/catalogAuditSafety.ts");
const source = fs.readFileSync(middlewarePath, "utf8");

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
      source.includes('X-Catalog-Audit-Sheet-Write", "disabled"'),
  ],
];

const failed = checks.filter(([, passed]) => !passed);
if (failed.length) {
  for (const [name] of failed) console.error(`FAIL: ${name}`);
  process.exit(1);
}

for (const [name] of checks) console.log(`PASS: ${name}`);
console.log(`Catalog audit production source safety contract passed (${checks.length} checks).`);
