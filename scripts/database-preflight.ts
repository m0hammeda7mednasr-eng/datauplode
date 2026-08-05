import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const REQUIRED_TABLES = [
  "SyncJob",
  "ImportBatch",
  "ShopifyConnection",
  "SourceProduct",
  "SourceVariant",
  "ShopifyProduct",
  "ShopifyVariant",
] as const;

function databaseSummary(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return {
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port || "5432",
      database: url.pathname.replace(/^\//, "") || "unknown",
      supabase: url.hostname.includes("supabase"),
      sslMode: url.searchParams.get("sslmode") || "unspecified",
      pgbouncer: url.searchParams.get("pgbouncer") || "unspecified",
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

  if (target.supabase && target.sslMode !== "require") {
    throw new Error(
      "Supabase DATABASE_URL must include sslmode=require before production deployment.",
    );
  }

  await prisma.$queryRaw`SELECT 1`;

  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `;
  const existing = new Set(tables.map((entry) => entry.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));

  if (missing.length) {
    throw new Error(
      `Database schema is incomplete. Missing required tables: ${missing.join(", ")}`,
    );
  }

  const [pendingJobs, runningJobs, failedJobs, auditRuns] = await Promise.all([
    prisma.syncJob.count({ where: { status: "pending" } }),
    prisma.syncJob.count({ where: { status: "running" } }),
    prisma.syncJob.count({ where: { status: "failed" } }),
    prisma.importBatch.count({ where: { target: "catalog_audit" } }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        database: target,
        schema: {
          requiredTables: REQUIRED_TABLES.length,
          foundRequiredTables: REQUIRED_TABLES.length - missing.length,
          missingTables: missing,
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
