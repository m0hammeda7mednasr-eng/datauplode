import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const baseUrl = String(process.env.SMOKE_BASE_URL || "").trim().replace(/\/$/, "");
const expectedRevision = String(process.env.SMOKE_EXPECTED_REVISION || "").trim();
const logPath = String(process.argv[2] || "production-smoke.log").trim();
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  throw new Error("SMOKE_BASE_URL must be an HTTPS Railway URL.");
}
if (!/^[0-9a-f]{40}$/i.test(expectedRevision)) {
  throw new Error("SMOKE_EXPECTED_REVISION must be a full 40-character Git SHA.");
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readDryRunBatchId() {
  const log = readFileSync(logPath, "utf8");
  const matches = [...log.matchAll(/"batchId"\s*:\s*"([^"]+)"/g)];
  const batchId = String(matches.at(-1)?.[1] || "").trim();
  if (!batchId) {
    throw new Error(`Production smoke log ${logPath} did not expose a dry-run batchId.`);
  }
  return batchId;
}

async function getReadiness() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/ready`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: JsonRecord = {};
    try {
      body = text ? (JSON.parse(text) as JsonRecord) : {};
    } catch {
      throw new Error(`/api/ready returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok || body.ok !== true) {
      throw new Error(`Post-dry-run readiness failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const dryRunBatchId = readDryRunBatchId();
  const readiness = await getReadiness();

  const deployment = asRecord(readiness.deployment);
  const deployedRevision = String(deployment.revision || "").trim();
  if (deployment.revisionVerified !== true || !/^[0-9a-f]{40}$/i.test(deployedRevision)) {
    throw new Error("Post-dry-run readiness did not expose a verified full deployment revision.");
  }
  if (deployedRevision.toLowerCase() !== expectedRevision.toLowerCase()) {
    throw new Error(
      `Railway revision changed during dry run: expected ${expectedRevision}, received ${deployedRevision}.`,
    );
  }

  const database = asRecord(readiness.database);
  if (database.ok !== true || database.target !== "supabase") {
    throw new Error(
      `Post-dry-run read-back requires Supabase readiness; ok=${String(database.ok)}, target=${String(database.target)}.`,
    );
  }

  const rollout = asRecord(readiness.rollout);
  const latestDryRun = asRecord(rollout.latestDryRun);
  const persistedBatchId = String(latestDryRun.id || "").trim();
  if (!persistedBatchId || persistedBatchId !== dryRunBatchId) {
    throw new Error(
      `Dry-run persistence read-back mismatch: smoke batch=${dryRunBatchId}, readiness latestDryRun=${persistedBatchId || "missing"}.`,
    );
  }
  if (rollout.latestDryRunCanaryReady !== true) {
    throw new Error("Persisted dry run is not canary-ready according to live readiness.");
  }
  if (rollout.latestDryRunExpired !== false) {
    throw new Error("Persisted dry run is already expired according to live readiness.");
  }

  const ageMinutes = Number(rollout.latestDryRunAgeMinutes ?? Number.NaN);
  const maxAgeMinutes = Number(rollout.latestDryRunMaxAgeMinutes ?? Number.NaN);
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
    throw new Error(`Invalid persisted dry-run age: ${String(rollout.latestDryRunAgeMinutes)}`);
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 120) {
    throw new Error(`Invalid dry-run max age: ${String(rollout.latestDryRunMaxAgeMinutes)}`);
  }
  if (ageMinutes > maxAgeMinutes) {
    throw new Error(`Persisted dry run is stale: age=${ageMinutes}, max=${maxAgeMinutes}.`);
  }

  if (
    latestDryRun.status !== "COMPLETED" ||
    latestDryRun.dryRun !== true ||
    latestDryRun.writeSheet !== false ||
    Number(latestDryRun.uniqueProductsProcessed) !== 1 ||
    Number(latestDryRun.verified) !== 1 ||
    Number(latestDryRun.missing) !== 0 ||
    Number(latestDryRun.ambiguous) !== 0 ||
    Number(latestDryRun.errors) !== 0
  ) {
    throw new Error(
      `Persisted dry-run evidence is not clean enough for canary: ${JSON.stringify(latestDryRun)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRunBatchId,
        deployedRevision,
        databaseTarget: database.target,
        persisted: true,
        canaryReady: true,
        ageMinutes,
        maxAgeMinutes,
        shopifyWrites: 0,
        sheetWrites: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    "Production dry-run persistence read-back failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
