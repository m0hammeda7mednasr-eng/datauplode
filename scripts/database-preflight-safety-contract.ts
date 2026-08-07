import fs from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[database-preflight-safety-contract] ${message}`);
}

const root = process.cwd();
const preflightPath = path.join(root, "scripts/database-preflight.ts");
const schemaPath = path.join(root, "prisma/schema.prisma");
const preflight = fs.readFileSync(preflightPath, "utf8");
const schema = fs.readFileSync(schemaPath, "utf8");

const requiredColumnsMatch = preflight.match(
  /const REQUIRED_COLUMNS = \{([\s\S]*?)\n\} as const;/,
);
assert(requiredColumnsMatch, "REQUIRED_COLUMNS declaration is missing or unreadable.");

const requiredColumnsBody = requiredColumnsMatch[1];
// Accept both compact one-line arrays and formatted multi-line arrays. The former
// is used by SyncJob today; requiring a newline before `]` made the parser consume
// following tables and report false duplicate columns.
const tableEntries = [
  ...requiredColumnsBody.matchAll(
    /(?:^|\n)\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*\[([\s\S]*?)\],/g,
  ),
];
assert(tableEntries.length > 0, "No required table definitions were found.");

const required = new Map<string, string[]>();
for (const entry of tableEntries) {
  const table = entry[1];
  const columns = [...entry[2].matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)].map(
    (match) => match[1],
  );
  assert(columns.length > 0, `${table} has no required columns.`);
  assert(new Set(columns).size === columns.length, `${table} contains duplicate required columns.`);
  assert(!required.has(table), `${table} is defined more than once in REQUIRED_COLUMNS.`);
  required.set(table, columns);
}

const schemaModels = new Map<string, Set<string>>();
for (const modelMatch of schema.matchAll(/model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g)) {
  const model = modelMatch[1];
  const fields = new Set<string>();
  for (const line of modelMatch[2].split("\n")) {
    const fieldMatch = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s+/);
    if (fieldMatch) fields.add(fieldMatch[1]);
  }
  schemaModels.set(model, fields);
}

const missingModels: string[] = [];
const staleColumns: string[] = [];
for (const [table, columns] of required) {
  const modelFields = schemaModels.get(table);
  if (!modelFields) {
    missingModels.push(table);
    continue;
  }
  for (const column of columns) {
    if (!modelFields.has(column)) staleColumns.push(`${table}.${column}`);
  }
}

assert(missingModels.length === 0, `Required models missing from Prisma schema: ${missingModels.join(", ")}`);
assert(
  staleColumns.length === 0,
  `Database preflight references columns missing from Prisma schema: ${staleColumns.join(", ")}`,
);

assert(
  preflight.includes("FROM information_schema.columns"),
  "Preflight must verify columns through information_schema.columns.",
);
assert(
  preflight.includes("Database schema is stale. Missing required columns"),
  "Preflight must fail closed when required columns are missing.",
);
assert(
  preflight.includes('target.sslMode !== "require"'),
  "Supabase preflight must require sslmode=require.",
);
assert(
  preflight.includes('target.port !== "5432"'),
  "Supabase preflight must require the approved Session pooler port 5432.",
);
assert(
  preflight.includes("connection_limit between 1 and 20"),
  "Supabase preflight must bound connection_limit.",
);
assert(
  preflight.includes("pool_timeout between 1 and 60 seconds"),
  "Supabase preflight must bound pool_timeout.",
);

const requiredColumnCount = [...required.values()].reduce((sum, columns) => sum + columns.length, 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      requiredModels: required.size,
      requiredColumns: requiredColumnCount,
      missingModels,
      staleColumns,
      supabaseChecks: 4,
      databaseWrites: 0,
      shopifyMutations: 0,
      googleSheetWrites: 0,
    },
    null,
    2,
  ),
);
