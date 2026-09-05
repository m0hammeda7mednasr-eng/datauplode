import "dotenv/config";
import { prisma } from "../src/server/db.js";

async function main() {
  const jobs = await prisma.syncJob.findMany({
    where: { type: "SYNC_FULL_CATALOG_BATCH" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      result: job.result ? JSON.parse(job.result) : null,
    })),
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
