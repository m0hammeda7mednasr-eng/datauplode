import { startFirstFiveSheetsReconcile } from "./firstFiveSheetsReconcile.js";

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

export function startOneTimeSheet1Reconcile(port: number) {
  if (!isolatedFirstFiveWorkerEnabled()) {
    console.log(
      "[first5-reconcile] isolated worker blocked: requires Railway production branch stabilize-supabase-railway, runtime write gate, explicit first-five gate, and an exact authorized deployed revision",
    );
    return;
  }

  console.warn(
    "[first5-reconcile] isolated existing-products-only worker ENABLED on explicitly authorized Railway production revision",
  );
  startFirstFiveSheetsReconcile(port);
}