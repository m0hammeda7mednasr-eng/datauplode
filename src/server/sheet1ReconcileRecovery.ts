import { prisma } from "./db.js";

const MARKER_TYPE = "ONE_TIME_SHEET1_RECONCILE:2026-08-09-sheet1-reconcile-v1";

function readResult(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { raw: String(value).slice(0, 5000) };
  }
}

export async function prepareSheet1ReconcileDeploymentTakeover() {
  const running = await prisma.syncJob.findMany({
    where: {
      type: MARKER_TYPE,
      status: "running",
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (!running.length) return;

  const takeoverAt = new Date();
  for (const job of running) {
    const previous = readResult(job.result);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        completedAt: takeoverAt,
        result: JSON.stringify({
          ...previous,
          stage: "deployment_takeover",
          interruptedByRedeploy: true,
          takeoverAt: takeoverAt.toISOString(),
          note: "A newer Railway process took ownership. The next startup run resumes from a fresh Sheet snapshot and idempotent Shopify read-back.",
        }),
      },
    });
  }

  console.warn(
    `[sheet1-reconcile] marked ${running.length} interrupted running marker(s) for safe deployment takeover`,
  );
}
