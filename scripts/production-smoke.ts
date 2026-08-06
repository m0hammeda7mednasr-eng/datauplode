type JsonRecord = Record<string, unknown>;

const baseUrl = String(process.env.SMOKE_BASE_URL || process.argv[2] || "")
  .trim()
  .replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);
const runCatalogDryRun = process.env.SMOKE_SKIP_CATALOG_DRY_RUN !== "true";
const requireSafeMode = process.env.SMOKE_REQUIRE_SAFE_MODE !== "false";
const expectedRevision = String(process.env.SMOKE_EXPECTED_REVISION || "").trim();

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  console.error("Usage: SMOKE_BASE_URL=https://your-service.up.railway.app npm run smoke:production");
  process.exit(2);
}

async function requestJson(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    });
    const text = await response.text();
    let body: JsonRecord = {};
    try {
      body = text ? (JSON.parse(text) as JsonRecord) : {};
    } catch {
      throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function requireSuccess(label: string, status: number, body: JsonRecord) {
  if (status < 200 || status >= 300) {
    throw new Error(`${label} failed with HTTP ${status}: ${JSON.stringify(body).slice(0, 1000)}`);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function requireDisabled(configuration: JsonRecord, key: string) {
  if (configuration[key] !== false) {
    throw new Error(`Production smoke requires configuration.${key}=false, received ${String(configuration[key])}`);
  }
}

function assertBlockedSourcesAreNotOutOfStock(value: unknown, path = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBlockedSourcesAreNotOutOfStock(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as JsonRecord;
  const normalized = JSON.stringify(record).toLowerCase();
  const contains403 = /(?:http|status|code)[^}]{0,40}403|\b403\b/.test(normalized);
  const claimsOutOfStock = /out[-_ ]?of[-_ ]?stock|sold[-_ ]?out/.test(normalized);

  if (contains403 && claimsOutOfStock) {
    throw new Error(
      `Unsafe source classification at ${path}: HTTP 403 must remain blocked/unknown, never out-of-stock.`,
    );
  }

  for (const [key, child] of Object.entries(record)) {
    assertBlockedSourcesAreNotOutOfStock(child, `${path}.${key}`);
  }
}

function verifyDeploymentRevision(readiness: JsonRecord) {
  const deployment = asRecord(readiness.deployment);
  const deployedRevision = String(deployment.revision || "").trim();

  if (!expectedRevision) {
    return deployedRevision || "unknown";
  }

  if (!/^[0-9a-f]{7,40}$/i.test(expectedRevision)) {
    throw new Error(`SMOKE_EXPECTED_REVISION is not a valid Git SHA: ${expectedRevision}`);
  }
  if (deployment.revisionVerified !== true || !/^[0-9a-f]{7,40}$/i.test(deployedRevision)) {
    throw new Error(
      `Railway readiness did not expose a verified deployment revision; expected ${expectedRevision}`,
    );
  }

  const matches =
    deployedRevision.toLowerCase().startsWith(expectedRevision.toLowerCase()) ||
    expectedRevision.toLowerCase().startsWith(deployedRevision.toLowerCase());
  if (!matches) {
    throw new Error(
      `Stale or wrong Railway deployment: expected revision ${expectedRevision}, received ${deployedRevision}`,
    );
  }

  return deployedRevision;
}

async function main() {
  const startedAt = Date.now();

  const health = await requestJson("/health");
  requireSuccess("health", health.response.status, health.body);
  if (health.body.database !== "ok") {
    throw new Error(`health database is not ok: ${JSON.stringify(health.body)}`);
  }

  const readiness = await requestJson("/api/ready");
  requireSuccess("readiness", readiness.response.status, readiness.body);
  if (readiness.body.ok !== true) {
    throw new Error(`readiness did not report ok=true: ${JSON.stringify(readiness.body).slice(0, 1000)}`);
  }

  const deployedRevision = verifyDeploymentRevision(readiness.body);
  const readinessDatabase = asRecord(readiness.body.database);
  if (readinessDatabase.ok !== true) {
    throw new Error(`readiness database did not report ok=true: ${JSON.stringify(readinessDatabase)}`);
  }

  const configuration = asRecord(readiness.body.configuration);
  if (requireSafeMode) {
    if (configuration.safeMode !== true) {
      throw new Error(
        "Production smoke requires safeMode=true before canary. Set SMOKE_REQUIRE_SAFE_MODE=false only for an explicitly approved canary check.",
      );
    }

    requireDisabled(configuration, "runtimeWriteGateEnabled");
    requireDisabled(configuration, "inventoryAutostartEnabled");
    requireDisabled(configuration, "jobRecoveryEnabled");
    requireDisabled(configuration, "sheetImportAutostartEnabled");
    requireDisabled(configuration, "catalogWriteGateEnabled");
    requireDisabled(configuration, "catalogSheetWriteGateEnabled");

    if (Number(configuration.catalogCanaryMaxRows) !== 1) {
      throw new Error(
        `Production smoke requires catalogCanaryMaxRows=1, received ${String(configuration.catalogCanaryMaxRows)}`,
      );
    }
  }

  const jobs = asRecord(readiness.body.jobs);
  const runningJobs = Number(jobs.running ?? 0);
  const staleRunningJobs = Number(jobs.staleRunning ?? Number.NaN);
  const staleThresholdMinutes = Number(jobs.staleThresholdMinutes ?? Number.NaN);
  const recentFailedJobs = Number(jobs.recentFailed ?? Number.NaN);
  const recentFailureThresholdMinutes = Number(jobs.recentFailureThresholdMinutes ?? Number.NaN);
  if (requireSafeMode && (!Number.isFinite(runningJobs) || runningJobs !== 0)) {
    throw new Error(`Production smoke requires zero running jobs in safe mode, received ${String(jobs.running)}`);
  }
  if (!Number.isFinite(staleRunningJobs) || staleRunningJobs !== 0) {
    throw new Error(
      `Production smoke requires jobs.staleRunning=0, received ${String(jobs.staleRunning)}. Recover or inspect stuck jobs before canary.`,
    );
  }
  if (!Number.isFinite(staleThresholdMinutes) || staleThresholdMinutes < 5 || staleThresholdMinutes > 1440) {
    throw new Error(
      `Readiness returned an invalid stale job threshold: ${String(jobs.staleThresholdMinutes)}`,
    );
  }
  if (!Number.isFinite(recentFailedJobs) || recentFailedJobs !== 0) {
    throw new Error(
      `Production smoke requires jobs.recentFailed=0, received ${String(jobs.recentFailed)}. Inspect failed jobs before canary.`,
    );
  }
  if (
    !Number.isFinite(recentFailureThresholdMinutes) ||
    recentFailureThresholdMinutes < 5 ||
    recentFailureThresholdMinutes > 10080
  ) {
    throw new Error(
      `Readiness returned an invalid recent failure threshold: ${String(jobs.recentFailureThresholdMinutes)}`,
    );
  }

  const report: JsonRecord = {
    baseUrl,
    expectedRevision: expectedRevision || "not-enforced",
    deployedRevision,
    healthStatus: health.response.status,
    readinessStatus: readiness.response.status,
    database: health.body.database,
    databaseTarget: readinessDatabase.target ?? "unknown",
    safeMode: configuration.safeMode ?? "unknown",
    writeGates: {
      runtime: configuration.runtimeWriteGateEnabled ?? "unknown",
      catalog: configuration.catalogWriteGateEnabled ?? "unknown",
      sheet: configuration.catalogSheetWriteGateEnabled ?? "unknown",
      inventoryAutostart: configuration.inventoryAutostartEnabled ?? "unknown",
      jobRecovery: configuration.jobRecoveryEnabled ?? "unknown",
      sheetImportAutostart: configuration.sheetImportAutostartEnabled ?? "unknown",
      canaryMaxRows: configuration.catalogCanaryMaxRows ?? "unknown",
    },
    jobs: {
      pending: jobs.pending ?? 0,
      running: jobs.running ?? 0,
      staleRunning: jobs.staleRunning ?? "unknown",
      staleThresholdMinutes: jobs.staleThresholdMinutes ?? "unknown",
      failed: jobs.failed ?? 0,
      recentFailed: jobs.recentFailed ?? "unknown",
      recentFailureThresholdMinutes: jobs.recentFailureThresholdMinutes ?? "unknown",
    },
    sourceClassificationSafety: "not-checked",
    catalogDryRun: "skipped",
  };

  if (runCatalogDryRun) {
    const dryRun = await requestJson("/api/catalog-audit/run", {
      method: "POST",
      body: JSON.stringify({
        dryRun: true,
        writeSheet: false,
        offset: 0,
        maxRows: 1,
      }),
    });
    requireSuccess("catalog dry run", dryRun.response.status, dryRun.body);

    const summary = asRecord(dryRun.body.summary);
    if (summary.dryRun !== true || summary.writeSheet !== false) {
      throw new Error(
        `Unsafe catalog response: expected dryRun=true and writeSheet=false, received ${JSON.stringify(summary)}`,
      );
    }

    const processed = Number(summary.uniqueProductsProcessed ?? 0);
    if (!Number.isFinite(processed) || processed < 0 || processed > 1) {
      throw new Error(`Dry run exceeded the one-product smoke limit: ${processed}`);
    }

    assertBlockedSourcesAreNotOutOfStock(dryRun.body, "catalogDryRun");
    report.sourceClassificationSafety = "verified";
    report.catalogDryRun = {
      status: dryRun.response.status,
      uniqueProductsProcessed: processed,
      verified: summary.verified ?? 0,
      missing: summary.missing ?? 0,
      ambiguous: summary.ambiguous ?? 0,
      errors: summary.errors ?? 0,
      dryRun: summary.dryRun,
      writeSheet: summary.writeSheet,
    };
  }

  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("Production smoke check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
