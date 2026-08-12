import { prisma } from "./db.js";

const MARKER_TYPE = "ONE_TIME_SHEET1_RECONCILE:2026-08-09-sheet1-reconcile-v1";
const CATALOG_MARKER_TYPE =
  "SHEET1_CATALOG_AUTO_SYNC:2026-08-09-v5-first-eight-5000-key-pool";
const CATALOG_TAKEOVER_GRACE_MS = 45_000;
const CATALOG_TAKEOVER_SWEEP_COUNT = 4;

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

function catalogRevisionAuthorized() {
  const expected = String(process.env.SYNC_SHEET1_CATALOG_REVISION || "").trim();
  const actual = deployedRevision();
  return (
    /^[0-9a-f]{40}$/i.test(expected) &&
    /^[0-9a-f]{40}$/i.test(actual) &&
    expected.toLowerCase() === actual.toLowerCase()
  );
}

function productionRailwayBranch() {
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
  return nodeEnv === "production" && isRailway && branch === "stabilize-supabase-railway";
}

function isolatedFirstFiveWorkerEnabled() {
  return (
    productionRailwayBranch() &&
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_FIRST5_RECONCILE_ENABLED") &&
    !enabled("SYNC_FIRST5_RECONCILE_DISABLED") &&
    revisionAuthorized()
  );
}

function catalogWorkerEnabledForCurrentRevision() {
  return (
    productionRailwayBranch() &&
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_POST_CANARY_BROAD_WRITES_ENABLED") &&
    enabled("SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED") &&
    !enabled("SYNC_SHEET1_CATALOG_AUTOSTART_DISABLED") &&
    catalogRevisionAuthorized()
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelOrphanedCatalogMarkersOnce(sweep: number) {
  if (!productionRailwayBranch() || catalogWorkerEnabledForCurrentRevision()) {
    return 0;
  }

  const cutoff = new Date(Date.now() - CATALOG_TAKEOVER_GRACE_MS);
  const orphaned = await prisma.syncJob.findMany({
    where: {
      type: CATALOG_MARKER_TYPE,
      status: { in: ["running", "pending"] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  if (!orphaned.length) return 0;

  const takeoverAt = new Date();
  for (const job of orphaned) {
    const previous = readResult(job.result);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "cancelled",
        completedAt: takeoverAt,
        result: JSON.stringify({
          ...previous,
          stage: "deployment_takeover_cancelled",
          interruptedByRedeploy: true,
          replayed: false,
          takeoverAt: takeoverAt.toISOString(),
          takeoverSweep: sweep,
          note: "Superseded Sheet1 catalog marker cancelled by bounded Railway takeover sweep while the current revision is not authorized to autostart the catalog worker. No Shopify or Google Sheet action was replayed.",
        }),
      },
    });
  }

  console.warn(
    `[sheet1-catalog] takeover sweep ${sweep}/${CATALOG_TAKEOVER_SWEEP_COUNT} cancelled ${orphaned.length} orphaned marker(s); replay=false`,
  );
  return orphaned.length;
}

function scheduleOrphanedCatalogMarkerSweeps() {
  if (!productionRailwayBranch() || catalogWorkerEnabledForCurrentRevision()) {
    return;
  }

  // Railway can overlap old/new revisions for longer than one grace window.
  // Run a small bounded series of status-only sweeps so a marker created late
  // by the superseded process cannot keep readiness stale indefinitely. The
  // sweeps never replay work and never call Shopify or Google Sheets.
  void (async () => {
    for (let sweep = 1; sweep <= CATALOG_TAKEOVER_SWEEP_COUNT; sweep += 1) {
      await sleep(CATALOG_TAKEOVER_GRACE_MS);
      if (catalogWorkerEnabledForCurrentRevision()) return;
      await cancelOrphanedCatalogMarkersOnce(sweep);
    }
  })().catch((error) => {
    console.error("[sheet1-catalog] bounded takeover sweep failed", error);
  });
}

export async function prepareSheet1ReconcileDeploymentTakeover() {
  scheduleOrphanedCatalogMarkerSweeps();

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
