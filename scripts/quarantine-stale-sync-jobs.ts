import { prisma } from "../src/server/db.js";

const APPLY = String(process.env.SYNC_JOB_QUARANTINE_APPLY || "").trim().toLowerCase() === "true";
const CONFIRM = String(process.env.SYNC_JOB_QUARANTINE_CONFIRM || "").trim();
const REQUIRED_CONFIRM = "QUARANTINE_STALE_RUNNING_NO_REPLAY";
const STALE_MINUTES = Math.max(
  10,
  Math.min(1440, Number(process.env.SYNC_JOB_STALE_RUNNING_MINUTES || 10) || 10),
);
const MAX_ROWS = Math.max(
  1,
  Math.min(20, Number(process.env.SYNC_JOB_QUARANTINE_MAX_ROWS || 10) || 10),
);

function allowedType(type: string) {
  return (
    type === "PUBLISH_TO_SHOPIFY" ||
    type.startsWith("SHEET1_CATALOG_AUTO_SYNC:")
  );
}

async function main() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000);
  const candidates = await prisma.syncJob.findMany({
    where: {
      status: "running",
      OR: [{ startedAt: null }, { startedAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ROWS + 1,
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (candidates.length > MAX_ROWS) {
    throw new Error(`Refusing quarantine: more than ${MAX_ROWS} stale running jobs matched`);
  }

  const unsupported = candidates.filter((job) => !allowedType(job.type));
  if (unsupported.length > 0) {
    throw new Error(
      `Refusing quarantine: unsupported stale job types: ${[
        ...new Set(unsupported.map((job) => job.type)),
      ].join(", ")}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        staleMinutes: STALE_MINUTES,
        maxRows: MAX_ROWS,
        count: candidates.length,
        candidates,
      },
      null,
      2,
    ),
  );

  if (!APPLY) return;
  if (CONFIRM !== REQUIRED_CONFIRM) {
    throw new Error(
      `Refusing apply: set SYNC_JOB_QUARANTINE_CONFIRM=${REQUIRED_CONFIRM}`,
    );
  }

  const ids = candidates.map((job) => job.id);
  if (ids.length === 0) return;

  const resultMarker = JSON.stringify({
    quarantined: true,
    reason: "stale_running_no_replay",
    source: "scripts/quarantine-stale-sync-jobs.ts",
  });

  const result = await prisma.syncJob.updateMany({
    where: {
      id: { in: ids },
      status: "running",
      OR: [{ startedAt: null }, { startedAt: { lt: cutoff } }],
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      result: resultMarker,
    },
  });

  if (result.count !== ids.length) {
    throw new Error(
      `Quarantine race detected: expected ${ids.length} updates, applied ${result.count}`,
    );
  }

  const readBack = await prisma.syncJob.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      type: true,
      status: true,
      startedAt: true,
      completedAt: true,
      result: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const invalid = readBack.filter(
    (job) =>
      job.status !== "failed" ||
      !job.completedAt ||
      !String(job.result || "").includes('"quarantined":true'),
  );
  if (invalid.length > 0) {
    throw new Error(`Quarantine read-back failed for ${invalid.length} rows`);
  }

  console.log(
    JSON.stringify(
      {
        applied: result.count,
        readBackVerified: readBack.length,
        jobs: readBack.map(({ result: _result, ...job }) => job),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
