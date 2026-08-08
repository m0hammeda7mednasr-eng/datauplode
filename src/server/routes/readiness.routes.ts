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

function readinessTimeoutMs() {
  const parsed = Number(process.env.READINESS_DATABASE_TIMEOUT_MS || 5000);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(1000, Math.min(15000, Math.trunc(parsed)));
}

function staleRunningJobMinutes() {
  const parsed = Number(process.env.SYNC_JOB_STALE_RUNNING_MINUTES || 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(5, Math.min(1440, Math.trunc(parsed)));
}

function recentFailedJobMinutes() {
  const parsed = Number(process.env.SYNC_JOB_RECENT_FAILURE_MINUTES || 60);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(5, Math.min(10080, Math.trunc(parsed)));
}

function canaryDryRunMaxAgeMinutes() {
  const parsed = Number(process.env.CATALOG_AUDIT_CANARY_DRY_RUN_MAX_AGE_MINUTES || 30);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(120, Math.max(1, Math.floor(parsed)));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("READINESS_DATABASE_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isSupabaseHost(host: string) {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, "");
  return (
    normalizedHost.endsWith(".supabase.com") ||
    normalizedHost.endsWith(".supabase.co")
  );
}

function deriveSupabaseProjectRef(url: URL) {
  const host = url.hostname.trim().toLowerCase().replace(/\.$/, "");
  const direct = host.match(/^db\.([a-z0-9-]+)\.supabase\.(?:co|com)$/);
  if (direct) return direct[1];

  if (/\.pooler\.supabase\.(?:co|com)$/.test(host)) {
    const username = decodeURIComponent(url.username || "").trim().toLowerCase();
    const separator = username.lastIndexOf(".");
    if (separator >= 0 && separator < username.length - 1) {
      return username.slice(separator + 1);
    }
  }

  return null;
}

function databaseBinding() {
  const value = String(process.env.DATABASE_URL || "").trim();
  const expectedProjectRef = String(process.env.SUPABASE_PROJECT_REF || "")
    .trim()
    .toLowerCase();
  const projectRefPinned = Boolean(expectedProjectRef);

  if (!value) {
    return {
      target: "missing",
      projectRefPinned,
      projectRefMatched: false,
    };
  }

  try {
    const url = new URL(value);
    if (!isSupabaseHost(url.hostname)) {
      return {
        target: "configured",
        projectRefPinned,
        projectRefMatched: false,
      };
    }

    const databaseProjectRef = deriveSupabaseProjectRef(url);
    return {
      target: "supabase",
      projectRefPinned,
      projectRefMatched: Boolean(
        projectRefPinned &&
          databaseProjectRef &&
          databaseProjectRef === expectedProjectRef,
      ),
    };
  } catch {
    return {
      target: "invalid",
      projectRefPinned,
      projectRefMatched: false,
    };
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
    revisionVerified: /^[0-9a-f]{40}$/i.test(revision),
  };
}

type CatalogAuditRun = {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  payloadJson: string | null;
};

function catalogAuditObservation(run: CatalogAuditRun | undefined) {
  if (!run) return null;
  let payload: any = {};
  try {
    payload = JSON.parse(run.payloadJson || "{}");
  } catch {
    payload = {};
  }
  const summary = payload?.summary || {};
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const provenance =
    payload?.provenance && typeof payload.provenance === "object"
      ? payload.provenance
      : {};
  const shopifyProductIds = [
    ...new Set(
      results
        .map((result: any) => String(result?.shopifyProductId || "").trim())
        .filter((id: string) => /^gid:\/\/shopify\/Product\/\d+$/.test(id)),
    ),
  ];
  const dryRunBatchId = String(provenance?.dryRunBatchId || "").trim() || null;
  const provenanceShopifyProductIdRaw = String(
    provenance?.shopifyProductId || "",
  ).trim();
  const provenanceShopifyProductId = /^gid:\/\/shopify\/Product\/\d+$/.test(
    provenanceShopifyProductIdRaw,
  )
    ? provenanceShopifyProductIdRaw
    : null;
  const canaryProvenanceValid =
    summary.dryRun === false
      ? Boolean(
          dryRunBatchId &&
            shopifyProductIds.length === 1 &&
            provenanceShopifyProductId === shopifyProductIds[0],
        )
      : null;

  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: payload?.completedAt || null,
    dryRun: summary.dryRun === true,
    writeSheet: summary.writeSheet === true,
    uniqueProductsProcessed: Number(summary.uniqueProductsProcessed || 0),
    verified: Number(summary.verified || 0),
    missing: Number(summary.missing || 0),
    ambiguous: Number(summary.ambiguous || 0),
    errors: Number(summary.errors || 0),
    shopifyProductIds,
    shopifyProductId: shopifyProductIds.length === 1 ? shopifyProductIds[0] : null,
    dryRunBatchId,
    provenanceShopifyProductId,
    canaryProvenanceValid,
  };
}

function dryRunAgeMinutes(run: ReturnType<typeof catalogAuditObservation>, nowMs = Date.now()) {
  if (!run) return null;
  const createdAtMs = new Date(run.createdAt).getTime();
  const ageMs = nowMs - createdAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return ageMs / 60_000;
}

function isCanaryReadyDryRun(
  run: ReturnType<typeof catalogAuditObservation>,
  maxAgeMinutes: number,
  nowMs = Date.now(),
) {
  const ageMinutes = dryRunAgeMinutes(run, nowMs);
  return Boolean(
    run &&
      ageMinutes !== null &&
      ageMinutes <= maxAgeMinutes &&
      run.status === "COMPLETED" &&
      run.dryRun === true &&
      run.writeSheet === false &&
      run.uniqueProductsProcessed === 1 &&
      run.verified === 1 &&
      run.missing === 0 &&
      run.ambiguous === 0 &&
      run.errors === 0 &&
      run.shopifyProductIds.length === 1,
  );
}

router.get(["/ready", "/sync/readiness"], async (_req, res) => {
  const runtimeWriteGateEnabled = enabled("SYNC_RUNTIME_WRITE_ENABLED");
  const inventoryAutostartConfigured = enabled("SYNC_INVENTORY_AUTOSTART");
  const jobRecoveryConfigured = enabled("SYNC_JOB_RECOVERY_ENABLED");
  const jobRecoveryShopifyWritesConfigured = enabled(
    "SYNC_JOB_RECOVERY_SHOPIFY_WRITES_ENABLED",
  );
  const sheetImportAutostartConfigured = enabled("SYNC_SHEET_IMPORT_AUTOSTART_ENABLED");
  const catalogAuditDryRunConfigured = enabled("CATALOG_AUDIT_DRY_RUN");
  const databaseTimeoutMs = readinessTimeoutMs();
  const staleJobThresholdMinutes = staleRunningJobMinutes();
  const recentFailureThresholdMinutes = recentFailedJobMinutes();
  const canaryDryRunMaxAge = canaryDryRunMaxAgeMinutes();
  const staleJobCutoff = new Date(Date.now() - staleJobThresholdMinutes * 60_000);
  const recentFailureCutoff = new Date(Date.now() - recentFailureThresholdMinutes * 60_000);

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
    catalogAuditDryRunConfigured,
    catalogCanaryMaxRows: 1,
    runtimeWriteGateEnabled,
    inventoryAutostartConfigured,
    inventoryAutostartEnabled: runtimeWriteGateEnabled && inventoryAutostartConfigured,
    jobRecoveryConfigured,
    jobRecoveryShopifyWritesConfigured,
    jobRecoveryEnabled:
      runtimeWriteGateEnabled &&
      jobRecoveryConfigured &&
      jobRecoveryShopifyWritesConfigured,
    sheetImportAutostartConfigured,
    sheetImportAutostartEnabled:
      runtimeWriteGateEnabled && sheetImportAutostartConfigured,
  };

  const safeMode =
    !configuration.runtimeWriteGateEnabled ||
    !configuration.catalogWriteGateEnabled ||
    !configuration.catalogWriteTokenConfigured;
  const deployment = deploymentMetadata();
  const databaseBindingValue = databaseBinding();
  const databaseTargetValue = databaseBindingValue.target;
  const productionEnvironment =
    String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const productionPlatformReady =
    !productionEnvironment ||
    (databaseTargetValue === "supabase" &&
      databaseBindingValue.projectRefPinned === true &&
      databaseBindingValue.projectRefMatched === true &&
      deployment.revisionVerified === true);
  const productionWriteSafetyReady =
    !runtimeWriteGateEnabled &&
    !inventoryAutostartConfigured &&
    !jobRecoveryConfigured &&
    !jobRecoveryShopifyWritesConfigured &&
    !sheetImportAutostartConfigured &&
    !configuration.catalogWriteGateEnabled &&
    !configuration.catalogSheetWriteGateEnabled &&
    catalogAuditDryRunConfigured;
  const startedAt = Date.now();

  try {
    const [pendingJobs, runningJobs, failedJobs, recentFailedJobs, staleRunningJobs, recentAudits] = await withTimeout(
      Promise.all([
        prisma.$queryRaw`SELECT 1`.then(() => prisma.syncJob.count({ where: { status: "pending" } })),
        prisma.syncJob.count({ where: { status: "running" } }),
        prisma.syncJob.count({ where: { status: "failed" } }),
        prisma.syncJob.count({
          where: {
            status: "failed",
            OR: [
              { completedAt: { gte: recentFailureCutoff } },
              { completedAt: null, createdAt: { gte: recentFailureCutoff } },
            ],
          },
        }),
        prisma.syncJob.count({
          where: {
            status: "running",
            OR: [{ startedAt: null }, { startedAt: { lt: staleJobCutoff } }],
          },
        }),
        prisma.importBatch.findMany({
          where: { target: "catalog_audit" },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            payloadJson: true,
          },
        }),
      ]),
      databaseTimeoutMs,
    );

    const observedAudits = recentAudits.map((run) => catalogAuditObservation(run));
    const latestCatalogAudit = observedAudits[0] || null;
    const latestDryRun = observedAudits.find((run) => run?.dryRun === true) || null;
    const latestCanary = observedAudits.find((run) => run?.dryRun === false) || null;
    const latestDryRunAgeMinutes = dryRunAgeMinutes(latestDryRun);
    const latestDryRunCanaryReady = isCanaryReadyDryRun(latestDryRun, canaryDryRunMaxAge);
    const latestDryRunExpired = Boolean(
      latestDryRun &&
        (latestDryRunAgeMinutes === null || latestDryRunAgeMinutes > canaryDryRunMaxAge),
    );

    const productionMinimumReady =
      configuration.database &&
      configuration.encryptionKey &&
      configuration.shopifyDomain &&
      configuration.shopifyToken &&
      configuration.googleSheet &&
      productionPlatformReady &&
      (!productionEnvironment || productionWriteSafetyReady);

    res.status(productionMinimumReady ? 200 : 503).json({
      ok: productionMinimumReady,
      service: "syncly-api",
      deployment,
      database: {
        ok: true,
        target: databaseTargetValue,
        projectRefPinned: databaseBindingValue.projectRefPinned,
        projectRefMatched: databaseBindingValue.projectRefMatched,
        latencyMs: Date.now() - startedAt,
        timeoutMs: databaseTimeoutMs,
      },
      platform: {
        productionEnvironment,
        supabaseRequired: productionEnvironment,
        supabaseProjectPinRequired: productionEnvironment,
        railwayRevisionRequired: productionEnvironment,
        safeModeRequired: productionEnvironment,
        writeSafetyReady: productionWriteSafetyReady,
        ready: productionPlatformReady && (!productionEnvironment || productionWriteSafetyReady),
      },
      configuration: {
        ...configuration,
        safeMode,
      },
      jobs: {
        pending: pendingJobs,
        running: runningJobs,
        failed: failedJobs,
        recentFailed: recentFailedJobs,
        recentFailureThresholdMinutes,
        staleRunning: staleRunningJobs,
        staleThresholdMinutes: staleJobThresholdMinutes,
      },
      rollout: {
        recentAuditWindow: observedAudits.length,
        latestDryRun,
        latestDryRunAgeMinutes,
        latestDryRunMaxAgeMinutes: canaryDryRunMaxAge,
        latestDryRunExpired,
        latestDryRunCanaryReady,
        latestCanary,
      },
      latestCatalogAudit,
      checkedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    const failureCode =
      String(error?.message || "") === "READINESS_DATABASE_TIMEOUT"
        ? "DATABASE_TIMEOUT"
        : "DATABASE_UNAVAILABLE";
    console.error("Readiness database check failed", {
      failureCode,
      latencyMs: Date.now() - startedAt,
    });

    res.status(503).json({
      ok: false,
      service: "syncly-api",
      deployment,
      database: {
        ok: false,
        target: databaseTargetValue,
        projectRefPinned: databaseBindingValue.projectRefPinned,
        projectRefMatched: databaseBindingValue.projectRefMatched,
        latencyMs: Date.now() - startedAt,
        timeoutMs: databaseTimeoutMs,
        failureCode,
      },
      platform: {
        productionEnvironment,
        supabaseRequired: productionEnvironment,
        supabaseProjectPinRequired: productionEnvironment,
        railwayRevisionRequired: productionEnvironment,
        safeModeRequired: productionEnvironment,
        writeSafetyReady: productionWriteSafetyReady,
        ready: false,
      },
      configuration: {
        ...configuration,
        safeMode,
      },
      rollout: {
        recentAuditWindow: 0,
        latestDryRun: null,
        latestDryRunAgeMinutes: null,
        latestDryRunMaxAgeMinutes: canaryDryRunMaxAge,
        latestDryRunExpired: false,
        latestDryRunCanaryReady: false,
        latestCanary: null,
      },
      error: "Database readiness check failed",
      checkedAt: new Date().toISOString(),
    });
  }
});

export default router;
