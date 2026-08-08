import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const scriptPath = path.join(root, "scripts/shopify-canary-readback.ts");
const workflowPath = path.join(root, ".github/workflows/shopify-canary-readback.yml");

const script = fs.readFileSync(scriptPath, "utf8");
const workflow = fs.readFileSync(workflowPath, "utf8");

const checks: Array<[string, boolean]> = [
  ["workflow is manually dispatched", /workflow_dispatch:/.test(workflow)],
  ["workflow permissions are read-only", /permissions:\s*\n\s*contents:\s*read/.test(workflow)],
  ["workflow does not cancel an in-progress read-back", /cancel-in-progress:\s*false/.test(workflow)],
  ["workflow requires the canary revision input", /canary_revision:[\s\S]*?required:\s*true/.test(workflow)],
  ["workflow exports the expected canary revision", /CANARY_EXPECTED_REVISION:\s*\$\{\{\s*inputs\.canary_revision\s*\}\}/.test(workflow)],
  ["workflow validates a full canary SHA before checkout", /Validate requested canary revision[\s\S]*?\^\[0-9a-f\]\{40\}\$/.test(workflow)],
  ["workflow pins checkout to the exact canary revision", /actions\/checkout@v4[\s\S]*?ref:\s*\$\{\{\s*inputs\.canary_revision\s*\}\}/.test(workflow)],
  ["workflow compares checked-out and canary revisions before read-back", /actual=.*git rev-parse HEAD[\s\S]*?actual.*!=.*expected/.test(workflow)],
  ["workflow reports checkout pinning", /Checkout pinned to canary revision: \\\`true\\\`/.test(workflow)],
  ["workflow reports revision equality as required", /Revision equality required before Shopify read-back: \\\`true\\\`/.test(workflow)],
  ["workflow requires Railway target secret", /RAILWAY_SMOKE_BASE_URL:\s*\$\{\{\s*secrets\.RAILWAY_SMOKE_BASE_URL\s*\}\}/.test(workflow)],
  ["workflow requires HTTPS Railway target", /RAILWAY_SMOKE_BASE_URL must use HTTPS/.test(workflow)],
  ["workflow checks live Railway readiness before Shopify", /Verify live Railway and Supabase provenance before Shopify read-back/.test(workflow)],
  ["Railway readiness follows zero redirects", /curl[\s\S]*?--max-redirs\s+0/.test(workflow)],
  ["Railway readiness requires HTTP success", /curl[\s\S]*?--fail/.test(workflow)],
  ["live readiness must report ok=true", /body\?\.ok !== true/.test(workflow)],
  ["live readiness must target Supabase", /body\?\.database\?\.target !== 'supabase'/.test(workflow)],
  ["live Railway revision must equal canary revision", /actual !== expected[\s\S]*?does not match canary revision/.test(workflow)],
  ["live platform readiness is required", /body\?\.platform\?\.ready !== true/.test(workflow)],
  ["live write-safety readiness is required", /body\?\.platform\?\.writeSafetyReady !== true/.test(workflow)],
  ["live safe mode is required", /body\?\.configuration\?\.safeMode !== true/.test(workflow)],
  ["persisted canary evidence is required", /const latestCanary = body\?\.rollout\?\.latestCanary;/.test(workflow)],
  ["persisted canary must be completed", /latestCanary\.status !== 'COMPLETED'/.test(workflow)],
  ["persisted canary must not be a dry run", /latestCanary\.dryRun !== false/.test(workflow)],
  ["persisted canary must not write Google Sheet", /latestCanary\.writeSheet !== false/.test(workflow)],
  ["persisted canary must process exactly one product", /uniqueProductsProcessed\) !== 1/.test(workflow)],
  ["persisted canary must be clean", /latestCanary\.verified\) !== 1[\s\S]*?latestCanary\.missing\) !== 0[\s\S]*?latestCanary\.ambiguous\) !== 0[\s\S]*?latestCanary\.errors\) !== 0/.test(workflow)],
  ["workflow reports live Railway verification", /Live Railway \/api\/ready verification required before Shopify read-back: \\\`true\\\`/.test(workflow)],
  ["workflow reports persisted canary requirement", /Persisted clean one-product canary must exist in readiness: \\\`true\\\`/.test(workflow)],
  ["workflow passes the retry variable consumed by the script", /CANARY_READBACK_RETRIES:\s*["']?2["']?/.test(workflow)],
  ["deprecated retry variable is absent", !/CANARY_READBACK_MAX_RETRIES/.test(workflow)],
  ["script consumes CANARY_READBACK_RETRIES", /boundedInteger\("CANARY_READBACK_RETRIES"/.test(script)],
  ["read-back follows zero redirects", /maxRedirects:\s*0/.test(script)],
  ["read-back accepts only exact myshopify hostnames", /SHOPIFY_SHOP_DOMAIN must be an exact \*\.myshopify\.com hostname/.test(script)],
  ["read-back validates the product identity", /product\.id !== productId/.test(script)],
  ["read-back compares SKU", /SKU mismatch/.test(script)],
  ["read-back compares price", /Price mismatch/.test(script)],
  ["read-back requests variant pagination state", /pageInfo\s*\{\s*hasNextPage\s*\}/.test(script)],
  ["read-back rejects truncated variant sets", /Variant read-back was truncated after 250 variants/.test(script)],
  ["read-back reports complete variant-set observation", /completeVariantSetObserved:\s*!hasNextVariantPage/.test(script)],
  ["read-back requires exact variant count", /Variant count mismatch: expected exactly/.test(script)],
  ["read-back rejects duplicate Shopify variant IDs", /Shopify read-back returned duplicate variant IDs/.test(script)],
  ["read-back reports exact variant-set enforcement", /exactVariantSetRequired:\s*true/.test(script)],
  ["read-back requires unique matched variants", /Expected \$\{expected\.length\} unique matched variants/.test(script)],
  ["HTTP 403 remains blocked and never out-of-stock", /HTTP 403; this is not an out-of-stock result/.test(script)],
  ["authentication failure is explicit", /authentication failed with HTTP 401/.test(script)],
  ["retry is limited to throttling and server failures", /response\.status === 429 \|\| response\.status >= 500/.test(script)],
  ["script reports read-only mode", /readOnly:\s*true/.test(script)],
  ["workflow reports zero Shopify mutations", /Shopify mutations: \\`0\\`/.test(workflow)],
  ["workflow invokes only the read-back command", /npm run canary:readback/.test(workflow)],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

if (failed.length > 0) {
  throw new Error(`Shopify canary read-back safety contract failed: ${failed.map(([name]) => name).join(", ")}`);
}

console.log(JSON.stringify({
  ok: true,
  assertions: checks.length,
  exactVariantSetRequired: true,
  completeVariantSetRequired: true,
  canaryRevisionCheckoutPinned: true,
  canaryRevisionEqualityRequired: true,
  liveRailwayReadinessRequired: true,
  liveSupabaseTargetRequired: true,
  persistedCanaryRequired: true,
  shopifyMutations: 0,
  googleSheetWrites: 0,
  databaseWrites: 0,
  classification403: "blocked/unknown",
}, null, 2));
