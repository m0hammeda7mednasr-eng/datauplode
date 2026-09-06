import "dotenv/config";
import { prisma } from "../src/server/db.js";

const APPLY = process.env.PRICE_STOCK_QUARANTINE_APPLY === "true";
const CONFIRM = String(process.env.PRICE_STOCK_QUARANTINE_CONFIRM || "").trim();
const REQUIRED_CONFIRM = "QUARANTINE_STALE_PRICE_STOCK_NO_REPLAY";
const STALE_MINUTES = Math.max(
  10,
  Math.min(1440, Number(process.env.PRICE_STOCK_QUARANTINE_STALE_MINUTES || 60) || 60),
);
const MAX_ROWS = Math.max(
  1,
  Math.min(1000, Number(process.env.PRICE_STOCK_QUARANTINE_MAX_ROWS || 500) || 500),
);

const allowedTypes = ["SYNC_PRICE_STOCK", "SYNC_PRICE_STOCK_BATCH", "SYNC_FULL_CATALOG_BATCH"];

async function main() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000);
  const candidates = await prisma.syncJob.findMany({
    where: {
      type: { in: allowedTypes },
      status: { in: ["pending", "running"] },
      OR: [
        { createdAt: { lt: cutoff } },
        { startedAt: { lt: cutoff } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ROWS + 1,
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
      startedAt: true,
    },
  });

  if (candidates.length > MAX_ROWS) {
    throw new Error(`Refusing quarantine: more than ${MAX_ROWS} stale jobs matched`);
  }

  const summary = candidates.reduce<Record<string, number>>((acc, job) => {
    const key = `${job.type}:${job.status}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    staleMinutes: STALE_MINUTES,
    maxRows: MAX_ROWS,
    count: candidates.length,
    summary,
  }, null, 2));

  if (!APPLY || candidates.length === 0) return;
  if (CONFIRM !== REQUIRED_CONFIRM) {
    throw new Error(`Refusing apply: set PRICE_STOCK_QUARANTINE_CONFIRM=${REQUIRED_CONFIRM}`);
  }

  const ids = candidates.map((job) => job.id);
  const marker = JSON.stringify({
    quarantined: true,
    reason: "stale_price_stock_no_replay",
    source: "scripts/quarantine-stale-price-stock-jobs.ts",
  });

  const updated = await prisma.syncJob.updateMany({
    where: {
      id: { in: ids },
      type: { in: allowedTypes },
      status: { in: ["pending", "running"] },
      OR: [
        { createdAt: { lt: cutoff } },
        { startedAt: { lt: cutoff } },
      ],
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      result: marker,
    },
  });

  if (updated.count !== ids.length) {
    throw new Error(`Quarantine race detected: expected ${ids.length}, applied ${updated.count}`);
  }

  const readBack = await prisma.syncJob.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, status: true, completedAt: true, result: true },
  });
  const invalid = readBack.filter(
    (job) =>
      job.status !== "failed" ||
      !job.completedAt ||
      !String(job.result || "").includes('"quarantined":true'),
  );
  if (invalid.length || readBack.length !== ids.length) {
    throw new Error(`Quarantine read-back failed for ${invalid.length} jobs`);
  }

  console.log(JSON.stringify({
    applied: updated.count,
    readBackVerified: readBack.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
