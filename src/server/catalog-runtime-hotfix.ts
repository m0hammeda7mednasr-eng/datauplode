import { prisma } from "./db.js";
import { ShopifyGraphqlClient } from "./services/shopify.js";

const originalRequest = ShopifyGraphqlClient.prototype.request;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCatalogLinkQuery(query: string) {
  return query.includes("query SyncEngineCatalogLink") || query.includes("query SyncEngineCatalogIndex");
}

function makeCatalogLinkQuerySafe(query: string) {
  if (!isCatalogLinkQuery(query)) return query;

  // Keep the outer Shopify product page size unchanged so the full catalog can
  // still be traversed. Only cap legacy oversized nested variant connections.
  return query.replace(/variants\(first:\s*250\)/g, "variants(first: 15)");
}

function retryableShopifyError(error: any) {
  const status = Number(error?.response?.status || 0);
  const message = String(error?.message || "");
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /throttl|rate\s*limit|temporar|timeout|socket hang up|econnreset/i.test(message)
  );
}

ShopifyGraphqlClient.prototype.request = (async function patchedShopifyRequest<T = any>(
  this: ShopifyGraphqlClient,
  query: string,
  variables: any = {},
): Promise<T> {
  const patchedQuery = makeCatalogLinkQuerySafe(query);
  const maxAttempts = isCatalogLinkQuery(query) ? 8 : 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await originalRequest.call(this, patchedQuery, variables) as T;
    } catch (error: any) {
      if (!retryableShopifyError(error) || attempt >= maxAttempts) throw error;

      const retryAfterSeconds = Number(error?.response?.headers?.["retry-after"] || 0);
      const exponentialMs = Math.min(15_000, 750 * (2 ** (attempt - 1)));
      const retryAfterMs = retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds * 1000) : 0;
      const waitMs = Math.max(750, exponentialMs, retryAfterMs);

      console.warn(
        `[shopify-hotfix] transient Shopify failure; retrying in ${waitMs}ms ` +
        `(attempt ${attempt}/${maxAttempts}): ${String(error?.message || error)}`,
      );
      await sleep(waitMs);
    }
  }

  throw new Error("Shopify request exhausted automatic retries");
}) as typeof ShopifyGraphqlClient.prototype.request;

// The catalog route stores SyncJob.result as JSON, but its read path converts
// that JSON into an object before running the stale-job check. The stale helper
// then cannot see result.lastPageAt and falls back to startedAt, which used to
// make every healthy long scan look stale after five minutes. Keep startedAt as
// a durable heartbeat whenever a catalog page writes a fresh lastPageAt. This
// fixes the production worker without changing catalog ownership or Shopify data.
const syncJobDelegate = prisma.syncJob as any;
const originalSyncJobUpdate = syncJobDelegate.update.bind(syncJobDelegate);
syncJobDelegate.update = async function patchedSyncJobUpdate(args: any) {
  let nextArgs = args;
  const data = args?.data;
  if (data && data.status == null && typeof data.result === "string") {
    try {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === "object" && parsed.lastPageAt) {
        nextArgs = {
          ...args,
          data: {
            ...data,
            startedAt: new Date(),
          },
        };
      }
    } catch {
      // Preserve the original Prisma call if result is not valid JSON.
    }
  }
  return originalSyncJobUpdate(nextArgs);
};

console.log("[shopify-hotfix] catalog retry + durable heartbeat patch active");
