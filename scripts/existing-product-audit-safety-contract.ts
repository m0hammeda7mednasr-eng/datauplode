import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const audit = read("scripts/shopify-existing-product-audit.ts");
const workflow = read(".github/workflows/shopify-existing-product-audit.yml");

const assertions: Array<[string, boolean]> = [
  [
    "existing-product audit is read-only GraphQL",
    /query ExistingProductAudit/.test(audit) && !/\bmutation\b/i.test(audit),
  ],
  ["existing-product audit disables redirects", /maxRedirects:\s*0/.test(audit)],
  [
    "existing-product audit accepts only direct myshopify hostnames",
    audit.includes("\\.myshopify\\.com$") &&
      audit.includes("SHOPIFY_SHOP_DOMAIN must be an exact *.myshopify.com hostname"),
  ],
  [
    "existing-product audit is bounded to fifty SKUs",
    /expected\.length > 50/.test(audit) && /limited to 50 SKUs per run/.test(audit),
  ],
  [
    "existing-product audit detects duplicate and mismatched products",
    /status = "duplicate"/.test(audit) &&
      /status = "product_mismatch"/.test(audit) &&
      /counts\.duplicate === 0 && counts\.product_mismatch === 0/.test(audit),
  ],
  [
    "existing-product audit requests Shopify pagination state",
    /productVariants\(first:\s*250,\s*query:\s*\$query\)/.test(audit) &&
      /pageInfo\s*\{\s*hasNextPage\s*\}/s.test(audit),
  ],
  [
    "existing-product audit fails closed on truncated Shopify results",
    /pageInfo\?\.hasNextPage === true/.test(audit) &&
      /uniqueness cannot be verified safely/.test(audit),
  ],
  [
    "existing-product audit declares complete result sets mandatory",
    /completeSearchResultsRequired:\s*true/.test(audit),
  ],
  [
    "existing-product audit classifies HTTP 403 as blocked",
    /HTTP 403; this is blocked access, not an out-of-stock result/.test(audit) &&
      /blocked_not_out_of_stock/.test(audit),
  ],
  ["existing-product audit reports read-only status", /readOnly:\s*true/.test(audit)],
  [
    "existing-product audit workflow is manual-only",
    /on:\s*\n\s*workflow_dispatch:/.test(workflow) &&
      !/^\s*(push|pull_request|schedule):/m.test(workflow),
  ],
  [
    "existing-product audit workflow requires an exact revision input",
    /audit_revision:\s*\n\s*description:/.test(workflow) &&
      /AUDIT_REVISION:\s*\$\{\{ inputs\.audit_revision \}\}/.test(workflow) &&
      /\^\[0-9a-fA-F\]\{40\}\$/.test(workflow),
  ],
  [
    "existing-product audit checks out the requested revision explicitly",
    /uses:\s*actions\/checkout@v4[\s\S]*?ref:\s*\$\{\{ inputs\.audit_revision \}\}/.test(workflow) &&
      /fetch-depth:\s*1/.test(workflow),
  ],
  [
    "existing-product audit verifies checkout SHA before Shopify access",
    /actual_revision="\$\(git rev-parse HEAD\)"/.test(workflow) &&
      /actual_revision.*expected_revision/.test(workflow) &&
      /AUDIT_CHECKED_OUT_REVISION=/.test(workflow),
  ],
  [
    "existing-product audit summary records requested and checked-out revisions",
    /Requested revision:/.test(workflow) && /Checked-out revision:/.test(workflow),
  ],
  [
    "existing-product audit workflow has read-only repository permissions",
    /permissions:\s*\n\s*contents:\s*read/.test(workflow) && !/contents:\s*write/.test(workflow),
  ],
  [
    "existing-product audit workflow supplies no write gates",
    !/(CATALOG_AUDIT_WRITE_TOKEN|CATALOG_AUDIT_WRITE_ENABLED|CATALOG_AUDIT_SHEET_WRITE_ENABLED|SYNC_RUNTIME_WRITE_ENABLED)/.test(
      workflow,
    ),
  ],
  [
    "existing-product audit workflow runs only the read-only audit command",
    /run:\s*npm run shopify:audit-existing/.test(workflow) &&
      !/npm run (sync|import|inventory|catalog)/.test(workflow),
  ],
  [
    "existing-product audit workflow documents zero mutations and blocked 403",
    /Shopify mutations:\s*\\`0\\`/.test(workflow) &&
      /HTTP 403 classification: blocked, never out-of-stock/.test(workflow),
  ],
];

const failed = assertions.filter(([, ok]) => !ok);
for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  console.error(`Existing-product audit safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Existing-product audit safety contract passed: ${assertions.length}/${assertions.length}`);
