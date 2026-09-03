import { ShopifyGraphqlClient } from "./services/shopify.js";

const originalRequest = ShopifyGraphqlClient.prototype.request;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCatalogLinkQuery(query: string) {
  return query.includes("query SyncEngineCatalogLink");
}

function makeCatalogLinkQuerySafe(query: string) {
  if (!isCatalogLinkQuery(query)) return query;

  return query
    .replace(
      /products\(first:\s*50,\s*after:\s*\$after,\s*sortKey:\s*ID\)/,
      "products(first: 10, after: $after, sortKey: ID)",
    )
    .replace(/variants\(first:\s*250\)/g, "variants(first: 50)");
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

console.log("[shopify-hotfix] catalog query safety + retry patch active");
