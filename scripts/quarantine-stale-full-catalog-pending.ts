import "dotenv/config";
import { prisma } from "../src/server/db.js";

const APPLY = process.env.FULL_CATALOG_PENDING_QUARANTINE_APPLY === "true";
const REQUIRED_CONFIRM = "QUARANTINE_STALE_FULL_CATALOG_PENDING";
const cutoff = new Date(Date.now() - 3 * 60_000);

async function main() {
  const candidates = await prisma.syncJob.findMany({
    where: {
      type: "SYNC_FULL_CATALOG_BATCH",
      status: "pending",
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: 21,
    select: { id: true, type: true, status: true, createdAt: true },
  });

  if (candidates.length > 20) {
    throw new Error("Refusing quarantine: more than 20 stale full-catalog pending jobs matched");
  }
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", cutoff, candidates }, null, 2));
  if (!APPLY || candidates.length === 0) return;
  if (process.env.FULL_CATALOG_PENDING_QUARANTINE_CONFIRM !== REQUIRED_CONFIRM) {
    throw new Error(`Refusing apply: set FULL_CATALOG_PENDING_QUARANTINE_CONFIRM=${REQUIRED_CONFIRM}`);
  }

  const ids = candidates.map((candidate) => candidate.id);
  const marker = JSON.stringify({
    quarantined: true,
    reason: "stale_deployment_handoff_no_replay",
    source: "scripts/quarantine-stale-full-catalog-pending.ts",
  });
  const updated = await prisma.syncJob.updateMany({
    where: {
      id: { in: ids },
      type: "SYNC_FULL_CATALOG_BATCH",
      status: "pending",
      createdAt: { lt: cutoff },
    },
    data: { status: "failed", completedAt: new Date(), result: marker },
  });
  if (updated.count !== ids.length) throw new Error(`Quarantine race detected: applied ${updated.count}`);

  const readBack = await prisma.syncJob.findMany({ where: { id: { in: ids } } });
  const invalid = readBack.filter((job) => job.status !== "failed" || !job.completedAt || !job.result?.includes('"quarantined":true'));
  if (invalid.length > 0 || readBack.length !== ids.length) {
    throw new Error(`Quarantine read-back failed for ${invalid.length} jobs`);
  }
  console.log(JSON.stringify({ applied: updated.count, readBackVerified: readBack.length, ids }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
