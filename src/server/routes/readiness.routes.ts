import { Router } from "express";
import { prisma } from "../db.js";

const router = Router();

function configured(name: string) {
  const value = String(process.env[name] || "").trim();
  return Boolean(value && !/^(replace|your_|my_)/i.test(value));
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

router.get(["/ready", "/sync/readiness"], async (_req, res) => {
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
    writeGateEnabled:
      String(process.env.CATALOG_AUDIT_WRITE_ENABLED || "").toLowerCase() === "true",
    writeTokenConfigured: configured("CATALOG_AUDIT_WRITE_TOKEN"),
  };

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
      database: {
        ok: true,
        target: databaseTarget(),
      },
      configuration: {
        ...configuration,
        safeMode:
          !configuration.writeGateEnabled || !configuration.writeTokenConfigured,
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
      database: {
        ok: false,
        target: databaseTarget(),
      },
      configuration: {
        ...configuration,
        safeMode:
          !configuration.writeGateEnabled || !configuration.writeTokenConfigured,
      },
      error: String(error?.message || "Database readiness check failed"),
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
