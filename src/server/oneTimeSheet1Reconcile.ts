import { startFirstFiveSheetsReconcile } from "./firstFiveSheetsReconcile.js";

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

export function startOneTimeSheet1Reconcile(port: number) {
  if (!firstFiveReconcileWritesEnabled()) {
    console.log(
      "[first5-reconcile] blocked: runtime gate, dedicated gate, and an exact SYNC_FIRST5_RECONCILE_REVISION matching the deployed 40-char revision are required after CI, dry run, canary, and read-back succeed",
    );
    return;
  }

  console.warn(
    "[first5-reconcile] explicit broad existing-product reconcile gate ENABLED for the exact deployed revision",
  );
  startFirstFiveSheetsReconcile(port);
}
