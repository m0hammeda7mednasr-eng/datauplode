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
  ).trim();
}

function revisionAuthorized() {
  const expected = String(process.env.SYNC_FIRST5_RECONCILE_REVISION || "").trim();
  const actual = deployedRevision();
  return (
    /^[0-9a-f]{40}$/i.test(expected) &&
    /^[0-9a-f]{40}$/i.test(actual) &&
    expected.toLowerCase() === actual.toLowerCase()
  );
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

  return (
    nodeEnv === "production" &&
    isRailway &&
    branch === "stabilize-supabase-railway" &&
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_FIRST5_RECONCILE_ENABLED") &&
    !enabled("SYNC_FIRST5_RECONCILE_DISABLED") &&
    revisionAuthorized()
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
      "[sheet1-reconcile] deployment takeover skipped: requires global runtime write authorization, dedicated first-five authorization, and exact deployed revision pin on the Railway production branch",
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
          note: "A newer explicitly authorized Railway production revision took ownership. The isolated first-five worker resumes from the verified-row ledger and Shopify read-back.",
        }),
      },
    });
  }

  console.warn(
    `[sheet1-reconcile] marked ${running.length} interrupted running marker(s) for isolated first-five deployment takeover`,
  );
}
