import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const REQUIRED_COLUMNS = {
  SyncJob: ["id", "type", "status", "payload", "result", "startedAt", "completedAt", "createdAt"],
  ImportBatch: ["id", "status", "productIds", "target", "payloadJson", "createdAt", "updatedAt"],
  ShopifyConnection: [
    "id",
    "shopDomain",
    "clientId",
    "clientSecretEnc",
    "accessTokenEnc",
    "scopes",
    "isConnected",
    "connectedAt",
    "oauthState",
    "oauthStateExpiresAt",
    "createdAt",
    "updatedAt",
  ],
  SourceProduct: [
    "id",
    "supplierId",
    "url",
    "title",
    "currency",
    "price",
    "syncStatus",
    "lastScrapedAt",
    "createdAt",
    "updatedAt",
  ],
  SourceVariant: [
    "id",
    "sourceProductId",
    "sourceVariantId",
    "sku",
    "available",
    "stockStatus",
    "createdAt",
    "updatedAt",
  ],
  ShopifyProduct: [
    "id",
    "sourceProductId",
    "shopifyId",
    "status",
    "syncEnabled",
    "syncPrice",
    "syncInventory",
    "syncImages",
    "outOfStockAction",
    "createdAt",
    "updatedAt",
  ],
  ShopifyVariant: [
    "id",
    "shopifyProductId",
    "sourceVariantId",
    "shopifyId",
    "sku",
    "price",
    "createdAt",
    "updatedAt",
  ],
} as const;

const REQUIRED_TABLES = Object.keys(REQUIRED_COLUMNS) as Array<keyof typeof REQUIRED_COLUMNS>;

function boundedInteger(value: string | null, minimum: number, maximum: number) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function databaseSummary(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const isSupabase = url.hostname.includes("supabase");
    return {
      protocol: url.protocol.replace(":", ""),
      target: isSupabase ? "supabase" : "configured",
      port: url.port || "5432",
      supabase: isSupabase,
      sslMode: url.searchParams.get("sslmode") || "unspecified",
      connectionLimit: boundedInteger(url.searchParams.get("connection_limit"), 1, 20),
      poolTimeoutSeconds: boundedInteger(url.searchParams.get("pool_timeout"), 1, 60),
    };
  } catch {
    return null;
  }
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database preflight.");
  }

  const target = databaseSummary(databaseUrl);
  if (!target || !["postgres", "postgresql"].includes(target.protocol)) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (target.supabase) {
    if (target.sslMode !== "require") {
      throw new Error(
        "Supabase DATABASE_URL must include sslmode=require before production deployment.",
      );
    }
    if (target.port !== "5432") {
      throw new Error(
        "Railway must use the Supabase Session pooler on port 5432; transaction pooler port 6543 is not approved for this long-running service.",
      );
    }
    if (target.connectionLimit === null) {
      throw new Error(
        "Supabase DATABASE_URL must include connection_limit between 1 and 20.",
      );
    }
    if (target.poolTimeoutSeconds === null) {
      throw new Error(
        "Supabase DATABASE_URL must include pool_timeout between 1 and 60 seconds.",
      );
    }
  }

  await prisma.$queryRaw`SELECT 1`;

  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `;
  const existingTables = new Set(tables.map((entry) => entry.table_name));
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));

  if (missingTables.length) {
    throw new Error(
      `Database schema is incomplete. Missing required tables: ${missingTables.join(", ")}`,
    );
  }

  const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'SyncJob',
        'ImportBatch',
        'ShopifyConnection',
        'SourceProduct',
        'SourceVariant',
        'ShopifyProduct',
        'ShopifyVariant'
      )
  `;

  const existingColumns = new Map<string, Set<string>>();
  for (const entry of columns) {
    const tableColumns = existingColumns.get(entry.table_name) || new Set<string>();
    tableColumns.add(entry.column_name);
    existingColumns.set(entry.table_name, tableColumns);
  }

  const missingColumns = REQUIRED_TABLES.flatMap((table) =>
    REQUIRED_COLUMNS[table]
      .filter((column) => !existingColumns.get(table)?.has(column))
      .map((column) => `${table}.${column}`),
  );

  if (missingColumns.length) {
    throw new Error(
      `Database schema is stale. Missing required columns: ${missingColumns.join(", ")}`,
    );
  }

  const [pendingJobs, runningJobs, failedJobs, auditRuns] = await Promise.all([
    prisma.syncJob.count({ where: { status: "pending" } }),
    prisma.syncJob.count({ where: { status: "running" } }),
    prisma.syncJob.count({ where: { status: "failed" } }),
    prisma.importBatch.count({ where: { target: "catalog_audit" } }),
  ]);

  const requiredColumnCount = REQUIRED_TABLES.reduce(
    (total, table) => total + REQUIRED_COLUMNS[table].length,
    0,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        database: target,
        schema: {
          requiredTables: REQUIRED_TABLES.length,
          foundRequiredTables: REQUIRED_TABLES.length - missingTables.length,
          missingTables,
          requiredColumns: requiredColumnCount,
          foundRequiredColumns: requiredColumnCount - missingColumns.length,
          missingColumns,
        },
        jobs: {
          pending: pendingJobs,
          running: runningJobs,
          failed: failedJobs,
        },
        catalogAuditRuns: auditRuns,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(`[database-preflight] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
