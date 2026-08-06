import { Router } from "express";
import { prisma } from "../db.js";

const router = Router();

function configured(name: string) {
  const value = String(process.env[name] || "").trim();
  return Boolean(value && !/^(replace|your_|my_)/i.test(value));
}

function enabled(name: string) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function databaseTarget() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) return "missing";
  try {
    const url = new URL(value);
    if (url.hostname.includes("supabase")) return "supabase";
    return url.hostname || "configured";
  } catch {
    return "invalid";
  }
}

function deploymentMetadata() {
  const revision = String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GIT_COMMIT_SHA ||
      "",
  ).trim();
  const branch = String(
    process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "",
  ).trim();

  return {
    revision: revision || "unknown",
    branch: branch || "unknown",
    revisionVerified: /^[0-9a-f]{7,40}$/i.test(revision),
  };
}

router.get(["/ready", "/sync/readiness"], async (_req, res) => {
  const runtimeWriteGateEnabled = enabled("SYNC_RUNTIME_WRITE_ENABLED");
  const inventoryAutostartConfigured = enabled("SYNC_INVENTORY_AUTOSTART");
  const jobRecoveryConfigured = enabled("SYNC_JOB_RECOVERY_ENABLED");
  const sheetImportAutostartConfigured = enabled("SYNC_SHEET_IMPORT_AUTOSTART_ENABLED");

  const configuration = {
    database: configured("DATABASE_URL"),
    encryptionKey: configured("ENCRYPTION_KEY"),
    shopifyDomain: configured("SHOPIFY_SHOP_DOMAIN"),
    shopifyToken: configured("SHOPIFY_ACCESS_TOKEN"),
    googleSheet: configured("CATALOG_AUDIT_SHEET_URL"),
    googleWriter:
      configured("GOOGLE_SHEETS_ACCESS_TOKEN") ||
      (configured("GOOGLE_SERVICE_ACCOUNT_EMAIL") &&
        (configured("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") ||
          configured("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64"))),
    catalogWriteGateEnabled: enabled("CATALOG_AUDIT_WRITE_ENABLED"),
    catalogWriteTokenConfigured: configured("CATALOG_AUDIT_WRITE_TOKEN"),
    catalogSheetWriteGateEnabled: enabled("CATALOG_AUDIT_SHEET_WRITE_ENABLED"),
    catalogCanaryMaxRows: Math.max(
      1,
      Math.min(5, Number(process.env.CATALOG_AUDIT_CANARY_MAX_ROWS || 1) || 1),
    ),
    runtimeWriteGateEnabled,
    inventoryAutostartConfigured,
    inventoryAutostartEnabled: runtimeWriteGateEnabled && inventoryAutostartConfigured,
    jobRecoveryConfigured,
    jobRecoveryEnabled: runtimeWriteGateEnabled && jobRecoveryConfigured,
    sheetImportAutostartConfigured,
    sheetImportAutostartEnabled:
      runtimeWriteGateEnabled && sheetImportAutostartConfigured,
  };

  const safeMode =
    !configuration.runtimeWriteGateEnabled ||
    !configuration.catalogWriteGateEnabled ||
    !configuration.catalogWriteTokenConfigured;
  const deployment = deploymentMetadata();

  try {
    await prisma.$queryRaw`SELECT 1`;

    const [pendingJobs, runningJobs, failedJobs, latestAudit] = await Promise.all([
      prisma.syncJob.count({ where: { status: "pending" } }),
      prisma.syncJob.count({ where: { status: "running" } }),
      prisma.syncJob.count({ where: { status: "failed" } }),
      prisma.importBatch.findFirst({
        where: { target: "catalog_audit" },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true, updatedAt: true },
      }),
    ]);

    const productionMinimumReady =
      configuration.database &&
      configuration.encryptionKey &&
      configuration.shopifyDomain &&
      configuration.shopifyToken &&
      configuration.googleSheet;

    res.status(productionMinimumReady ? 200 : 503).json({
      ok: productionMinimumReady,
      service: "syncly-api",
      deployment,
      database: {
        ok: true,
        target: databaseTarget(),
      },
      configuration: {
        ...configuration,
        safeMode,
      },
      jobs: {
        pending: pendingJobs,
        running: runningJobs,
        failed: failedJobs,
      },
      latestCatalogAudit: latestAudit,
      checkedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      ok: false,
      service: "syncly-api",
      deployment,
      database: {
        ok: false,
        target: databaseTarget(),
      },
      configuration: {
        ...configuration,
        safeMode,
      },
      error: String(error?.message || "Database readiness check failed"),
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
