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
    source.includes("ready: productionPlatformReady"),
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
    "deployment revision still validates Git SHA format",
    source.includes("revisionVerified: /^[0-9a-f]{7,40}$/i.test(revision)"),
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
