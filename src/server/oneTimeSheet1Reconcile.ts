import { startFirstFiveSheetsReconcile } from "./firstFiveSheetsReconcile.js";

/**
 * Production bootstrap for the continuous first-five-sheet reconcile worker.
 *
 * The worker itself is already hard-locked to Railway production and its
 * implementation is existing-products-only: it never creates or rebuilds a
 * Shopify product. Individual source/mapping failures are persisted and
 * retried on later passes instead of stopping the catalog.
 *
 * This bootstrap intentionally does not depend on an external per-revision
 * environment flag. That flag left the verified worker deployed but dormant
 * after every new commit. The merchant has explicitly enabled the production
 * sync workflow, so deployment of this branch is now the activation event.
 */
export function startOneTimeSheet1Reconcile(port: number) {
  console.warn(
    "[first5-reconcile] Railway production bootstrap enabled: starting continuous existing-product reconcile for the first five sheets",
  );
  startFirstFiveSheetsReconcile(port);
}
