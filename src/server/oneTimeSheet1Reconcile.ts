import { startFirstFiveSheetsReconcile } from "./firstFiveSheetsReconcile.js";

function enabled(name: string) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
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
    !enabled("SYNC_FIRST5_RECONCILE_DISABLED")
  );
}

export function startOneTimeSheet1Reconcile(port: number) {
  if (!isolatedFirstFiveWorkerEnabled()) {
    console.log(
      "[first5-reconcile] isolated worker blocked: it only autostarts on Railway production branch stabilize-supabase-railway and can be stopped with SYNC_FIRST5_RECONCILE_DISABLED=true",
    );
    return;
  }

  console.warn(
    "[first5-reconcile] isolated existing-products-only worker ENABLED on Railway production; global runtime write gates remain independent",
  );
  startFirstFiveSheetsReconcile(port);
}
