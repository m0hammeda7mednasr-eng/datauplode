import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const envExample = read(".env.railway.example");
const safetyMiddleware = read("src/server/middleware/catalogAuditSafety.ts");
const server = read("server.ts");
const scraper = read("src/server/services/scraper.ts");

const assertions: Array<[string, boolean]> = [
  ["runtime writes default off", /SYNC_RUNTIME_WRITE_ENABLED=false/.test(envExample)],
  ["inventory autostart default off", /SYNC_INVENTORY_AUTOSTART=false/.test(envExample)],
  ["job recovery default off", /SYNC_JOB_RECOVERY_ENABLED=false/.test(envExample)],
  ["catalog writes default off", /CATALOG_AUDIT_WRITE_ENABLED=false/.test(envExample)],
  ["sheet writes default off", /CATALOG_AUDIT_SHEET_WRITE_ENABLED=false/.test(envExample)],
  ["canary defaults to one row", /CATALOG_AUDIT_CANARY_MAX_ROWS=1/.test(envExample)],
  ["catalog write requires token header", /x-catalog-audit-write-token/i.test(safetyMiddleware)],
  ["dry run forces sheet writes off", /writeSheet\s*=\s*false|writeSheet:\s*false/.test(safetyMiddleware)],
  ["server gates runtime recovery", /SYNC_RUNTIME_WRITE_ENABLED/.test(server)],
  ["403 is classified as blocked source", /HTTP 403/.test(scraper) && /SOURCE_BLOCKED/.test(scraper)],
];

const failed = assertions.filter(([, ok]) => !ok);
for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  console.error(`Production safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Production safety contract passed: ${assertions.length}/${assertions.length}`);
