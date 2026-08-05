type JsonRecord = Record<string, unknown>;

const baseUrl = String(process.env.SMOKE_BASE_URL || process.argv[2] || "")
  .trim()
  .replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);
const runCatalogDryRun = process.env.SMOKE_SKIP_CATALOG_DRY_RUN !== "true";

if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
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

async function main() {
  const startedAt = Date.now();

  const health = await requestJson("/health");
  requireSuccess("health", health.response.status, health.body);
  if (health.body.database !== "ok") {
    throw new Error(`health database is not ok: ${JSON.stringify(health.body)}`);
  }

  const readiness = await requestJson("/api/ready");
  requireSuccess("readiness", readiness.response.status, readiness.body);

  const report: JsonRecord = {
    baseUrl,
    healthStatus: health.response.status,
    readinessStatus: readiness.response.status,
    database: health.body.database,
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

    const summary = (dryRun.body.summary || {}) as JsonRecord;
    if (summary.dryRun !== true || summary.writeSheet !== false) {
      throw new Error(
        `Unsafe catalog response: expected dryRun=true and writeSheet=false, received ${JSON.stringify(summary)}`,
      );
    }

    report.catalogDryRun = {
      status: dryRun.response.status,
      uniqueProductsProcessed: summary.uniqueProductsProcessed ?? 0,
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
