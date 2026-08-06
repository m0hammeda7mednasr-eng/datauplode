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
  [
    "sheet import autostart default off",
    /SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false/.test(envExample),
  ],
  ["catalog writes default off", /CATALOG_AUDIT_WRITE_ENABLED=false/.test(envExample)],
  ["sheet writes default off", /CATALOG_AUDIT_SHEET_WRITE_ENABLED=false/.test(envExample)],
  ["canary defaults to one row", /CATALOG_AUDIT_CANARY_MAX_ROWS=1/.test(envExample)],
  ["catalog write requires token header", /x-catalog-audit-write-token/i.test(safetyMiddleware)],
  ["dry run forces sheet writes off", /writeSheet\s*=\s*false|writeSheet:\s*false/.test(safetyMiddleware)],
  [
    "job recovery requires runtime and recovery gates",
    /function jobRecoveryEnabled\(\)[\s\S]*?runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_JOB_RECOVERY_ENABLED"\)/.test(
      server,
    ) && /if \(jobRecoveryEnabled\(\)\)[\s\S]*?recoverInterruptedJobs/.test(server),
  ],
  [
    "inventory monitor requires runtime and inventory gates",
    /function inventoryAutostartEnabled\(\)[\s\S]*?runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_INVENTORY_AUTOSTART"\)/.test(
      server,
    ) && /if \(inventoryAutostartEnabled\(\)\)[\s\S]*?startInventoryMonitor/.test(server),
  ],
  [
    "sheet import requires runtime and sheet-import gates",
    /function sheetImportAutostartEnabled\(\)[\s\S]*?runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_SHEET_IMPORT_AUTOSTART_ENABLED"\)/.test(
      server,
    ) && /if \(sheetImportAutostartEnabled\(\)\)[\s\S]*?startOneTimeSheetImport/.test(server),
  ],
  [
    "runtime safe mode exits before background startup",
    /if \(!runtimeWritesEnabled\(\)\)[\s\S]*?return;[\s\S]*?jobRecoveryEnabled\(\)/.test(server),
  ],
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
