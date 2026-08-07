import fs from "node:fs";
import path from "node:path";

const readinessPath = path.resolve("src/server/routes/readiness.routes.ts");
const source = fs.readFileSync(readinessPath, "utf8");

const checks: Array<[string, boolean]> = [
  [
    "production readiness requires Supabase target",
    source.includes('databaseTargetValue === "supabase"'),
  ],
  [
    "production readiness requires a verified deployment revision",
    source.includes("deployment.revisionVerified === true"),
  ],
  [
    "platform readiness participates in productionMinimumReady",
    /productionMinimumReady\s*=([\s\S]*?)productionPlatformReady/.test(source),
  ],
  [
    "non-production remains usable without Railway/Supabase enforcement",
    source.includes("!productionEnvironment ||"),
  ],
  [
    "readiness reports production environment state",
    source.includes("productionEnvironment,"),
  ],
  [
    "readiness reports whether Supabase is required",
    source.includes("supabaseRequired: productionEnvironment"),
  ],
  [
    "readiness reports whether Railway revision is required",
    source.includes("railwayRevisionRequired: productionEnvironment"),
  ],
  [
    "readiness reports platform ready state",
    source.includes("ready: productionPlatformReady && (!productionEnvironment || productionWriteSafetyReady)"),
  ],
  [
    "database target is computed once for consistent reporting",
    source.includes("const databaseTargetValue = databaseTarget();"),
  ],
  [
    "database target report uses the checked value",
    source.includes("target: databaseTargetValue"),
  ],
  [
    "failure responses never claim platform readiness",
    source.includes("ready: false"),
  ],
  [
    "deployment revision requires a full 40-character Git SHA",
    source.includes("revisionVerified: /^[0-9a-f]{40}$/i.test(revision)"),
  ],
  [
    "short Git SHA readiness remains forbidden",
    !source.includes("revisionVerified: /^[0-9a-f]{7,40}$/i.test(revision)"),
  ],
  [
    "readiness reports the hard one-product canary limit",
    source.includes("catalogCanaryMaxRows: 1"),
  ],
  [
    "readiness does not advertise a configurable wider canary",
    !source.includes("process.env.CATALOG_AUDIT_CANARY_MAX_ROWS || 1"),
  ],
  [
    "readiness only trusts official Supabase hostname suffixes",
    source.includes('endsWith(".supabase.com")') && source.includes('endsWith(".supabase.co")'),
  ],
  [
    "readiness forbids substring-only Supabase hostname detection",
    !source.includes('hostname.includes("supabase")'),
  ],
  [
    "production readiness requires write safety",
    source.includes("(!productionEnvironment || productionWriteSafetyReady)"),
  ],
  [
    "production write safety requires catalog dry run",
    source.includes("catalogAuditDryRunConfigured;") &&
      source.includes('enabled("CATALOG_AUDIT_DRY_RUN")'),
  ],
  [
    "production write safety requires all broad write and autostart gates closed",
    source.includes("!runtimeWriteGateEnabled") &&
      source.includes("!inventoryAutostartConfigured") &&
      source.includes("!jobRecoveryConfigured") &&
      source.includes("!sheetImportAutostartConfigured") &&
      source.includes("!configuration.catalogWriteGateEnabled") &&
      source.includes("!configuration.catalogSheetWriteGateEnabled"),
  ],
  [
    "readiness exposes write safety state for monitoring",
    source.includes("writeSafetyReady: productionWriteSafetyReady"),
  ],
  [
    "readiness declares safe mode mandatory in production",
    source.includes("safeModeRequired: productionEnvironment"),
  ],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  for (const [name] of failed) {
    console.error(`FAIL: ${name}`);
  }
  process.exit(1);
}

for (const [name] of checks) {
  console.log(`PASS: ${name}`);
}
console.log(
  JSON.stringify(
    {
      assertions: checks.length,
      databaseWrites: 0,
      shopifyMutations: 0,
      googleSheetWrites: 0,
    },
    null,
    2,
  ),
);
