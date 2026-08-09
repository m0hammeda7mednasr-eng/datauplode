import { startFirstFiveSheetsReconcile } from "./firstFiveSheetsReconcile.js";

function enabled(name: string) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function firstFiveReconcileWritesEnabled() {
  return (
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_FIRST5_RECONCILE_ENABLED")
  );
}

export function startOneTimeSheet1Reconcile(port: number) {
  if (!firstFiveReconcileWritesEnabled()) {
    console.log(
      "[first5-reconcile] blocked: SYNC_RUNTIME_WRITE_ENABLED=true and SYNC_FIRST5_RECONCILE_ENABLED=true are both required after CI, dry run, canary, and read-back succeed",
    );
    return;
  }

  console.warn(
    "[first5-reconcile] explicit broad existing-product reconcile gate ENABLED",
  );
  startFirstFiveSheetsReconcile(port);
}
