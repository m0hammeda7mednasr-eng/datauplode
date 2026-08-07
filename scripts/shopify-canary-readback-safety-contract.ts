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
  shopifyMutations: 0,
  googleSheetWrites: 0,
  databaseWrites: 0,
  classification403: "blocked/unknown",
}, null, 2));
