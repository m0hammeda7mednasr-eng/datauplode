import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/production-smoke.yml", "utf8");

const assertions: Array<[string, boolean]> = [
  [
    "production smoke target is sourced only from the Railway repository secret",
    /SMOKE_BASE_URL:\s*\$\{\{\s*secrets\.RAILWAY_SMOKE_BASE_URL\s*\}\}/.test(workflow),
  ],
  [
    "production smoke workflow exposes no base_url dispatch override",
    !/^\s*base_url\s*:/m.test(workflow) && !/inputs\.base_url/.test(workflow),
  ],
  [
    "production smoke fails closed when the Railway target secret is missing",
    /Missing Railway target URL\. Configure the RAILWAY_SMOKE_BASE_URL repository secret\./.test(workflow),
  ],
  [
    "production smoke still requires HTTPS for the locked target",
    /Production smoke target must use HTTPS\./.test(workflow),
  ],
  [
    "production smoke summary documents that target overrides are disabled",
    /workflow URL overrides are disabled/.test(workflow),
  ],
  [
    "production smoke independently verifies exact Supabase project binding",
    /projectRefPinned !== true/.test(workflow) &&
      /projectRefMatched !== true/.test(workflow) &&
      /database\?\.target !== 'supabase'/.test(workflow),
  ],
  [
    "production smoke independently verifies exact Railway revision",
    /revisionVerified !== true/.test(workflow) &&
      /actualRevision !== expectedRevision/.test(workflow),
  ],
  [
    "production smoke independently verifies write safety",
    /platform\?\.writeSafetyReady !== true/.test(workflow) &&
      /platform\?\.ready !== true/.test(workflow),
  ],
  [
    "production smoke requires recovered-job Shopify write gate closed",
    /jobRecoveryShopifyWritesConfigured/.test(workflow) &&
      /mustBeFalse/.test(workflow),
  ],
  [
    "production smoke requires a quiescent queue",
    /\['pending', 'running', 'staleRunning', 'recentFailed'\]/.test(workflow) &&
      /Number\(jobs\[key\]\) !== 0/.test(workflow),
  ],
  [
    "production smoke supplies no Shopify mutation credential",
    !/SHOPIFY_ACCESS_TOKEN:\s*\$\{\{/.test(workflow) &&
      !/CATALOG_AUDIT_WRITE_TOKEN:\s*\$\{\{/.test(workflow),
  ],
  [
    "production smoke summary documents zero-write preconditions",
    /Recovered-job Shopify write gate must be closed/.test(workflow) &&
      /No Shopify write token is supplied/.test(workflow),
  ],
];

const failed = assertions.filter(([, ok]) => !ok);
for (const [name, ok] of assertions) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

if (failed.length > 0) {
  console.error(`Production smoke target safety contract failed: ${failed.length}/${assertions.length}`);
  process.exit(1);
}

console.log(`Production smoke target safety contract passed: ${assertions.length}/${assertions.length}`);
