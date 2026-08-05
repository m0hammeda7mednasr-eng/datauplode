type JsonRecord = Record<string, unknown>;

const baseUrl = String(process.env.SMOKE_BASE_URL || process.argv[2] || "")
  .trim()
  .replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);
const runCatalogDryRun = process.env.SMOKE_SKIP_CATALOG_DRY_RUN !== "true";
const requireSafeMode = process.env.SMOKE_REQUIRE_SAFE_MODE !== "false";

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

  const readinessDatabase = asRecord(readiness.body.database);
  if (readinessDatabase.ok !== true) {
    throw new Error(`readiness database did not report ok=true: ${JSON.stringify(readinessDatabase)}`);
  }

  const configuration = asRecord(readiness.body.configuration);
  if (requireSafeMode && configuration.safeMode !== true) {
    throw new Error(
      "Production smoke requires safeMode=true before canary. Set SMOKE_REQUIRE_SAFE_MODE=false only for an explicitly approved canary check.",
    );
  }

  const jobs = asRecord(readiness.body.jobs);
  const report: JsonRecord = {
    baseUrl,
    healthStatus: health.response.status,
    readinessStatus: readiness.response.status,
    database: health.body.database,
    databaseTarget: readinessDatabase.target ?? "unknown",
    safeMode: configuration.safeMode ?? "unknown",
    jobs: {
      pending: jobs.pending ?? 0,
      running: jobs.running ?? 0,
      failed: jobs.failed ?? 0,
    },
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
