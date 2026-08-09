import { prisma } from "./db.js";

const MARKER_TYPE = "ONE_TIME_SHEET1_RECONCILE:2026-08-09-sheet1-reconcile-v1";

function enabled(name: string) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function deployedRevision() {
  return String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GIT_COMMIT_SHA ||
      "",
  )
    .trim()
    .toLowerCase();
}

function isolatedFirstFiveWorkerEnabled() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isRailway = Boolean(
    String(process.env.RAILWAY_ENVIRONMENT || "").trim() ||
      String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim(),
  );
  const branch = String(
    process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "",
  )
    .trim()
    .replace(/^refs\/heads\//, "");
  const revision = deployedRevision();
  const authorizedRevision = String(
    process.env.SYNC_FIRST5_RECONCILE_REVISION || "",
  )
    .trim()
    .toLowerCase();
  const revisionAuthorized =
    /^[0-9a-f]{40}$/.test(revision) &&
    /^[0-9a-f]{40}$/.test(authorizedRevision) &&
    revision === authorizedRevision;

  return (
    nodeEnv === "production" &&
    isRailway &&
    branch === "stabilize-supabase-railway" &&
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_FIRST5_RECONCILE_ENABLED") &&
    revisionAuthorized &&
    !enabled("SYNC_FIRST5_RECONCILE_DISABLED")
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
  if (!isolatedFirstFiveWorkerEnabled()) {
    console.log(
      "[sheet1-reconcile] deployment takeover skipped: requires Railway production branch, runtime write gate, explicit first-five gate, and exact authorized deployed revision",
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
          note: "A newer explicitly authorized Railway production process took ownership. Resume only from verified row ledger and Shopify read-back.",
        }),
      },
    });
  }

  console.warn(
    `[sheet1-reconcile] marked ${running.length} interrupted running marker(s) for explicitly authorized first-five deployment takeover`,
  );
}