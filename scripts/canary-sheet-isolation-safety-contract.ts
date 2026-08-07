import { readFileSync } from "node:fs";

const middleware = readFileSync("src/server/middleware/catalogAuditSafety.ts", "utf8");

const assertions: Array<[string, boolean]> = [
  [
    "canary forces Google Sheet writes off",
    /const\s+writeSheet\s*=\s*false/.test(middleware) &&
      /writeSheet,/.test(middleware) &&
      /X-Catalog-Audit-Sheet-Write",\s*"disabled"/.test(middleware),
  ],
  [
    "canary cannot enable sheet writes through environment",
    !/CATALOG_AUDIT_SHEET_WRITE_ENABLED/.test(middleware),
  ],
  [
    "canary cannot pass through requested sheet write",
    !/req\.body\?\.writeSheet\s*===\s*true/.test(middleware),
  ],
  [
    "canary remains hard-locked to one product",
    /numericMaxRows !== 1/.test(middleware) && /maxRows:\s*1/.test(middleware),
  ],
  [
    "dry run also forces sheet writes off",
    /dryRun:\s*true,\s*writeSheet:\s*false/.test(middleware),
  ],
];

const failed = assertions.filter(([, ok]) => !ok);
for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  console.error(`Canary sheet isolation safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Canary sheet isolation safety contract passed: ${assertions.length}/${assertions.length}`);
console.log("Database writes: 0");
console.log("Shopify mutations: 0");
console.log("Google Sheet writes: 0");
