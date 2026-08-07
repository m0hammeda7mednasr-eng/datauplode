import { readFileSync } from "node:fs";

const readiness = readFileSync("src/server/routes/readiness.routes.ts", "utf8");
const smoke = readFileSync("scripts/production-smoke.ts", "utf8");
const smokeWorkflow = readFileSync(".github/workflows/production-smoke.yml", "utf8");

const assertions: Array<[string, boolean]> = [
  [
    "readiness reports pending sync jobs",
    /status:\s*["']pending["']/.test(readiness) && /pending:\s*pendingJobs/.test(readiness),
  ],
  [
    "readiness reports running sync jobs",
    /status:\s*["']running["']/.test(readiness) && /running:\s*runningJobs/.test(readiness),
  ],
  [
    "readiness reports stale running jobs",
    /staleRunning:\s*staleRunningJobs/.test(readiness) && /staleThresholdMinutes/.test(readiness),
  ],
  [
    "readiness reports recent failed jobs",
    /recentFailed:\s*recentFailedJobs/.test(readiness) && /recentFailureThresholdMinutes/.test(readiness),
  ],
  [
    "production smoke parses pending jobs as a required numeric field",
    /const pendingJobs = Number\(jobs\.pending \?\? Number\.NaN\)/.test(smoke),
  ],
  [
    "production smoke parses running jobs as a required numeric field",
    /const runningJobs = Number\(jobs\.running \?\? Number\.NaN\)/.test(smoke),
  ],
  [
    "production smoke blocks pending jobs while safe mode is required",
    /requireSafeMode[\s\S]{0,120}pendingJobs[\s\S]{0,120}pendingJobs !== 0/.test(smoke),
  ],
  [
    "pending queue failure explains the delayed-write risk",
    /queued jobs before canary[\s\S]{0,160}runtime writes are opened/.test(smoke),
  ],
  [
    "production smoke blocks running jobs in safe mode",
    /requireSafeMode[\s\S]{0,120}runningJobs[\s\S]{0,120}runningJobs !== 0/.test(smoke),
  ],
  [
    "production smoke blocks stale running jobs",
    /staleRunningJobs !== 0/.test(smoke),
  ],
  [
    "production smoke blocks recent failed jobs",
    /recentFailedJobs !== 0/.test(smoke),
  ],
  [
    "production smoke blocks configured inventory autostart drift",
    /requireDisabled\(configuration, ["']inventoryAutostartConfigured["']\)/.test(smoke),
  ],
  [
    "production smoke blocks configured recovery drift",
    /requireDisabled\(configuration, ["']jobRecoveryConfigured["']\)/.test(smoke),
  ],
  [
    "production smoke blocks configured sheet-import autostart drift",
    /requireDisabled\(configuration, ["']sheetImportAutostartConfigured["']\)/.test(smoke),
  ],
  [
    "production smoke preserves pending count in its report",
    /pending:\s*jobs\.pending \?\? ["']unknown["']/.test(smoke),
  ],
  [
    "production smoke preserves configured autostart state in its report",
    /inventoryAutostartConfigured:[\s\S]{0,300}jobRecoveryConfigured:[\s\S]{0,300}sheetImportAutostartConfigured:/.test(smoke),
  ],
  [
    "production smoke still forces a one-product dry run",
    /dryRun:\s*true/.test(smoke) && /writeSheet:\s*false/.test(smoke) && /maxRows:\s*1/.test(smoke),
  ],
  [
    "production smoke workflow cannot expose a dry-run skip input",
    !/skip_catalog_dry_run\s*:/.test(smokeWorkflow),
  ],
  [
    "production smoke workflow explicitly requires the catalog dry run",
    /SMOKE_SKIP_CATALOG_DRY_RUN:\s*["']false["']/.test(smokeWorkflow),
  ],
  [
    "dry-run counters are mandatory rather than defaulting to zero",
    /uniqueProductsProcessed \?\? Number\.NaN/.test(smoke) &&
      /summary\.verified \?\? Number\.NaN/.test(smoke) &&
      /summary\.missing \?\? Number\.NaN/.test(smoke) &&
      /summary\.ambiguous \?\? Number\.NaN/.test(smoke) &&
      /summary\.errors \?\? Number\.NaN/.test(smoke),
  ],
  [
    "production smoke requires exactly one audited product",
    /processed !== 1/.test(smoke) && /requires exactly one product to be audited before canary/.test(smoke),
  ],
  [
    "production smoke blocks ambiguous and errored audits",
    /ambiguous !== 0 \|\| errors !== 0/.test(smoke) && /is not canary-ready/.test(smoke),
  ],
  [
    "production smoke validates terminal audit counters",
    /verified \+ missing !== processed/.test(smoke) && /must equal processed/.test(smoke),
  ],
  [
    "production smoke rejects invalid or negative counters",
    /Number\.isSafeInteger\(value\)/.test(smoke) && /value < 0/.test(smoke),
  ],
  [
    "HTTP 403 remains blocked or unknown rather than out-of-stock",
    /HTTP 403 must remain blocked\/unknown, never out-of-stock/.test(smoke),
  ],
];

const failed = assertions.filter(([, ok]) => !ok);

for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

if (failed.length > 0) {
  console.error(`Pre-canary queue safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Pre-canary queue safety contract passed: ${assertions.length}/${assertions.length}`);
