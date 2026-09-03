import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const envExample = read(".env.railway.example");
const safetyMiddleware = read("src/server/middleware/catalogAuditSafety.ts");
const server = read("server.ts");
const scraper = read("src/server/services/scraper.ts");
const readiness = read("src/server/routes/readiness.routes.ts");
const databasePreflight = read("scripts/database-preflight.ts");
const railwaySafeModePreflight = read("scripts/railway-safe-mode-preflight.ts");
const databaseRuntime = read("src/server/db.ts");
const canaryReadBack = read("scripts/shopify-canary-readback.ts");
const canaryReadBackWorkflow = read(".github/workflows/shopify-canary-readback.yml");
const fullCatalogSync = read("src/server/services/fullCatalogSync.ts");
const shopifyService = read("src/server/services/shopify.ts");
const queue = read("src/server/services/queue.ts");
const shopifyCatalogLinkRoutes = read("src/server/routes/shopify-catalog-link.routes.ts");

const assertions: Array<[string, boolean]> = [
  ["runtime writes default off", /SYNC_RUNTIME_WRITE_ENABLED=false/.test(envExample)],
  ["inventory autostart default off", /SYNC_INVENTORY_AUTOSTART=false/.test(envExample)],
  ["full-catalog autostart default off", /SYNC_FULL_CATALOG_AUTOSTART=false/.test(envExample)],
  [
    "full-catalog autostart requires runtime write gate and exact revision",
    /runtimeWritesEnabled\(\)[\s\S]*envFlag\("SYNC_FULL_CATALOG_AUTOSTART"\)[\s\S]*expected\s*===\s*deployed/.test(server) &&
      /SYNC_FULL_CATALOG_REVISION=/.test(envExample) &&
      /RAILWAY_GIT_COMMIT_SHA/.test(server),
  ],
  [
    "full-catalog writes use synchronous in-place productSet",
    /productSet\([\s\S]*identifier:\s*\$identifier[\s\S]*synchronous:\s*\$synchronous/.test(shopifyService) &&
      /identifier:\s*\{\s*id:\s*productId\s*\}/.test(shopifyService) &&
      /synchronous:\s*true/.test(shopifyService),
  ],
  [
    "full-catalog sync never deletes the Shopify product",
    !/deleteProduct|restDelete|productDelete/.test(fullCatalogSync),
  ],
  [
    "full-catalog sync requires exact read-back",
    /live\?\.id\s*===\s*shopifyProductId/.test(fullCatalogSync) &&
      /live\.media\.length\s*===\s*files\.length/.test(fullCatalogSync) &&
      /live\.variants\.length\s*===\s*variants\.length/.test(fullCatalogSync) &&
      /variantsMatch/.test(fullCatalogSync),
  ],
  [
    "full-catalog sync resolves review only after exact read-back",
    /if \(!verified\)[\s\S]*tx\.manualReviewItem\.updateMany\([\s\S]*status:\s*"approved"/.test(fullCatalogSync),
  ],
  [
    "full-catalog batch prioritizes pending linked reviews",
    /manualReviews:\s*\{\s*some:\s*\{\s*status:\s*'pending'\s*\}\s*\}/.test(queue) &&
      /const candidates = \[\.\.\.reviewCandidates, \.\.\.otherCandidates\]/.test(queue),
  ],
  [
    "full-catalog sync rejects suspicious images and duplicate SKUs",
    /isLikelyProductImageSource/.test(fullCatalogSync) &&
      /new Set\(skus\)\.size\s*!==\s*skus\.length/.test(fullCatalogSync),
  ],
  [
    "full-catalog sync has an exact supplier allowlist",
    /host === "www\.centrepointstores\.com"/.test(fullCatalogSync) &&
      /host === "www\.next\.ae"/.test(fullCatalogSync) &&
      /Only linked Centrepoint and Next UAE products/.test(fullCatalogSync),
  ],
  [
    "full-catalog rolling batch supports a configured domain subset",
    /SYNC_FULL_CATALOG_TARGET_DOMAINS/.test(queue) &&
      /FULL_CATALOG_TARGET_DOMAINS\.map/.test(queue),
  ],
  [
    "full-catalog source scraping is bounded before Shopify mutation",
    /withTimeout\([\s\S]*new ScraperService\(\)\.scrape\(product\.url\)[\s\S]*120_000[\s\S]*before Shopify mutation/.test(fullCatalogSync),
  ],
  [
    "full-catalog rolling batch remains capped at five",
    /Math\.min\(5,\s*Math\.floor\(FULL_CATALOG_SYNC_BATCH_SIZE\)\)/.test(queue),
  ],
  [
    "full-catalog batch has queue priority without increasing concurrency",
    /new PQueue\(\{\s*concurrency:\s*2\s*\}\)/.test(queue) &&
      /typeHint\s*===\s*'SYNC_FULL_CATALOG_BATCH'\s*\?\s*100\s*:\s*0/.test(queue) &&
      /\{\s*priority\s*\}/.test(queue),
  ],
  [
    "Shopify-first catalog scan is deduplicated and throttle-aware",
    /let scanPromise: Promise<CatalogScan> \| null = null/.test(shopifyCatalogLinkRoutes) &&
      /if \(scanPromise\) return scanPromise/.test(shopifyCatalogLinkRoutes) &&
      /SHOPIFY_THROTTLE_RETRIES/.test(shopifyCatalogLinkRoutes) &&
      /Retry-After/.test(shopifyCatalogLinkRoutes),
  ],
  [
    "Shopify-first catalog scan bounds nested connection cost",
    /SHOPIFY_PRODUCTS_PER_PAGE = 25/.test(shopifyCatalogLinkRoutes) &&
      /SHOPIFY_VARIANTS_PER_PRODUCT = 20/.test(shopifyCatalogLinkRoutes) &&
      /SHOPIFY_PAGE_DELAY_MS/.test(shopifyCatalogLinkRoutes),
  ],
  [
    "Shopify-first catalog endpoint warms snapshots without blocking HTTP",
    /if \(!snapshotCache\)[\s\S]*void scanCatalog\(force\)[\s\S]*status\(202\)[\s\S]*warming: true/.test(
      shopifyCatalogLinkRoutes,
    ),
  ],
  ["job recovery default off", /SYNC_JOB_RECOVERY_ENABLED=false/.test(envExample)],
  [
    "sheet import autostart default off",
    /SYNC_SHEET_IMPORT_AUTOSTART_ENABLED=false/.test(envExample),
  ],
  [
    "Sheet 1 catalog autostart defaults off and requires an exact revision",
    /SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED=false/.test(envExample) &&
      /SYNC_SHEET1_CATALOG_REVISION=/.test(envExample),
  ],
  ["catalog writes default off", /CATALOG_AUDIT_WRITE_ENABLED=false/.test(envExample)],
  ["sheet writes default off", /CATALOG_AUDIT_SHEET_WRITE_ENABLED=false/.test(envExample)],
  ["canary defaults to one row", /CATALOG_AUDIT_CANARY_MAX_ROWS=1/.test(envExample)],
  [
    "readiness database timeout is documented",
    /READINESS_DATABASE_TIMEOUT_MS=5000/.test(envExample),
  ],
  [
    "Supabase example uses bounded session pool settings",
    /:5432\/postgres\?sslmode=require&connection_limit=10&pool_timeout=20/.test(envExample),
  ],
  [
    "database preflight requires Supabase TLS and session pooler",
    /target\.sslMode !== "require"/.test(databasePreflight) &&
      /target\.port !== "5432"/.test(databasePreflight) &&
      /transaction pooler port 6543 is not approved/.test(databasePreflight),
  ],
  [
    "runtime preserves the preflight-approved Supabase session pooler",
    !/url\.port\s*=\s*["']6543["']/.test(databaseRuntime) &&
      !/searchParams\.set\(["']pgbouncer["']/.test(databaseRuntime) &&
      /do not rewrite a Supabase Session Pooler URL/.test(databaseRuntime),
  ],
  [
    "runtime may tune connection limit without changing database target",
    /searchParams\.has\(["']connection_limit["']\)/.test(databaseRuntime) &&
      /searchParams\.set\(["']connection_limit["']/.test(databaseRuntime),
  ],
  [
    "database preflight requires bounded pool configuration",
    /connection_limit between 1 and 20/.test(databasePreflight) &&
      /pool_timeout between 1 and 60 seconds/.test(databasePreflight) &&
      /boundedInteger\(url\.searchParams\.get\("connection_limit"\), 1, 20\)/.test(databasePreflight) &&
      /boundedInteger\(url\.searchParams\.get\("pool_timeout"\), 1, 60\)/.test(databasePreflight),
  ],
  [
    "database preflight does not print database hostname or name",
    /target: isSupabase \? "supabase" : "configured"/.test(databasePreflight) &&
      !/host:\s*url\.hostname/.test(databasePreflight) &&
      !/database:\s*url\.pathname/.test(databasePreflight),
  ],
  [
    "readiness database work is bounded",
    /function readinessTimeoutMs\(\)/.test(readiness) &&
      /Math\.max\(1000, Math\.min\(15000/.test(readiness) &&
      /await withTimeout\(/.test(readiness),
  ],
  [
    "readiness does not expose database hostnames",
    /target:\s*"configured"/.test(readiness) &&
      !/host:\s*url\.hostname/.test(readiness) &&
      !/hostname:\s*url\.hostname/.test(readiness) &&
      !/database:\s*url\.pathname/.test(readiness),
  ],
  [
    "readiness does not expose raw database errors",
    /error: "Database readiness check failed"/.test(readiness) &&
      !/error: String\(error\?\.message/.test(readiness),
  ],
  [
    "readiness reports latency and stable failure codes",
    /latencyMs: Date\.now\(\) - startedAt/.test(readiness) &&
      /DATABASE_TIMEOUT/.test(readiness) &&
      /DATABASE_UNAVAILABLE/.test(readiness),
  ],
  ["catalog write requires token header", /x-catalog-audit-write-token/i.test(safetyMiddleware)],
  ["dry run forces sheet writes off", /writeSheet\s*=\s*false|writeSheet:\s*false/.test(safetyMiddleware)],
  [
    "Shopify canary is hard-locked to one product",
    /code:\s*"CATALOG_AUDIT_CANARY_REQUIRES_ONE_PRODUCT"/.test(safetyMiddleware) &&
      /numericMaxRows !== 1/.test(safetyMiddleware) &&
      /maxRows:\s*1/.test(safetyMiddleware) &&
      !/process\.env\.CATALOG_AUDIT_CANARY_MAX_ROWS/.test(safetyMiddleware),
  ],
  [
    "broad catalog writes have no configurable canary row override",
    !/boundedInteger\([\s\S]*CATALOG_AUDIT_CANARY_MAX_ROWS/.test(safetyMiddleware) &&
      /Shopify canary write mode requires maxRows=1 exactly/.test(safetyMiddleware),
  ],
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
  [
    "Railway predeploy only allows catalog runtime writes with exact revision pins",
    /function catalogWorkerRevisionAuthorized\(\)/.test(railwaySafeModePreflight) &&
      /SYNC_SHEET1_CATALOG_REVISION/.test(railwaySafeModePreflight) &&
      /SYNC_SHEET1_CATALOG_DEPLOYED_REVISION/.test(railwaySafeModePreflight) &&
      /expected === deployed/.test(railwaySafeModePreflight) &&
      /name === 'SYNC_RUNTIME_WRITE_ENABLED' && catalogRevisionAuthorized/.test(
        railwaySafeModePreflight,
      ) &&
      !/name === 'SYNC_FIRST5_RECONCILE_ENABLED' && catalogRevisionAuthorized/.test(
        railwaySafeModePreflight,
      ),
  ],
  ["403 is classified as blocked source", /HTTP 403/.test(scraper) && /SOURCE_BLOCKED/.test(scraper)],
  [
    "canary read-back only targets exact myshopify hostnames",
    canaryReadBack.includes("\\.myshopify\\.com$") &&
      canaryReadBack.includes("SHOPIFY_SHOP_DOMAIN must be an exact *.myshopify.com hostname"),
  ],
  ["canary read-back disables redirects", /maxRedirects:\s*0/.test(canaryReadBack)],
  [
    "canary read-back uses a GraphQL query and no mutation",
    /query CanaryReadBack/.test(canaryReadBack) && !/\bmutation\b/i.test(canaryReadBack),
  ],
  ["canary read-back requires exact product identity", /product\.id !== productId/.test(canaryReadBack)],
  [
    "canary read-back verifies SKU and price",
    /SKU mismatch/.test(canaryReadBack) && /Price mismatch/.test(canaryReadBack),
  ],
  [
    "canary read-back rejects HTTP 403 as blocked, not stock state",
    /HTTP 403; this is not an out-of-stock result/.test(canaryReadBack),
  ],
  ["canary read-back reports read-only status", /readOnly:\s*true/.test(canaryReadBack)],
  [
    "canary workflow is manual-only",
    /on:\s*\n\s*workflow_dispatch:/.test(canaryReadBackWorkflow) &&
      !/^\s*(push|pull_request|schedule):/m.test(canaryReadBackWorkflow),
  ],
  [
    "canary workflow has read-only repository permissions",
    /permissions:\s*\n\s*contents:\s*read/.test(canaryReadBackWorkflow) &&
      !/contents:\s*write/.test(canaryReadBackWorkflow),
  ],
  [
    "canary workflow supplies no catalog or runtime write gates",
    !/(CATALOG_AUDIT_WRITE_TOKEN|CATALOG_AUDIT_WRITE_ENABLED|SYNC_RUNTIME_WRITE_ENABLED)/.test(
      canaryReadBackWorkflow,
    ),
  ],
  [
    "canary workflow runs only the read-back command",
    /run:\s*npm run canary:readback/.test(canaryReadBackWorkflow) &&
      !/npm run (sync|import|inventory|catalog)/.test(canaryReadBackWorkflow),
  ],
  [
    "canary workflow validates direct Shopify hostname",
    /myshopify\\\.com\$/.test(canaryReadBackWorkflow) &&
      /direct \*\.myshopify\.com hostname/.test(canaryReadBackWorkflow),
  ],
  [
    "canary workflow documents zero mutations and blocked 403",
    /Shopify mutations:\s*\\`0\\`/.test(canaryReadBackWorkflow) &&
      /HTTP 403 classification: blocked, never out-of-stock/.test(canaryReadBackWorkflow),
  ],
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
