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
    enabled("SYNC_FIRST5_RECONCILE_ENABLED") &&
    !enabled("SYNC_FIRST5_RECONCILE_DISABLED") &&
    revisionAuthorized()
  );
}

export function startOneTimeSheet1Reconcile(port: number) {
  if (!isolatedFirstFiveWorkerEnabled()) {
    console.log(
      "[first5-reconcile] isolated worker blocked: requires Railway production branch stabilize-supabase-railway, SYNC_FIRST5_RECONCILE_ENABLED=true, and exact SYNC_FIRST5_RECONCILE_REVISION matching the deployed 40-char revision; SYNC_FIRST5_RECONCILE_DISABLED=true is the emergency kill switch",
    );
    return;
  }

  console.warn(
    "[first5-reconcile] isolated existing-products-only worker ENABLED for the explicitly authorized deployed revision while global runtime writes remain independently closed",
  );
  startFirstFiveSheetsReconcile(port);
}
