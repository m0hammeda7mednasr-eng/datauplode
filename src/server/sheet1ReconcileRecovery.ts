import { prisma } from "./db.js";

const MARKER_TYPE = "ONE_TIME_SHEET1_RECONCILE:2026-08-09-sheet1-reconcile-v1";

function enabled(name: string) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function normalizedRevision(value: string | undefined) {
  const revision = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(revision) ? revision : "";
}

function deployedRevision() {
  return normalizedRevision(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GIT_COMMIT_SHA,
  );
}

function firstFiveReconcileWritesEnabled() {
  const deployed = deployedRevision();
  const authorized = normalizedRevision(process.env.SYNC_FIRST5_RECONCILE_REVISION);
  return (
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_FIRST5_RECONCILE_ENABLED") &&
    Boolean(deployed) &&
    Boolean(authorized) &&
    deployed === authorized
  );
}

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
  if (!firstFiveReconcileWritesEnabled()) {
    console.log(
      "[sheet1-reconcile] deployment takeover blocked unless broad reconcile gates are open and SYNC_FIRST5_RECONCILE_REVISION exactly matches the deployed revision",
    );
    return;
  }

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
          note: "A newer Railway process took ownership. The next explicitly revision-authorized run resumes from a fresh Sheet snapshot and idempotent Shopify read-back.",
        }),
      },
    });
  }

  console.warn(
    `[sheet1-reconcile] marked ${running.length} interrupted running marker(s) for safe deployment takeover on the explicitly authorized revision`,
  );
}
